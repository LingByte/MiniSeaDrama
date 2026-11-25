// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const maxTranscriptChars = 200_000

// EmitFn reports generation progress.
type EmitFn func(eventType, message string, extra map[string]any)

// WaitFn blocks at safe points when paused.
type WaitFn func()

// Generator runs plan → characters → episodes → docx.
type Generator struct {
	Client    *LLMClient
	Skill     string
	Emit      EmitFn
	BatchSize int
	Wait      WaitFn
}

var (
	codeFenceLineRE = regexp.MustCompile(`(?i)^` + "```" + `[a-zA-Z]*\s*$`)
	// 模型常写 **Episode 1** / EPISODE 1 / Episode 1 — 必须都能切开，否则只会吃到裸写的 Episode 10
	episodeHeaderRE = regexp.MustCompile(`(?im)^\s*(?:\*{0,2}\s*)?(?:Episode|EP)\s+(\d+)\s*(?:\*{0,2})?\s*$`)
	endEpisodeNumRE = regexp.MustCompile(`(?i)END OF EPISODE\s+(\d+)`)
	llmRefusalRE    = regexp.MustCompile(`(?i)I can'?t help with this request|I'?m not able to write|I cannot (?:write|create|generate)|as an AI`)
)

// Generate produces script artifacts under workdir/output.
func (g *Generator) Generate(workdir, transcript string) (map[string]any, error) {
	if g.Emit == nil {
		g.Emit = func(string, string, map[string]any) {}
	}
	if g.Wait == nil {
		g.Wait = func() {}
	}
	if g.BatchSize < 1 {
		g.BatchSize = 1 // 默认一集一调，避免批量输出再靠正则硬切
	}
	if g.BatchSize > 6 {
		g.BatchSize = 6
	}
	outputDir := filepath.Join(workdir, "output")
	episodesDir := filepath.Join(outputDir, "episodes")
	_ = os.MkdirAll(episodesDir, 0o755)

	if err := ensureTranscriptUsable(transcript); err != nil {
		return nil, err
	}

	// 策划阶段字幕过长会把输出挤爆 max_tokens，导致 JSON 被截断。
	// 关键：不能简单按字数硬切前 N 字——那样 80 集只够覆盖前 15 集，
	// LLM 根本不知道后面的集存在。策略是每集取固定篇幅，让每一集都至少出现一行。
	const perEpisodeHeadChars = 1_500
	const planMaxChars = 100_000
	planTranscript := trimTranscriptForPlanning(transcript, perEpisodeHeadChars, planMaxChars)
	totalEpisodesHint := countTranscriptEpisodes(planTranscript)

	g.Wait()
	g.Emit("log", fmt.Sprintf("正在生成全剧策划与分集大纲（字幕覆盖约 %d 集）。", totalEpisodesHint), nil)
	plan, err := g.chatJSON(BuildPlanMessages(g.Skill, planTranscript, totalEpisodesHint), "策划阶段", 24576)
	if err != nil {
		return nil, err
	}
	if err := validatePlanContent(plan); err != nil {
		return nil, err
	}
	g.Wait()
	g.Emit("log", "正在生成人物台词设定卡。", nil)
	characterPayload, err := g.chatJSON(BuildCharacterMessages(g.Skill, plan), "人物卡阶段", 8192)
	if err != nil {
		return nil, err
	}
	plan["characters"] = characterPayload["characters"]
	planPath := filepath.Join(outputDir, "plan.json")
	if err := writeJSON(planPath, plan); err != nil {
		return nil, err
	}

	var episodes []map[string]any
	if raw, ok := plan["episodes"].([]any); ok {
		for _, item := range raw {
			if m, ok := item.(map[string]any); ok {
				episodes = append(episodes, m)
			}
		}
	}
	sort.Slice(episodes, func(i, j int) bool {
		return asInt(episodes[i]["number"]) < asInt(episodes[j]["number"])
	})
	if len(episodes) == 0 {
		return nil, LLMError{"策划阶段没有产出分集大纲。"}
	}
	// LLM 常偷懒只给前几集写大纲，导致后面全部跳过。补齐缺失的集号，
	// 让后续逐集写作阶段能覆盖全部集数。缺失集只给占位大纲（number + event + hook），
	// 写剧本时 LLM 会结合衔接卡自己编。
	if totalEpisodesHint > len(episodes) {
		episodes = fillMissingEpisodeOutlines(episodes, totalEpisodesHint, g.Emit)
	}
	nameLock := lockedCharacterNames(plan)
	if len(nameLock) > 0 {
		g.Emit("log", fmt.Sprintf("人物名已锁定：%s", strings.Join(nameLock, ", ")), nil)
	}
	g.Emit("log", fmt.Sprintf("策划完成：%v，共 %d 集。", plan["title_en"], len(episodes)), map[string]any{
		"title_cn": plan["title_cn"], "title_en": plan["title_en"], "episode_count": len(episodes),
	})

	var scripts []string
	var episodeList []map[string]any
	var episodeErrors []map[string]any
	var failedIdx []int // 第 i 轮循环中，第几次循环失败
	var lastOKIdx = -1
	total := len(episodes)
	for i := 0; i < total; i++ {
		g.Wait()
		ep := episodes[i]
		n := asInt(ep["number"])
		if n < 1 {
			n = i + 1
		}
		path := filepath.Join(episodesDir, fmt.Sprintf("E%03d.md", n))

		prevFull := ""
		prevHook := ""
		if lastOKIdx >= 0 {
			prevFull = scripts[lastOKIdx]
			prevHook = planHook(episodes[lastOKIdx])
		}
		ctx := EpisodePromptContext{
			NameLock:    nameLock,
			Continuity:  buildContinuityCard(prevFull, prevHook).Format(),
			NextOutline: nextEpisodeOutline(episodes, i),
		}

		// 合格缓存直接复用；不合格缓存删掉重写
		if st, err := os.Stat(path); err == nil && st.Size() > 0 {
			data, _ := os.ReadFile(path)
			part := isolateEpisode(CleanScriptText(string(data)), n)
			if err := validateEpisodeText(part, n); err == nil {
				scripts = append(scripts, part)
				episodeList = append(episodeList, map[string]any{
					"title": fmt.Sprintf("第 %d 集", n),
					"text":  part,
				})
				lastOKIdx = i
				g.Emit("script_progress", fmt.Sprintf("第 %d 集已存在且合格，直接复用。", n), map[string]any{
					"batch": i + 1, "batches": total, "episode": n,
				})
				continue
			}
			g.Emit("log", fmt.Sprintf("第 %d 集缓存不合格（%v），重新生成。", n, err), nil)
			_ = os.Remove(path)
		}

		g.Emit("script_progress", fmt.Sprintf("正在写第 %d 集（%d/%d）。", n, i+1, total), map[string]any{
			"batch": i + 1, "batches": total, "episode": n,
		})
		part, err := g.writeEpisodeWithRetry(plan, ep, ctx, n)
		if err != nil {
			g.Emit("log", fmt.Sprintf("第 %d 集第一轮失败：%v，将进入全局补救轮。", n, err), nil)
			failedIdx = append(failedIdx, i)
			scripts = append(scripts, "") // 占位，后面回填
			episodeList = append(episodeList, map[string]any{
				"title": fmt.Sprintf("第 %d 集", n),
				"text":  "", // 空，后面回填
			})
			continue
		}
		_ = os.WriteFile(path, []byte(part), 0o644)
		scripts = append(scripts, part)
		episodeList = append(episodeList, map[string]any{
			"title": fmt.Sprintf("第 %d 集", n),
			"text":  part,
		})
		lastOKIdx = i
		g.Emit("script_progress", fmt.Sprintf("第 %d 集完成。", n), map[string]any{
			"batch": i + 1, "batches": total, "episode": n,
		})
	}

	// 全局补救轮：把第一轮失败的集，用更激进的 prompt 再重写一次。
	// 此时 scripts 里相邻集都已经成功，可以给更强的衔接上下文。
	if len(failedIdx) > 0 {
		g.Emit("log", fmt.Sprintf("进入全局补救轮，重写 %d 个失败集。", len(failedIdx)), nil)
		for _, i := range failedIdx {
			g.Wait()
			ep := episodes[i]
			n := asInt(ep["number"])
			path := filepath.Join(episodesDir, fmt.Sprintf("E%03d.md", n))

			prevFull := ""
			prevHook := ""
			for p := i - 1; p >= 0; p-- {
				if scripts[p] != "" {
					prevFull = scripts[p]
					prevHook = planHook(episodes[p])
					break
				}
			}
			ctx := EpisodePromptContext{
				NameLock:    nameLock,
				Continuity:  buildContinuityCard(prevFull, prevHook).Format(),
				NextOutline: nextEpisodeOutline(episodes, i),
			}
			part, err := g.rewriteFailedEpisode(plan, ep, ctx, n, scripts, i)
			if err != nil {
				g.Emit("log", fmt.Sprintf("第 %d 集补救轮仍失败：%v，用占位保底。", n, err), nil)
				episodeErrors = append(episodeErrors, map[string]any{
					"episode": n, "error": err.Error(),
				})
				_ = os.Remove(path)
				part = fmt.Sprintf("Episode %d\n\n⚠️ Script generation failed: %v\n", n, err)
			} else {
				_ = os.WriteFile(path, []byte(part), 0o644)
				g.Emit("log", fmt.Sprintf("第 %d 集补救轮成功。", n), nil)
			}
			scripts[i] = part
			episodeList[i] = map[string]any{
				"title": fmt.Sprintf("第 %d 集", n),
				"text":  part,
			}
		}
	}

	if len(episodeList) == 0 {
		return nil, LLMError{"全部集数生成失败，未产出可用正文。"}
	}
	if len(episodeErrors) > 0 {
		g.Emit("log", fmt.Sprintf("最终仍有 %d 集失败（已用占位保底）。建议清缓存后单独重跑失败集。", len(episodeErrors)), nil)
	}

	fullScript := strings.Join(scripts, "\n\n")
	scriptMD := filepath.Join(outputDir, "剧本.md")
	_ = os.WriteFile(scriptMD, []byte(fullScript), 0o644)

	titleCN := strings.TrimSpace(fmt.Sprint(plan["title_cn"]))
	titleEN := strings.TrimSpace(fmt.Sprint(plan["title_en"]))
	if titleEN == "" {
		titleEN = "Untitled"
	}
	g.Emit("log", "正在用模型做货架评级与情节标签（偏 D～B，避免全 B / 全豪门反转）。", nil)
	grade, shelfTags, shelfAud, rateErr := RateSingleShelf(
		g.Client,
		titleCN,
		fmt.Sprint(plan["logline"]),
		joinAny(plan["plot_summary"]),
		"",
	)
	if rateErr != nil {
		g.Emit("log", "货架评级失败，回落 C："+rateErr.Error(), nil)
		grade, shelfTags, shelfAud = "C", []string{"爽文", "逆袭"}, "女频"
	}
	rating := map[string]any{
		"grade": grade, "score": gradeScore(grade), "items": []any{}, "caps": "未触发", "gap": []any{},
		"tags": shelfTags, "audience": shelfAud,
	}
	_ = writeJSON(filepath.Join(outputDir, "rating.json"), rating)
	g.Emit("log", fmt.Sprintf("货架评级 %s，标签 %s。", grade, strings.Join(shelfTags, "/")), nil)

	meta := buildMeta(plan, rating, episodeList)
	metaPath := filepath.Join(outputDir, "设定要点.json")
	if err := writeJSON(metaPath, meta); err != nil {
		return nil, err
	}
	scriptDocx := filepath.Join(outputDir, "剧本.docx")
	settingDocx := filepath.Join(outputDir, "设定.docx")
	if err := WriteScriptDocx(scriptDocx, titleEN, scripts); err != nil {
		return nil, err
	}
	if err := WriteSettingDocx(settingDocx, plan, rating); err != nil {
		return nil, err
	}
	g.Emit("log", "剧本与设定 Word 已生成。", nil)
	out := map[string]any{
		"title_cn":       plan["title_cn"],
		"title_en":       titleEN,
		"episode_count":  len(episodeList),
		"episode_planned": total,
		"plan_json":      planPath,
		"script_md":      scriptMD,
		"script_docx":    scriptDocx,
		"setting_docx":   settingDocx,
		"rating":         rating,
		"meta":           meta,
		"meta_json":      metaPath,
	}
	if len(episodeErrors) > 0 {
		out["episode_errors"] = episodeErrors
	}
	return out, nil
}

