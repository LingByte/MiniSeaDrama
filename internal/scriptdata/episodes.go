// Copyright (c) 2026 lingbyte. All rights reserved.

package scriptdata

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 兼容 AI 落库脏数据：整剧糊成一集，正文里用 Episode N / 第 N 集 分段。
var episodeHeaderRE = regexp.MustCompile(`(?im)^\s*(?:\*{0,2}\s*)?(?:Episode|EP)\s+(\d+)\s*(?:\*{0,2})?\s*$|^\s*第\s*(\d+)\s*集\b|^\s*#{1,3}\s*Episode\s+(\d+)\b`)

// SplitEpisodeText 按集标题切开正文；切不开则原样返回一集。
func SplitEpisodeText(text string) []map[string]any {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	matches := episodeHeaderRE.FindAllStringSubmatchIndex(text, -1)
	if len(matches) < 2 {
		body := strings.TrimSpace(text)
		if body == "" {
			return nil
		}
		n := EpisodeNumberFromText(body)
		title := "第 1 集"
		if n > 0 {
			title = fmt.Sprintf("第 %d 集", n)
		}
		return []map[string]any{{"title": title, "text": body}}
	}
	out := make([]map[string]any, 0, len(matches))
	for i, m := range matches {
		start := m[1]
		end := len(text)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		body := strings.TrimSpace(text[start:end])
		// 丢掉空壳/重复标题夹心（AI 脏数据常见）
		if len([]rune(body)) < 80 {
			continue
		}
		out = append(out, map[string]any{
			"title": "",
			"text":  body,
		})
	}
	if len(out) == 0 {
		return []map[string]any{{"title": "第 1 集", "text": strings.TrimSpace(text)}}
	}
	RenumberEpisodeTitles(out)
	return out
}

var endEpisodeNumRE = regexp.MustCompile(`(?i)END OF EPISODE\s+(\d+)`)

// EpisodeNumberFromText 从正文提取真实集号（优先 END OF EPISODE N）。
func EpisodeNumberFromText(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	if ms := endEpisodeNumRE.FindAllStringSubmatch(text, -1); len(ms) > 0 {
		n, _ := strconv.Atoi(ms[len(ms)-1][1])
		if n > 0 {
			return n
		}
	}
	if m := episodeHeaderRE.FindStringSubmatch(text); len(m) > 0 {
		for _, g := range m[1:] {
			if g == "" {
				continue
			}
			n, _ := strconv.Atoi(g)
			if n > 0 {
				return n
			}
		}
	}
	return 0
}

// RenumberEpisodeTitles 优先用正文 END OF EPISODE / Episode N；多数无标记时才按数组顺序。
func RenumberEpisodeTitles(eps []map[string]any) {
	if len(eps) == 0 {
		return
	}
	nums := make([]int, len(eps))
	marked := 0
	for i := range eps {
		nums[i] = EpisodeNumberFromText(str(eps[i]["text"]))
		if nums[i] > 0 {
			marked++
		}
	}
	useContent := marked*2 >= len(eps)
	seen := map[int]bool{}
	for i := range eps {
		n := nums[i]
		if useContent && n > 0 && !seen[n] {
			eps[i]["title"] = fmt.Sprintf("第 %d 集", n)
			seen[n] = true
			continue
		}
		eps[i]["title"] = fmt.Sprintf("第 %d 集", i+1)
	}
}

// RenumberScriptEpisodes 校正已落库分集的标题序号；有改动返回 true。
func RenumberScriptEpisodes(script map[string]any) bool {
	if script == nil {
		return false
	}
	changed := false
	apply := func(eps []map[string]any) {
		before := make([]string, len(eps))
		for i := range eps {
			before[i] = str(eps[i]["title"])
		}
		RenumberEpisodeTitles(eps)
		for i := range eps {
			if str(eps[i]["title"]) != before[i] {
				changed = true
			}
		}
	}
	switch eps := script["episodes"].(type) {
	case []map[string]any:
		apply(eps)
	case []any:
		mapped := make([]map[string]any, 0, len(eps))
		for i := range eps {
			m, ok := eps[i].(map[string]any)
			if !ok {
				continue
			}
			mapped = append(mapped, m)
		}
		apply(mapped)
	}
	return changed
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func episodeText(ep any) string {
	switch m := ep.(type) {
	case map[string]any:
		if t, ok := m["text"].(string); ok {
			return t
		}
	case map[string]string:
		return m["text"]
	}
	return ""
}

func episodeCount(raw any) int {
	switch eps := raw.(type) {
	case []any:
		return len(eps)
	case []map[string]any:
		return len(eps)
	default:
		return 0
	}
}

// NormalizeEpisodes 修复「单集塞整剧」：能切出 ≥2 集则替换 episodes，并校正 total/trial。
// 返回是否发生了拆分。
func NormalizeEpisodes(script map[string]any) bool {
	if script == nil {
		return false
	}
	raw := script["episodes"]
	n := episodeCount(raw)
	var blob string
	switch eps := raw.(type) {
	case []any:
		if n == 1 {
			blob = episodeText(eps[0])
		} else if n == 0 {
			return false
		} else {
			return false
		}
	case []map[string]any:
		if n == 1 {
			if t, ok := eps[0]["text"].(string); ok {
				blob = t
			}
		} else {
			return false
		}
	default:
		return false
	}
	if len([]rune(blob)) < 4000 {
		return false
	}
	split := SplitEpisodeText(blob)
	if len(split) < 2 {
		return false
	}
	script["episodes"] = split
	total := asInt(script["totalEpisodes"])
	if total <= 1 || total < len(split) {
		script["totalEpisodes"] = len(split)
	}
	trial := asInt(script["trialCount"])
	if trial <= 1 {
		keep := 3
		if len(split) < keep {
			keep = len(split)
		}
		script["trialCount"] = keep
	}
	return true
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(n)
		return i
	default:
		return 0
	}
}
