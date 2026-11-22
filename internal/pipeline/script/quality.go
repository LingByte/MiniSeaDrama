// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

var (
	truncatedMarkerRE = regexp.MustCompile(`(?i)truncated_by_max_tokens`)
	sceneHouseRE       = regexp.MustCompile(`(?im)^\s*\d+\s*-\s*\d+\s+\S+`)
	sceneHollywoodRE   = regexp.MustCompile(`(?im)^\s*(?:\*{0,2}\s*)?(?:INT\.|EXT\.)`)
	// 半截句：以虚词收尾且无句末标点（故意省略号/破折号打断不算）
	danglingTailRE = regexp.MustCompile(`(?i)\b(the|a|an|and|or|but|to|of|for|with|that|this|is|are|was|were|be|been|have|has|had|will|would|can|could|should|may|might)\s*$`)
	refusalHeadRE  = regexp.MustCompile(`(?i)^\s*(I can'?t help with this request|I'?m not able to write|I cannot (?:write|create|generate)|as an AI language model|I must refuse)`)
)

// episodeQualityError 单集正文不合格原因（可重试）。
type episodeQualityError struct{ Reason string }

func (e episodeQualityError) Error() string { return e.Reason }

// isModelRefusal 拒写检测：开头即拒写，或全文拒写且几乎无场次。
func isModelRefusal(text string) bool {
	trim := strings.TrimSpace(text)
	if trim == "" {
		return false
	}
	head := trim
	if rs := []rune(head); len(rs) > 800 {
		head = string(rs[:800])
	}
	if refusalHeadRE.MatchString(head) {
		return true
	}
	if !llmRefusalRE.MatchString(trim) {
		return false
	}
	// 长拒写夹带空话：没有场次头则视为拒写
	return !sceneHouseRE.MatchString(trim) && !sceneHollywoodRE.MatchString(trim)
}

// validateEpisodeText 检查单集是否可落盘：有 END、够长、未中途截断、有场次。
// 调用方应先 isolate（不合成 END），再校验——缺 END 必须失败并重试。
func validateEpisodeText(text string, n int) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return episodeQualityError{"正文为空"}
	}
	if truncatedMarkerRE.MatchString(text) {
		return episodeQualityError{"模型输出被 max_tokens 截断"}
	}
	if isModelRefusal(text) {
		return episodeQualityError{"疑似模型拒写"}
	}
	runes := len([]rune(text))
	if runes < 1000 {
		return episodeQualityError{fmt.Sprintf("正文过短（%d 字）", runes)}
	}
	endRE := regexp.MustCompile(fmt.Sprintf(`(?i)END\s+OF\s+EPISODE\s+%d\b`, n))
	if !endRE.MatchString(text) {
		return episodeQualityError{fmt.Sprintf("缺少 END OF EPISODE %d", n)}
	}
	if !sceneHouseRE.MatchString(text) && !sceneHollywoodRE.MatchString(text) {
		return episodeQualityError{"缺少场次头（X-Y … 或 INT./EXT.）"}
	}
	if looksTruncatedBeforeEnd(text, n) {
		return episodeQualityError{"END 前台词像被截断（半截句）"}
	}
	return nil
}

// looksTruncatedBeforeEnd：END 上一行以虚词收尾且无句末标点；或 END 前只剩角色名。
func looksTruncatedBeforeEnd(text string, n int) bool {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	endIdx := -1
	endLineRE := regexp.MustCompile(fmt.Sprintf(`(?i)END\s+OF\s+EPISODE\s+%d`, n))
	for i := len(lines) - 1; i >= 0; i-- {
		if endLineRE.MatchString(lines[i]) {
			endIdx = i
			break
		}
	}
	if endIdx <= 0 {
		return false
	}
	prev := ""
	for i := endIdx - 1; i >= 0; i-- {
		s := strings.TrimSpace(lines[i])
		if s == "" || s == "---" || s == "***" {
			continue
		}
		u := strings.ToUpper(strings.Trim(s, ".*"))
		if u == "FADE TO BLACK" || u == "FADE TO BLACK." || u == "CUT TO BLACK" || u == "SMASH TO BLACK" {
			continue
		}
		prev = s
		break
	}
	if prev == "" {
		return true
	}
	if isCharacterCue(prev) {
		return true // END 前只剩角色名 → 台词被截
	}
	cleaned := strings.Trim(prev, "\"'*`")
	cleaned = strings.TrimSpace(cleaned)
	// 故意戏剧打断：以 … / — / -- 收尾不算截断
	if strings.HasSuffix(cleaned, "...") || strings.HasSuffix(cleaned, "…") ||
		strings.HasSuffix(cleaned, "—") || strings.HasSuffix(cleaned, "--") {
		return false
	}
	if danglingTailRE.MatchString(cleaned) {
		return true
	}
	// 裸逗号收尾多半是截断；单独破折号已在上面放过
	if strings.HasSuffix(cleaned, ",") {
		return true
	}
	return false
}

func isCharacterCue(s string) bool {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "*")
	if s == "" || len(s) > 40 {
		return false
	}
	// 去掉 (V.O.) / (O.S.) 后缀再判
	if i := strings.IndexByte(s, '('); i > 0 {
		s = strings.TrimSpace(s[:i])
	}
	letters := 0
	upper := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	if letters < 2 || strings.Contains(s, ".") {
		return false
	}
	// ALL CAPS 角色行，或 Title Case 短名（Ethan / Noah Parker）
	if upper*10 >= letters*8 {
		return true
	}
	words := strings.Fields(s)
	if len(words) == 0 || len(words) > 4 {
		return false
	}
	for _, w := range words {
		rs := []rune(w)
		if len(rs) == 0 || !unicode.IsUpper(rs[0]) {
			return false
		}
	}
	return true
}