// writeEpisodeWithRetry 单集生成：抬高 max_tokens，质量不合格自动重试。
// 重试 5 次，每次给模型不同的具体修正指令，避免模型"同错重犯"。
func (g *Generator) writeEpisodeWithRetry(plan map[string]any, ep map[string]any, ctx EpisodePromptContext, n int) (string, error) {
	const maxAttempts = 5
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		g.Wait()
		msgs := BuildEpisodeMessages(g.Skill, plan, []map[string]any{ep}, ctx)
		if attempt > 1 {
			msgs = append(msgs, Message{
				Role: "user",
				Content: specificRetryPrompt(n, lastErr, attempt, maxAttempts),
			})
		}
		temp := 0.75
		if attempt >= 3 {
			temp = 0.6 // 后两次降温度，让模型更"听话"
		}
		maxToks := 12288
		if attempt >= 4 {
			maxToks = 16384 // 最后一次给更多 token 避免截断
		}
		text, err := g.Client.ChatOpt(msgs, ChatOptions{
			JSONMode:    false,
			MaxTokens:   maxToks,
			Temperature: temp,
		})
		if err != nil {
			lastErr = err
			g.Emit("log", fmt.Sprintf("第 %d 集请求失败（%d/%d）：%v", n, attempt, maxAttempts, err), nil)
			continue
		}
		cleaned := CleanScriptText(text)
		if truncatedMarkerRE.MatchString(cleaned) {
			lastErr = episodeQualityError{"模型输出被 max_tokens 截断"}
			g.Emit("log", fmt.Sprintf("第 %d 集质检未过（%d/%d）：%v", n, attempt, maxAttempts, lastErr), nil)
			continue
		}
		if isModelRefusal(cleaned) {
			lastErr = episodeQualityError{"疑似模型拒写"}
			g.Emit("log", fmt.Sprintf("第 %d 集质检未过（%d/%d）：%v", n, attempt, maxAttempts, lastErr), nil)
			continue
		}
		part := isolateEpisode(cleaned, n)
		if err := validateEpisodeText(part, n); err != nil {
			lastErr = err
			g.Emit("log", fmt.Sprintf("第 %d 集质检未过（%d/%d）：%v", n, attempt, maxAttempts, err), nil)
			continue
		}
		return part, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("未知错误")
	}
	return "", LLMError{fmt.Sprintf("第 %d 集生成失败（已重试 %d 次）：%v", n, maxAttempts, lastErr)}
}

