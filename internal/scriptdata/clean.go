// Copyright (c) 2026 lingbyte. All rights reserved.

package scriptdata

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	codeFenceRE = regexp.MustCompile(`(?i)^` + "```" + `[a-zA-Z]*\s*$`)
	watermarkRE = regexp.MustCompile(`(?i)(` +
		`由\s*(?:AI|人工智能|大模型|ChatGPT|Claude|GPT).{0,20}(?:生成|创作|撰写|辅助)` +
		`|(?:AI|人工智能|大模型|ChatGPT|Claude|GPT|机器)\s*(?:生成|创作|撰写|写作)` +
		`|(?:generated|created|written)\s+(?:by|with)\s+(?:AI|ChatGPT|Claude|GPT)` +
		`|AI[- ]generated` +
		`|本(?:剧本|文档|作品|内容).{0,20}(?:AI|人工智能).{0,20}` +
		`)`)
	// 模型把「交付说明 / thinking / 写作计划」拼进正文——整段砍掉
	thinkingBlockRE   = regexp.MustCompile(`(?is)<thinking>.*?</thinking>`)
	htmlTagRE         = regexp.MustCompile(`(?i)</?(?:p|b|i|strong|em|br|div|span|h[1-6])\b[^>]*>`)
	endEpisodeAnyRE   = regexp.MustCompile(`(?i)END OF (?:EPISODE\s+\d+|SERIES)`)
	metaAnywhereRE    = regexp.MustCompile(`(?i)(?:` +
		`交付说明|交付准备|集数交付|完成交付|最终交付|文件夹位置|两个文件|创作决策|关键决策|本批次完成|已完成内容|定集数` +
		`|I'm writing the full|Due to output length|Status:\s*Writing|Writing Episodes|Generating deliverables` +
		`|token requirement|Word-format|Word\s*文档|Word文件|剧本\.docx|设定\.docx|剧本设定\.docx` +
		`|由于篇幅|一气呵成|写作中|自检每集|继续一气呵成|现在开始制作|现在生成|格式确认完毕|开始创作` +
		`|Let me start|I'll now (?:create|compile|generate)|一次性写完` +
		`|按规范交付|准备 Word|完成交付准备` +
		`)`)
	metaLineRE = regexp.MustCompile(`(?i)^\s*(?:#{1,6}\s*)?(?:\*{0,2})?(?:` +
		`交付说明|交付准备|集数交付|完成交付|最终交付|文件夹位置|两个文件|创作决策|关键决策|本批次完成|已完成内容|定集数` +
		`|I'm writing the full|Due to output length|Status:\s*Writing|Writing Episodes|Generating deliverables` +
		`|token requirement|Word-format|Word\s*文档|Word文件|剧本\.docx|设定\.docx` +
		`|由于篇幅|一气呵成|写作中|自检每集|继续一气呵成|现在开始制作|现在生成|格式确认完毕|开始创作` +
		`|Let me start|I'll now (?:create|compile|generate)|一次性写完` +
		`|</?thinking>` +
		`)`)
	nextSceneRE   = regexp.MustCompile(`(?im)^\s*(?:\*{0,2})?(?:INT\.|EXT\.|\d+\s*-\s*\d+\s+\S)`)
	nextEpisodeRE = regexp.MustCompile(`(?im)^\s*(?:\*{0,2}\s*)?(?:Episode|EP)\s+\d+|^\s*#{1,3}\s*EPISODE\s+\d+`)
)

// CleanEpisodeText 去掉 AI 水印、thinking、交付说明等拼进正文的垃圾。
func CleanEpisodeText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = thinkingBlockRE.ReplaceAllString(text, "")
	// 轻量去 HTML 壳，便于识别 END OF EPISODE / 交付说明
	text = htmlTagRE.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "&nbsp;", " ")

	var lines []string
	for _, line := range strings.Split(text, "\n") {
		stripped := strings.TrimSpace(line)
		if codeFenceRE.MatchString(stripped) {
			continue
		}
		if stripped != "" && watermarkRE.MatchString(stripped) {
			continue
		}
		lines = append(lines, strings.TrimRight(line, " \t"))
	}
	text = strings.Join(lines, "\n")
	text = stripInlineDeliveryBlocks(text)
	text = truncateMetaTail(text)
	text = trimAfterLastEndOfEpisode(text)
	return strings.TrimSpace(text)
}

