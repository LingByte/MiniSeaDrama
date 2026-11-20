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
	episodeHeaderRE = regexp.MustCompile(`(?im)^\s*Episode\s+(\d+)\s*$`)
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
		g.BatchSize = 3
	}
	if g.BatchSize > 10 {
		g.BatchSize = 10
	}
	outputDir := filepath.Join(workdir, "output")
	episodesDir := filepath.Join(outputDir, "episodes")
	_ = os.MkdirAll(episodesDir, 0o755)

	if err := ensureTranscriptUsable(transcript); err != nil {
		return nil, err
	}

	// 策划阶段字幕过长会把输出挤爆 max_tokens，导致 JSON 被截断。
	planTranscript := transcript
	const planTranscriptLimit = 80_000
	if len(planTranscript) > planTranscriptLimit {
		planTranscript = planTranscript[:planTranscriptLimit] + "\n…(transcript truncated for planning)"
	}

	g.Wait()
	g.Emit("log", "正在生成全剧策划与分集大纲。", nil)
	plan, err := g.chatJSON(BuildPlanMessages(g.Skill, planTranscript), "策划阶段", 24576)
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
	g.Emit("log", fmt.Sprintf("策划完成：%v，共 %d 集。", plan["title_en"], len(episodes)), map[string]any{
		"title_cn": plan["title_cn"], "title_en": plan["title_en"], "episode_count": len(episodes),
	})

	var scripts []string
	totalBatches := (len(episodes) + g.BatchSize - 1) / g.BatchSize
	for batchIndex := 0; batchIndex < totalBatches; batchIndex++ {
		g.Wait()
		start := batchIndex * g.BatchSize
		end := start + g.BatchSize
		if end > len(episodes) {
			end = len(episodes)
		}
		batch := episodes[start:end]
		first := asInt(batch[0]["number"])
		last := asInt(batch[len(batch)-1]["number"])
		batchName := fmt.Sprintf("E%03d-E%03d.md", first, last)
		batchPath := filepath.Join(episodesDir, batchName)
		if st, err := os.Stat(batchPath); err == nil && st.Size() > 0 {
			data, _ := os.ReadFile(batchPath)
			scripts = append(scripts, string(data))
			g.Emit("script_progress", fmt.Sprintf("第 %d~%d 集已存在，直接复用。", first, last), map[string]any{
				"batch": batchIndex + 1, "batches": totalBatches, "episode": last,
			})
			continue
		}
		previousTail := ""
		if len(scripts) > 0 {
			joined := strings.Join(scripts, "\n")
			if len(joined) > 1500 {
				previousTail = joined[len(joined)-1500:]
			} else {
				previousTail = joined
			}
		}
		g.Emit("script_progress", fmt.Sprintf("正在写第 %d~%d 集（%d/%d）。", first, last, batchIndex+1, totalBatches), map[string]any{
			"batch": batchIndex + 1, "batches": totalBatches, "episode": first,
		})
		text, err := g.Client.Chat(BuildEpisodeMessages(g.Skill, plan, batch, previousTail), false)
		if err != nil {
			return nil, err
		}
		text = sliceEpisodeText(text, first)
		scripts = append(scripts, text)
		_ = os.WriteFile(batchPath, []byte(text), 0o644)
		g.Emit("script_progress", fmt.Sprintf("第 %d~%d 集完成。", first, last), map[string]any{
			"batch": batchIndex + 1, "batches": totalBatches, "episode": last,
		})
	}

	cleaned := make([]string, len(scripts))
	for i, s := range scripts {
		cleaned[i] = CleanScriptText(s)
	}
	fullScript := strings.Join(cleaned, "\n\n")
	scriptMD := filepath.Join(outputDir, "剧本.md")
	_ = os.WriteFile(scriptMD, []byte(fullScript), 0o644)

	rating := map[string]any{"grade": "B", "score": 80, "items": []any{}, "caps": "未触发", "gap": []any{}}
	g.Emit("log", "已跳过模型评级，直接使用默认等级 B。", nil)
	_ = writeJSON(filepath.Join(outputDir, "rating.json"), rating)

	titleEN := strings.TrimSpace(fmt.Sprint(plan["title_en"]))
	if titleEN == "" {
		titleEN = "Untitled"
	}
	meta := buildMeta(plan, rating, fullScript)
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
	return map[string]any{
		"title_cn":      plan["title_cn"],
		"title_en":      titleEN,
		"episode_count": len(episodes),
		"plan_json":     planPath,
		"script_md":     scriptMD,
		"script_docx":   scriptDocx,
		"setting_docx":  settingDocx,
		"rating":        rating,
		"meta":          meta,
		"meta_json":     metaPath,
	}, nil
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
	specific := regexp.MustCompile(fmt.Sprintf(`(?im)^\s*Episode\s+%d\s*$`, firstNumber))
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
	g = string([]rune(g)[0])
	switch g {
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

func buildMeta(plan, rating map[string]any, fullScript string) map[string]any {
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
	episodeList := splitEpisodes(fullScript)
	audienceText := main + strings.Join(subs, "")
	audience := "女频"
	if strings.Contains(audienceText, "男频") {
		audience = "男频"
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

func splitEpisodes(text string) []map[string]any {
	matches := episodeHeaderRE.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		body := strings.TrimSpace(text)
		if body == "" {
			return nil
		}
		return []map[string]any{{"title": "第 1 集", "text": body}}
	}
	var out []map[string]any
	for i, m := range matches {
		num, _ := strconv.Atoi(text[m[2]:m[3]])
		start := m[1]
		end := len(text)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		out = append(out, map[string]any{
			"title": fmt.Sprintf("第 %d 集", num),
			"text":  strings.TrimSpace(text[start:end]),
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