// specificRetryPrompt 根据上次具体失败原因，给模型针对性的修正指令。
func specificRetryPrompt(n int, lastErr error, attempt, maxAttempts int) string {
	base := fmt.Sprintf("[第 %d 次重写（%d/%d）]", attempt, attempt, maxAttempts)
	msg := strings.TrimSpace(lastErr.Error())
	switch {
	case strings.Contains(msg, "截断") || strings.Contains(msg, "max_tokens"):
		return base + `上一次输出被截断。这次务必：先把开头和场次头写简洁，省出 token 给结尾；正文台词与动作写到 8–10 场景；最后一行必须完整写 "END OF EPISODE ` + fmt.Sprint(n) + `" 然后立即停笔，不要追加任何东西。`
	case strings.Contains(msg, "END OF EPISODE"):
		return base + fmt.Sprintf(`上一次缺少 "END OF EPISODE %d" 结尾标记。这次写完完整正文后，**务必在最后一行独立写出**: END OF EPISODE %d\n写完就停，不要追加任何思考、说明、下一集标题或其它内容。`, n, n)
	case strings.Contains(msg, "场次头") || strings.Contains(msg, "场景"):
		return base + `上一次没有写出好莱坞标准场次头。请按格式: 集号-场号 LOCATION [INT./EXT.] [DAY/NIGHT] 开始每一场。示例: "1-1 DOCTOR'S OFFICE - INT. - DAY"`
	case strings.Contains(msg, "过短") || strings.Contains(msg, "字数"):
		return base + `上一次正文太短。请写完整一集：至少 6–8 场、每场 2–3 行台词+动作；人物互动丰富、有冲突或转折。`
	case strings.Contains(msg, "拒写"):
		return base + `上一次你似乎在拒写。请直接写剧本正文，不要解释为什么不能写，不要道歉，不要写思考过程。`
	case strings.Contains(msg, "半截句") || strings.Contains(msg, "截断"):
		return base + `上一次 END 前的台词像是被截断。请确保每句台词完整说完，END OF EPISODE 前最后一句必须以句号/感叹号/问号收尾。`
	default:
		return base + fmt.Sprintf(`上一次不合格：%s。请重写完整一集：场次齐全、台词完整、最后一行是 END OF EPISODE %d、人物名严格使用锁定列表、从上一集结尾自然接续。`, msg, n)
	}
}