// trimAfterLastEndOfEpisode 砍掉 END OF EPISODE N 后粘上的下一集头（如 END OF EPISODE 2****Episode 3）。
func trimAfterLastEndOfEpisode(text string) string {
	locs := endEpisodeAnyRE.FindAllStringIndex(text, -1)
	if len(locs) == 0 {
		return text
	}
	last := locs[len(locs)-1]
	endTok := text[last[0]:last[1]]
	rest := text[last[1]:]
	// 同行垃圾：****Episode 3 / **Episode 3
	cut := 0
	for cut < len(rest) {
		r := rest[cut]
		if r == '\n' {
			cut++
			break
		}
		if r == '*' || r == '#' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			// 同行已开始下一集标题 → 丢弃同行剩余
			return strings.TrimRight(text[:last[0]]+endTok, " \t") + "\n"
		}
		cut++
	}
	after := rest[cut:]
	if episodeHeaderLooseRE.MatchString(strings.TrimSpace(after)) ||
		strings.HasPrefix(strings.ToUpper(strings.TrimSpace(after)), "EPISODE") {
		return strings.TrimRight(text[:last[0]]+endTok, " \t") + "\n"
	}
	return text
}

var episodeHeaderLooseRE = regexp.MustCompile(`(?i)^\*{0,2}\s*(?:Episode|EP)\s+\d+`)

// stripInlineDeliveryBlocks 去掉夹在两集之间的「交付说明」等（多集糊在一段时常见）。
func stripInlineDeliveryBlocks(text string) string {
	locs := endEpisodeAnyRE.FindAllStringIndex(text, -1)
	if len(locs) == 0 {
		return text
	}
	var b strings.Builder
	prev := 0
	for _, loc := range locs {
		// 含 END 行末换行
		lineEnd := loc[1]
		if i := strings.IndexByte(text[lineEnd:], '\n'); i >= 0 {
			lineEnd = lineEnd + i + 1
		} else {
			lineEnd = len(text)
		}
		b.WriteString(text[prev:lineEnd])
		restStart := lineEnd
		// 找下一段剧本起点：下一场 / 下一集 / 下一个 END
		nextScript := len(text)
		tail := text[restStart:]
		for _, re := range []*regexp.Regexp{nextSceneRE, nextEpisodeRE, endEpisodeAnyRE} {
			if m := re.FindStringIndex(tail); m != nil && restStart+m[0] < nextScript {
				nextScript = restStart + m[0]
			}
		}
		between := text[restStart:nextScript]
		if firstMetaOffset(between) >= 0 || looksLikeDeliveryChunk(between) {
			// 丢掉夹心说明，只保留空行分隔
			if !strings.HasSuffix(b.String(), "\n") {
				b.WriteByte('\n')
			}
			b.WriteByte('\n')
		} else {
			b.WriteString(between)
		}
		prev = nextScript
	}
	if prev < len(text) {
		tail := text[prev:]
		if firstMetaOffset(tail) >= 0 || looksLikeDeliveryChunk(tail) {
			// drop trailing meta
		} else {
			b.WriteString(tail)
		}
	}
	return b.String()
}

func looksLikeDeliveryChunk(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || strings.Trim(s, " \t\n-—–*_") == "" {
		return false
	}
	if firstMetaOffset(s) >= 0 {
		return true
	}
	han := 0
	for _, r := range s {
		if r >= 0x4e00 && r <= 0x9fff {
			han++
			if han >= 20 {
				return true
			}
		}
	}
	return false
}

// truncateMetaTail：正文在最后一个 END OF EPISODE / SERIES 之后若出现交付说明等，从该处截断。
func truncateMetaTail(text string) string {
	if loc := endEpisodeAnyRE.FindAllStringIndex(text, -1); len(loc) > 0 {
		last := loc[len(loc)-1]
		// 截到该标记所在行末
		end := last[1]
		if i := strings.IndexByte(text[end:], '\n'); i >= 0 {
			end = end + i
		} else {
			end = len(text)
		}
		head := text[:end]
		tail := ""
		if end < len(text) {
			tail = text[end:]
		}
		if cut := firstMetaOffset(tail); cut >= 0 {
			return strings.TrimSpace(head + tail[:cut])
		}
		// 集尾后若全是分隔线/空白，也去掉
		if strings.TrimSpace(strings.Trim(tail, " \t\n-—–*_")) == "" {
			return strings.TrimSpace(head)
		}
		return strings.TrimSpace(head + stripLeadingSeparators(tail))
	}
	// 没有集尾标记：正文中途冒出交付说明则砍掉
	if cut := firstMetaOffset(text); cut >= 200 {
		return strings.TrimSpace(text[:cut])
	}
	return text
}

func firstMetaOffset(text string) int {
	best := -1
	if loc := metaAnywhereRE.FindStringIndex(text); loc != nil {
		best = loc[0]
	}
	// 行首匹配可能更靠前（含 ## 交付）
	offset := 0
	for _, line := range strings.Split(text, "\n") {
		s := strings.TrimSpace(line)
		if s != "" && (metaLineRE.MatchString(s) || looksLikeDeliveryProse(s)) {
			if best < 0 || offset < best {
				best = offset
			}
			break
		}
		offset += len(line) + 1
	}
	return best
}