// lockedCharacterNames 从策划人物卡抽出必须沿用的英文名。
func lockedCharacterNames(plan map[string]any) []string {
	raw, ok := plan["characters"].([]any)
	if !ok {
		if typed, ok2 := plan["characters"].([]map[string]any); ok2 {
			out := make([]string, 0, len(typed))
			seen := map[string]bool{}
			for _, m := range typed {
				name := strings.TrimSpace(fmt.Sprint(m["name"]))
				if name == "" || name == "<nil>" || seen[strings.ToLower(name)] {
					continue
				}
				seen[strings.ToLower(name)] = true
				out = append(out, name)
			}
			return out
		}
		return nil
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := strings.TrimSpace(fmt.Sprint(m["name"]))
		if name == "" || name == "<nil>" || seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		out = append(out, name)
	}
	return out
}

// ContinuityCard 跨集衔接用的结构化状态（短、可执行），避免塞整段上一集正文。
type ContinuityCard struct {
	LastLocation string
	LastSpeakers []string
	OpenBeat     string // 上一集结尾钩子/未决状态，约数行
	PrevHook     string // 策划里上一集 hook
}

// buildContinuityCard 从上一集正文 + 策划 hook 抽衔接卡；不另调模型。
func buildContinuityCard(prevEpisode string, prevPlanHook string) ContinuityCard {
	card := ContinuityCard{PrevHook: strings.TrimSpace(prevPlanHook)}
	prevEpisode = strings.TrimSpace(prevEpisode)
	if prevEpisode == "" {
		return card
	}
	lines := strings.Split(strings.ReplaceAll(prevEpisode, "\r\n", "\n"), "\n")
	sceneRE := regexp.MustCompile(`(?i)^\s*(\d+\s*-\s*\d+\s+.+)$|^\s*((?:INT\.|EXT\.)\s+.+)$`)
	// ALL CAPS 或 Title Case 角色行
	speakerRE := regexp.MustCompile(`(?i)^\s*\*{0,2}\s*([A-Za-z][A-Za-z0-9' \-]{1,28})\s*\*{0,2}\s*(?:\(|$)`)
	for i := len(lines) - 1; i >= 0; i-- {
		s := strings.TrimSpace(lines[i])
		if s == "" {
			continue
		}
		if m := sceneRE.FindStringSubmatch(s); m != nil {
			loc := strings.TrimSpace(m[1])
			if loc == "" {
				loc = strings.TrimSpace(m[2])
			}
			card.LastLocation = loc
			break
		}
	}
	seen := map[string]bool{}
	for i := len(lines) - 1; i >= 0 && len(card.LastSpeakers) < 4; i-- {
		s := strings.TrimSpace(lines[i])
		m := speakerRE.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		name := strings.TrimSpace(m[1])
		up := strings.ToUpper(name)
		if up == "V.O" || up == "O.S" || up == "CONT'D" || strings.HasPrefix(up, "END OF") ||
			up == "FADE IN" || up == "FADE OUT" || up == "CUT TO" {
			continue
		}
		// 过滤普通句子：至少像专名（首字母大写词）
		if !isCharacterCue(name) && !isCharacterCue(strings.ToUpper(name)) {
			// ALL CAPS 短词仍收
			letters := 0
			upper := 0
			for _, r := range name {
				if unicode.IsLetter(r) {
					letters++
					if unicode.IsUpper(r) {
						upper++
					}
				}
			}
			if letters < 2 || upper*2 < letters {
				continue
			}
		}
		if seen[up] {
			continue
		}
		seen[up] = true
		card.LastSpeakers = append(card.LastSpeakers, name)
	}
	for i, j := 0, len(card.LastSpeakers)-1; i < j; i, j = i+1, j-1 {
		card.LastSpeakers[i], card.LastSpeakers[j] = card.LastSpeakers[j], card.LastSpeakers[i]
	}

	const tailRunes = 500
	runes := []rune(prevEpisode)
	tail := prevEpisode
	if len(runes) > tailRunes {
		tail = string(runes[len(runes)-tailRunes:])
	}
	card.OpenBeat = strings.TrimSpace(tail)
	return card
}

func (c ContinuityCard) Format() string {
	if c.LastLocation == "" && len(c.LastSpeakers) == 0 && c.OpenBeat == "" && c.PrevHook == "" {
		return "(无，本集为开篇)"
	}
	var b strings.Builder
	if c.LastLocation != "" {
		b.WriteString("- last_location: ")
		b.WriteString(c.LastLocation)
		b.WriteByte('\n')
	}
	if len(c.LastSpeakers) > 0 {
		b.WriteString("- present/recent: ")
		b.WriteString(strings.Join(c.LastSpeakers, ", "))
		b.WriteByte('\n')
	}
	if c.PrevHook != "" {
		b.WriteString("- planned_hook: ")
		b.WriteString(c.PrevHook)
		b.WriteByte('\n')
	}
	if c.OpenBeat != "" {
		b.WriteString("- ending_excerpt:\n")
		b.WriteString(c.OpenBeat)
		b.WriteByte('\n')
	}
	return strings.TrimSpace(b.String())
}

func planHook(ep map[string]any) string {
	if ep == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(ep["hook"]))
}

func nextEpisodeOutline(episodes []map[string]any, currentIdx int) string {
	if currentIdx+1 >= len(episodes) {
		return "(本季最后一集：可收束或留季终钩子，但本集内台词必须写完整)"
	}
	ep := episodes[currentIdx+1]
	return fmt.Sprintf("Episode %v — event: %v; hook: %v", ep["number"], ep["event"], ep["hook"])
}