func (g *Generator) chatJSON(messages []Message, label string, maxTokens int) (map[string]any, error) {
	var last error
	msgs := messages
	for attempt := 1; attempt <= 3; attempt++ {
		text, err := g.Client.ChatOpt(msgs, ChatOptions{
			JSONMode:    true,
			MaxTokens:   maxTokens,
			Temperature: 0.2,
		})
		if err != nil {
			return nil, err
		}
		payload, err := extractJSON(text)
		if err == nil {
			return payload, nil
		}
		last = err
		snippet := strings.TrimSpace(text)
		if len(snippet) > 180 {
			snippet = snippet[:180] + "…"
		}
		g.Emit("log", fmt.Sprintf("%s 返回内容不是合法 JSON，正在重试（%d/3）。预览：%s", label, attempt, snippet), nil)
		msgs = append(append([]Message{}, messages...), Message{
			Role: "user",
			Content: "上一次输出不是合法 JSON（可能被截断或夹杂说明文字）。" +
				"请重新输出：只输出一个完整 JSON 对象，从 { 开始到 } 结束；" +
				"不要 Markdown；episodes 保持字段短小以保证完整闭合。",
		})
	}
	return nil, LLMError{fmt.Sprintf("%s 没有产出合法 JSON：%v", label, last)}
}