func stripLeadingSeparators(tail string) string {
	var b strings.Builder
	started := false
	for _, line := range strings.Split(tail, "\n") {
		s := strings.TrimSpace(line)
		if !started {
			if s == "" || s == "---" || s == "***" || s == "___" || strings.Trim(s, "-=*_—–") == "" {
				continue
			}
			if looksLikeDeliveryProse(s) || metaLineRE.MatchString(s) {
				return ""
			}
			started = true
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(line)
	}
	return b.String()
}

func looksLikeDeliveryProse(s string) bool {
	if metaLineRE.MatchString(s) {
		return true
	}
	lower := strings.ToLower(s)
	needles := []string{
		"交付说明", "文件夹", "剧本.docx", "设定.docx", "写作中", "自检",
		"i'm writing the full", "due to output length", "generating deliverables",
		"token requirement", "compile the complete script", "both deliverable",
		"fill入上架", "按规范交付", "word 文档交付", "准备 word",
	}
	for _, n := range needles {
		if strings.Contains(lower, strings.ToLower(n)) || strings.Contains(s, n) {
			return true
		}
	}
	// 大段中文说明（剧本正文应是英文场次）
	han := 0
	for _, r := range s {
		if r >= 0x4e00 && r <= 0x9fff {
			han++
		}
	}
	if han >= 12 && !strings.Contains(s, "INT.") && !strings.Contains(s, "EXT.") {
		return true
	}
	return false
}

var sceneNumRE = regexp.MustCompile(`(?i)^\d+\s*-\s*\d+\s+`)

func sceneish(s string) bool {
	u := strings.ToUpper(strings.TrimSpace(s))
	return strings.HasPrefix(u, "INT.") || strings.HasPrefix(u, "EXT.") ||
		strings.HasPrefix(u, "**INT.") || strings.HasPrefix(u, "**EXT.") ||
		sceneNumRE.MatchString(s)
}

// CleanScriptEpisodes 清洗正文、拆开「多集糊一段」、按 END OF EPISODE 重标标题；有改动返回 true。
func CleanScriptEpisodes(script map[string]any) bool {
	if script == nil {
		return false
	}
	changed := false
	var mapped []map[string]any
	switch eps := script["episodes"].(type) {
	case []map[string]any:
		mapped = eps
	case []any:
		mapped = make([]map[string]any, 0, len(eps))
		for i := range eps {
			m, ok := eps[i].(map[string]any)
			if !ok {
				continue
			}
			mapped = append(mapped, m)
		}
	default:
		return false
	}

	out := make([]map[string]any, 0, len(mapped))
	for i := range mapped {
		before := str(mapped[i]["text"])
		after := CleanEpisodeText(before)
		if after != before {
			changed = true
		}
		parts := splitTextByEndOfEpisode(after)
		if len(parts) >= 2 {
			changed = true
			for _, p := range parts {
				out = append(out, map[string]any{"title": "", "text": p})
			}
			continue
		}
		out = append(out, map[string]any{"title": str(mapped[i]["title"]), "text": after})
	}
	if len(out) == 0 {
		return changed
	}
	RenumberEpisodeTitles(out)
	// 场次头：INT. LOC - NIGHT → 1-1 LOC [INT.] [NIGHT]
	for i := range out {
		before := str(out[i]["text"])
		epNum := EpisodeNumberFromText(before)
		if epNum < 1 {
			if m := titleEpRE.FindStringSubmatch(str(out[i]["title"])); len(m) > 1 {
				epNum, _ = strconv.Atoi(m[1])
			}
		}
		if epNum < 1 {
			epNum = i + 1
		}
		after := NormalizeSceneHeaders(before, epNum)
		if after != before {
			out[i]["text"] = after
			changed = true
		}
	}
	script["episodes"] = out
	if total := asInt(script["totalEpisodes"]); total < len(out) {
		script["totalEpisodes"] = len(out)
		changed = true
	}
	return changed
}

// splitTextByEndOfEpisode 按 END OF EPISODE N 切开糊在一起的多集正文。
func splitTextByEndOfEpisode(text string) []string {
	text = strings.TrimSpace(text)
	locs := endEpisodeAnyRE.FindAllStringIndex(text, -1)
	if len(locs) < 2 {
		return nil
	}
	var parts []string
	start := 0
	for _, loc := range locs {
		end := loc[1]
		if i := strings.IndexByte(text[end:], '\n'); i >= 0 {
			end = end + i
		} else {
			end = len(text)
		}
		chunk := strings.TrimSpace(text[start:end])
		if len([]rune(chunk)) >= 80 {
			parts = append(parts, chunk)
		}
		start = end
		for start < len(text) && (text[start] == '\n' || text[start] == ' ' || text[start] == '\t' || text[start] == '\r') {
			start++
		}
		// 跳过单独的 --- 分隔行
		if start < len(text) {
			rest := text[start:]
			if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
				line := strings.TrimSpace(rest[:nl])
				if line == "---" || line == "***" || strings.Trim(line, "-=*_—–") == "" {
					start += nl + 1
				}
			}
		}
	}
	if len(parts) < 2 {
		return nil
	}
	return parts
}
