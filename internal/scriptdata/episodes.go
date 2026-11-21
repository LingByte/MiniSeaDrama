// Copyright (c) 2026 lingbyte. All rights reserved.

package scriptdata

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 兼容 AI 落库脏数据：整剧糊成一集，正文里用 Episode N / 第 N 集 分段。
var episodeHeaderRE = regexp.MustCompile(`(?im)^\s*(?:\*{0,2}\s*)?(?:Episode|EP)\s+(\d+)\s*(?:\*{0,2})?\s*$|^\s*第\s*(\d+)\s*集\b`)

// SplitEpisodeText 按集标题切开正文；切不开则原样返回一集。
func SplitEpisodeText(text string) []map[string]any {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	matches := episodeHeaderRE.FindAllStringSubmatchIndex(text, -1)
	if len(matches) < 2 {
		body := strings.TrimSpace(text)
		if body == "" {
			return nil
		}
		return []map[string]any{{"title": "第 1 集", "text": body}}
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
			"title": "", // 下面按顺序重编号，不沿用源稿 Episode 4/5/6
			"text":  body,
		})
	}
	if len(out) == 0 {
		return []map[string]any{{"title": "第 1 集", "text": strings.TrimSpace(text)}}
	}
	RenumberEpisodeTitles(out)
	return out
}

// RenumberEpisodeTitles 按数组顺序写成「第 1 集」「第 2 集」…，避免源稿缺集导致「EP01=第4集」。
func RenumberEpisodeTitles(eps []map[string]any) {
	for i := range eps {
		eps[i]["title"] = fmt.Sprintf("第 %d 集", i+1)
	}
}

// RenumberScriptEpisodes 校正已落库分集的标题序号；有改动返回 true。
func RenumberScriptEpisodes(script map[string]any) bool {
	if script == nil {
		return false
	}
	changed := false
	switch eps := script["episodes"].(type) {
	case []map[string]any:
		for i := range eps {
			want := fmt.Sprintf("第 %d 集", i+1)
			if str(eps[i]["title"]) != want {
				eps[i]["title"] = want
				changed = true
			}
		}
	case []any:
		for i := range eps {
			m, ok := eps[i].(map[string]any)
			if !ok {
				continue
			}
			want := fmt.Sprintf("第 %d 集", i+1)
			if str(m["title"]) != want {
				m["title"] = want
				changed = true
			}
		}
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