func extractJSON(text string) (map[string]any, error) {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if !codeFenceLineRE.MatchString(strings.TrimSpace(line)) {
			lines = append(lines, line)
		}
	}
	cleaned := strings.TrimSpace(strings.Join(lines, "\n"))
	cleaned = strings.ReplaceAll(cleaned, "/* truncated_by_max_tokens */", "")
	start := strings.Index(cleaned, "{")
	if start < 0 {
		return nil, fmt.Errorf("模型没有返回 JSON 对象")
	}
	body := cleaned[start:]
	end := strings.LastIndex(body, "}")
	candidates := []string{}
	if end > 0 {
		candidates = append(candidates, body[:end+1])
	}
	candidates = append(candidates, body, closeTruncatedJSON(body))

	var lastErr error
	for _, cand := range candidates {
		for _, attempt := range []string{cand, repairJSON(cand)} {
			var payload map[string]any
			if err := json.Unmarshal([]byte(attempt), &payload); err != nil {
				lastErr = err
				continue
			}
			return payload, nil
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("模型没有返回 JSON 对象")
	}
	return nil, lastErr
}

// closeTruncatedJSON tries to salvage JSON cut off by max_tokens.
func closeTruncatedJSON(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	// Drop trailing incomplete string / trailing comma noise.
	s = strings.TrimRight(s, " \t\r\n,")
	inString := false
	escaped := false
	var stack []byte
	for _, r := range s {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch r {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch r {
		case '"':
			inString = true
		case '{', '[':
			stack = append(stack, byte(r))
		case '}':
			if len(stack) > 0 && stack[len(stack)-1] == '{' {
				stack = stack[:len(stack)-1]
			}
		case ']':
			if len(stack) > 0 && stack[len(stack)-1] == '[' {
				stack = stack[:len(stack)-1]
			}
		}
	}
	if inString {
		s += `"`
	}
	// Remove dangling incomplete key/value after last comma or colon.
	for {
		trimmed := strings.TrimRight(s, " \t\r\n")
		if strings.HasSuffix(trimmed, ",") || strings.HasSuffix(trimmed, ":") {
			s = trimmed[:len(trimmed)-1]
			continue
		}
		break
	}
	for i := len(stack) - 1; i >= 0; i-- {
		if stack[i] == '{' {
			s += "}"
		} else {
			s += "]"
		}
	}
	return s
}

func repairJSON(text string) string {
	// Escape bare newlines inside JSON strings, then drop trailing commas.
	var out strings.Builder
	inString := false
	escaped := false
	for _, r := range text {
		if inString {
			if escaped {
				out.WriteRune(r)
				escaped = false
				continue
			}
			switch r {
			case '\\':
				out.WriteRune(r)
				escaped = true
			case '"':
				out.WriteRune(r)
				inString = false
			case '\n':
				out.WriteString(`\n`)
			case '\r':
				continue
			default:
				out.WriteRune(r)
			}
			continue
		}
		if r == '"' {
			inString = true
		}
		out.WriteRune(r)
	}
	re := regexp.MustCompile(`,(\s*[}\]])`)
	return re.ReplaceAllString(out.String(), "$1")
}

func sliceEpisodeText(text string, firstNumber int) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if !codeFenceLineRE.MatchString(strings.TrimSpace(line)) {
			lines = append(lines, line)
		}
	}
	cleaned := strings.TrimSpace(strings.Join(lines, "\n"))
	specific := regexp.MustCompile(fmt.Sprintf(`(?im)^\s*(?:\*{0,2}\s*)?(?:Episode|EP)\s+%d\s*(?:\*{0,2})?\s*$`, firstNumber))
	if loc := specific.FindStringIndex(cleaned); loc != nil {
		return strings.TrimSpace(cleaned[loc[0]:])
	}
	if loc := episodeHeaderRE.FindStringIndex(cleaned); loc != nil {
		return strings.TrimSpace(cleaned[loc[0]:])
	}
	return cleaned
}

func qualityFullLabel(grade string) string {
	g := strings.ToUpper(strings.TrimSpace(grade))
	if g == "" {
		return "B 良好"
	}
	switch string([]rune(g)[0]) {
	case "S":
		return "S 顶级精品"
	case "A":
		return "A 优质"
	case "B":
		return "B 良好"
	case "C":
		return "C 基础"
	case "D":
		return "D 特价"
	default:
		return "B 良好"
	}
}

func gradeScore(grade string) int {
	switch strings.ToUpper(strings.TrimSpace(grade)) {
	case "S":
		return 95
	case "A":
		return 88
	case "B":
		return 78
	case "C":
		return 65
	case "D":
		return 55
	default:
		return 70
	}
}

