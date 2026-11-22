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
	danglingTailRE     = regexp.MustCompile(`(?i)\b(the|a|an|and|or|but|to|of|for|with|that|this|is|are|was|were|be|been|have|has|had|will|would|can|could|should|may|might|i|you|he|she|we|they|my|your|his|her)\s*$`)
)

// episodeQualityError 单集正文不合格原因（可重试）。
type episodeQualityError struct{ Reason string }

func (e episodeQualityError) Error() string { return e.Reason }

// validateEpisodeText 检查单集是否可落盘：有 END、够长、未中途截断、有场次。
func validateEpisodeText(text string, n int) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return episodeQualityError{"正文为空"}
	}
	if truncatedMarkerRE.MatchString(text) {
		return episodeQualityError{"模型输出被 max_tokens 截断"}
	}
	if llmRefusalRE.MatchString(text) && len([]rune(text)) < 2500 {
		return episodeQualityError{"疑似模型拒写"}
	}
	runes := len([]rune(text))
	if runes < 1200 {
		return episodeQualityError{fmt.Sprintf("正文过短（%d 字）", runes)}
	}
	endRE := regexp.MustCompile(fmt.Sprintf(`(?i)END\s+OF\s+EPISODE\s+%d\b`, n))
	if !endRE.MatchString(text) {
		return episodeQualityError{fmt.Sprintf("缺少 END OF EPISODE %d", n)}
	}
	if !sceneHouseRE.MatchString(text) && !regexp.MustCompile(`(?im)^\s*(?:\*{0,2}\s*)?(?:INT\.|EXT\.)`).MatchString(text) {
		return episodeQualityError{"缺少场次头（X-Y … 或 INT./EXT.）"}
	}
	if looksTruncatedBeforeEnd(text, n) {
		return episodeQualityError{"END 前台词像被截断（半截句）"}
	}
	return nil
}

// looksTruncatedBeforeEnd：END 上一行内容以冠词/介词/连词结尾，或明显半截。
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
		if s == "" || s == "---" || s == "***" || strings.EqualFold(s, "FADE TO BLACK.") || strings.EqualFold(s, "FADE TO BLACK") {
			continue
		}
		prev = s
		break
	}
	if prev == "" {
		return true
	}
	// 去掉说话人行（全大写短词）后再判
	if isCharacterCue(prev) {
		return true // END 前只剩角色名 → 台词被截
	}
	cleaned := strings.Trim(prev, "\"'*`")
	cleaned = strings.TrimSpace(cleaned)
	if danglingTailRE.MatchString(cleaned) {
		return true
	}
	// 以逗号、破折号、省略未完成感结尾
	if strings.HasSuffix(cleaned, ",") || strings.HasSuffix(cleaned, "—") || strings.HasSuffix(cleaned, "-") {
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
	return letters >= 2 && upper*10 >= letters*8 && !strings.Contains(s, ".")
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
	speakerRE := regexp.MustCompile(`(?i)^\s*\*{0,2}\s*([A-Z][A-Z0-9' \-]{1,28})\s*\*{0,2}\s*(?:\(|$)`)
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
		if up == "V.O" || up == "O.S" || up == "CONT'D" || strings.HasPrefix(up, "END OF") {
			continue
		}
		if seen[up] {
			continue
		}
		seen[up] = true
		card.LastSpeakers = append(card.LastSpeakers, name)
	}
	// 倒序取出的说话人再正回来，读起来自然
	for i, j := 0, len(card.LastSpeakers)-1; i < j; i, j = i+1, j-1 {
		card.LastSpeakers[i], card.LastSpeakers[j] = card.LastSpeakers[j], card.LastSpeakers[i]
	}

	// 结尾节选：只要最后约 500 字，足够看见钩子，不抢本集上下文
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