func buildMeta(plan, rating map[string]any, episodeList []map[string]any) map[string]any {
	categories, _ := plan["categories"].(map[string]any)
	if categories == nil {
		categories = map[string]any{}
	}
	var subs []string
	switch t := categories["subs"].(type) {
	case []any:
		for _, item := range t {
			subs = append(subs, fmt.Sprint(item))
		}
	case []string:
		subs = t
	}
	// 货架评级返回的情节标签优先写入 categories.subs，避免前端回落成「豪门/反转」
	if rawTags, ok := rating["tags"].([]string); ok && len(rawTags) > 0 {
		subs = append([]string{}, rawTags...)
	}
	main := fmt.Sprint(categories["main"])
	cover, _ := plan["cover"].(map[string]any)
	if cover == nil {
		cover = map[string]any{}
	}
	var parts []string
	for _, key := range []string{"visual", "palette", "composition", "tagline"} {
		if v := strings.TrimSpace(fmt.Sprint(cover[key])); v != "" && v != "<nil>" {
			parts = append(parts, v)
		}
	}
	prompt := strings.Join(parts, "，")
	if prompt != "" {
		// 英文标题由 /cover 接口按 enTitle 注入生图提示，这里只保留画面描述
		prompt += "，竖版 3:4 短剧海报，电影感光影，主体居中，高清细节"
	}
	audienceText := main + strings.Join(subs, "")
	audience := "女频"
	if strings.Contains(audienceText, "男频") {
		audience = "男频"
	}
	if a := strings.TrimSpace(fmt.Sprint(rating["audience"])); a == "男频" || a == "女频" {
		audience = a
	}
	synopsis := strings.Join(strings.Split(joinAny(plan["plot_summary"]), "\n"), "")
	if len([]rune(synopsis)) > 300 {
		synopsis = string([]rune(synopsis)[:300])
	}
	logline := fmt.Sprint(plan["logline"])
	if len([]rune(logline)) > 40 {
		logline = string([]rune(logline)[:40])
	}
	return map[string]any{
		"title":         fmt.Sprint(plan["title_cn"]),
		"enTitle":       fmt.Sprint(plan["title_en"]),
		"logline":       logline,
		"synopsis":      synopsis,
		"totalEpisodes": len(episodeList),
		"language":      "英语",
		"audience":      audience,
		"quality":       qualityFullLabel(fmt.Sprint(rating["grade"])),
		"categories":    map[string]any{"main": main, "subs": subs},
		"coverPrompt":   prompt,
		"episodes":      episodeList,
	}
}

// isolateEpisode 从模型输出里抽出第 n 集：从 Episode n 起，到 END OF EPISODE n 止（含），丢掉粘上的下一集。
func isolateEpisode(text string, n int) string {
	if n < 1 || strings.TrimSpace(text) == "" {
		return strings.TrimSpace(text)
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	startRE := regexp.MustCompile(fmt.Sprintf(`(?im)^\s*(?:\*{0,2}\s*)?(?:Episode|EP)\s+%d\s*(?:\*{0,2})?\s*$`, n))
	endInlineRE := regexp.MustCompile(fmt.Sprintf(`(?i)END\s+OF\s+EPISODE\s+%d`, n))

	lines := strings.Split(text, "\n")
	startIdx := -1
	for i, line := range lines {
		if startRE.MatchString(strings.TrimSpace(line)) {
			startIdx = i
			break
		}
	}
	var body string
	if startIdx >= 0 {
		body = strings.Join(lines[startIdx:], "\n")
	} else {
		body = fmt.Sprintf("Episode %d\n\n%s", n, strings.TrimSpace(text))
	}

	if loc := endInlineRE.FindStringIndex(body); loc != nil {
		// 保留 END OF EPISODE N 本身，丢掉其后所有内容（含 ****Episode 3）
		body = strings.TrimRight(body[:loc[1]], " \t*") + "\n"
	}
	// 故意不自动补 END：交给 validateEpisodeText 判失败并重试
	return strings.TrimSpace(body) + "\n"
}

func splitEpisodes(text string) []map[string]any {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	matches := episodeHeaderRE.FindAllStringSubmatchIndex(text, -1)
	endMatches := endEpisodeNumRE.FindAllStringSubmatchIndex(text, -1)
	// 标题行过少（常见：只有裸写的 Episode 10）时，改用 END OF EPISODE 切开，避免丢掉 **Episode 1** 批次
	if len(matches) < 2 || (len(endMatches) >= 2 && len(endMatches) > len(matches)+2) {
		if parts := splitByEndOfEpisode(text); len(parts) >= 2 {
			return parts
		}
	}
	if len(matches) == 0 {
		return []map[string]any{{"title": "第 1 集", "text": text}}
	}
	var out []map[string]any
	for i, m := range matches {
		num, _ := strconv.Atoi(text[m[2]:m[3]])
		start := m[1]
		end := len(text)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		body := strings.TrimSpace(text[start:end])
		if len([]rune(body)) < 40 {
			continue
		}
		out = append(out, map[string]any{
			"title": fmt.Sprintf("第 %d 集", num),
			"text":  body,
		})
	}
	if len(out) == 0 {
		return []map[string]any{{"title": "第 1 集", "text": text}}
	}
	return out
}

func splitByEndOfEpisode(text string) []map[string]any {
	locs := endEpisodeNumRE.FindAllStringSubmatchIndex(text, -1)
	if len(locs) == 0 {
		return nil
	}
	var out []map[string]any
	start := 0
	for _, loc := range locs {
		num, _ := strconv.Atoi(text[loc[2]:loc[3]])
		end := loc[1]
		if i := strings.IndexByte(text[end:], '\n'); i >= 0 {
			end = end + i
		} else {
			end = len(text)
		}
		body := strings.TrimSpace(text[start:end])
		start = end
		for start < len(text) && (text[start] == '\n' || text[start] == '\r' || text[start] == ' ') {
			start++
		}
		if len([]rune(body)) < 80 {
			continue
		}
		if num < 1 {
			num = len(out) + 1
		}
		out = append(out, map[string]any{
			"title": fmt.Sprintf("第 %d 集", num),
			"text":  body,
		})
	}
	return out
}

func ensureTranscriptUsable(transcript string) error {
	var n int
	for _, line := range strings.Split(transcript, "\n") {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(strings.ToLower(trim), "episode ") {
			continue
		}
		n += len([]rune(trim))
	}
	if n < 200 {
		return LLMError{fmt.Sprintf("字幕台词过少（约 %d 字），无法策划。请确认字幕已正确解析后再生成。", n)}
	}
	return nil
}

var planPlaceholderRE = regexp.MustCompile(`(?i)待定|untitled|原稿缺失|无法生成|无法从空白|无内容|content\s*missing|空白集数|无法策划|无法定位|无法设计|无法构图`)

func validatePlanContent(plan map[string]any) error {
	fields := []string{
		fmt.Sprint(plan["title_cn"]),
		fmt.Sprint(plan["title_en"]),
		fmt.Sprint(plan["logline"]),
		joinAny(plan["plot_summary"]),
	}
	for _, f := range fields {
		if planPlaceholderRE.MatchString(f) {
			return LLMError{"策划结果是占位/拒答文案（如「待定剧名」「原稿缺失」），未写入表单。请检查字幕是否解析成功后重跑生成。"}
		}
	}
	titleCN := strings.TrimSpace(fmt.Sprint(plan["title_cn"]))
	titleEN := strings.TrimSpace(fmt.Sprint(plan["title_en"]))
	if titleCN == "" || titleEN == "" || titleCN == "<nil>" || titleEN == "<nil>" {
		return LLMError{"策划缺少有效剧名，已中止。"}
	}
	return nil
}

func writeJSON(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func asInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	default:
		n, _ := strconv.Atoi(fmt.Sprint(v))
		return n
	}
}

// trimTranscriptForPlanning 把全剧字幕裁剪成策划阶段可喂的长度。
// 关键原则：**每集都要至少出现一次**，而不是简单按字数硬切前 N 字。
// 否则 80 集会只剩前 15 集，LLM 根本不知道后面的存在。
func trimTranscriptForPlanning(transcript string, perEpisodeHeadChars, maxChars int) string {
	if len(transcript) <= maxChars {
		return transcript
	}
	// 按 "Episode N" 切开
	epMarkerRE := regexp.MustCompile(`(?im)^Episode\s+(\d+)\s*$`)
	type piece struct {
		num   int
		start int
		end   int
		body  string
	}
	var pieces []piece
	loc := epMarkerRE.FindAllStringSubmatchIndex(transcript, -1)
	if len(loc) == 0 {
		// 没有 Episode 标记就退回硬切，但加警告
		return transcript[:maxChars] + "\n…(transcript truncated for planning)"
	}
	for i, m := range loc {
		num, _ := strconv.Atoi(transcript[m[2]:m[3]])
		start := m[1]
		end := len(transcript)
		if i+1 < len(loc) {
			end = loc[i+1][0]
		}
		body := strings.TrimSpace(transcript[start:end])
		pieces = append(pieces, piece{num: num, start: start, end: end, body: body})
	}
	// 每集取前 perEpisodeHeadChars 字
	var out strings.Builder
	written := 0
	for _, p := range pieces {
		chunk := p.body
		if len(chunk) > perEpisodeHeadChars {
			chunk = chunk[:perEpisodeHeadChars]
		}
		if out.Len()+len(chunk) > maxChars && written > 0 {
			out.WriteString(fmt.Sprintf("\n…(后续剧集略，共 %d 集)\n", len(pieces)-written))
			break
		}
		out.WriteString(chunk)
		out.WriteString("\n\n")
		written++
	}
	return strings.TrimSpace(out.String())
}

// countTranscriptEpisodes 数一下截断后的字幕里有多少集出现。
func countTranscriptEpisodes(transcript string) int {
	re := regexp.MustCompile(`(?im)^Episode\s+(\d+)\s*$`)
	return len(re.FindAllStringIndex(transcript, -1))
}

// fillMissingEpisodeOutlines 把 LLM 策划时偷懒漏写的集号补齐。
// 缺失集用前一集的钩子 + "剧情推进" 作为占位 event，scenes 留空让写剧本阶段自己生成。
func fillMissingEpisodeOutlines(existing []map[string]any, hint int, emit EmitFn) []map[string]any {
	if hint <= len(existing) {
		return existing
	}
	has := map[int]map[string]any{}
	for _, ep := range existing {
		has[asInt(ep["number"])] = ep
	}
	var out []map[string]any
	var gaps int
	for n := 1; n <= hint; n++ {
		if ep, ok := has[n]; ok {
			out = append(out, ep)
		} else {
			gaps++
			prevHook := ""
			if len(out) > 0 {
				prevHook = fmt.Sprint(out[len(out)-1]["hook"])
			}
			out = append(out, map[string]any{
				"number":  n,
				"event":   fmt.Sprintf("第 %d 集剧情推进（策划阶段该集字幕被截断）", n),
				"emotion": "承上启下",
				"scenes":  []string{},
				"hook":    prevHook,
				"_filled": true,
			})
		}
	}
	if gaps > 0 && emit != nil {
		emit("log", fmt.Sprintf("策划补齐 %d 集占位大纲（LLM 漏写，将在逐集写作阶段自动生成完整大纲）。", gaps), nil)
	}
	return out
}

// rewriteFailedEpisode 补救轮重写失败集：比第一轮更激进的 prompt，
// 给模型看完整前集尾部 + 前后集大纲 + 明确"这是最后机会必须成功"。
func (g *Generator) rewriteFailedEpisode(plan map[string]any, ep map[string]any, ctx EpisodePromptContext, n int, allScripts []string, currentIdx int) (string, error) {
	const salvageAttempts = 3
	var lastErr error

	// 补救轮给模型看更多上下文：前一集完整正文尾部 800 字（如果相邻有成功集的话）
	richContext := ctx
	for prev := currentIdx - 1; prev >= 0 && prev >= currentIdx-2; prev-- {
		if allScripts[prev] != "" {
			rs := []rune(allScripts[prev])
			tail := allScripts[prev]
			if len(rs) > 800 {
				tail = string(rs[len(rs)-800:])
			}
			richContext.Continuity += "\n- prev_episode_tail:\n" + tail
			break
		}
	}
	// 后面一集如果也已经成功，也告诉模型
	for next := currentIdx + 1; next < len(allScripts) && next <= currentIdx+2; next++ {
		if allScripts[next] != "" {
			richContext.NextOutline = nextEpisodeOutline([]map[string]any{ep}, 0) + "（注意：你正写的这一集前面可能失败，先写好这一集再说）"
			break
		}
	}

	for attempt := 1; attempt <= salvageAttempts; attempt++ {
		g.Wait()
		msgs := BuildEpisodeMessages(g.Skill, plan, []map[string]any{ep}, richContext)
		msgs = append(msgs, Message{
			Role: "user",
			Content: fmt.Sprintf(
				"【补救重写】Episode %d 前几轮都失败了。这是最后机会，你必须写对。\n"+
					"硬性要求：\n"+
					"1) 第一行必须是 Episode %d\n"+
					"2) 写 6–10 场，每场完整（场次头+动作+对话）\n"+
					"3) 最后一行独立写 END OF EPISODE %d，写完立即停笔\n"+
					"4) 不许写任何思考、说明、下一集预告、总结\n"+
					"5) 严格使用【人物名锁定】里的名字\n"+
					"现在，从头写完整的 Episode %d。",
				n, n, n, n,
			),
		})
		temp := 0.6
		if attempt >= 2 {
			temp = 0.45 // 更保守
		}
		maxToks := 16384
		if attempt >= 2 {
			maxToks = 20480
		}
		text, err := g.Client.ChatOpt(msgs, ChatOptions{
			JSONMode:    false,
			MaxTokens:   maxToks,
			Temperature: temp,
		})
		if err != nil {
			lastErr = err
			continue
		}
		cleaned := CleanScriptText(text)
		if truncatedMarkerRE.MatchString(cleaned) {
			lastErr = episodeQualityError{"输出被 max_tokens 截断"}
			continue
		}
		part := isolateEpisode(cleaned, n)
		if err := validateEpisodeText(part, n); err != nil {
			lastErr = err
			continue
		}
		return part, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("未知错误")
	}
	return "", LLMError{fmt.Sprintf("补救轮 Episode %d 仍失败：%v", n, lastErr)}
}
