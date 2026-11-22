// Copyright (c) 2026 lingbyte. All rights reserved.

package scriptdata

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 已是至简海漫场次头：1-1 LOCATION [INT.] [NIGHT]
var houseSceneRE = regexp.MustCompile(`(?i)^\s*\d+\s*-\s*\d+\s+.+\[(?:INT|EXT)\.?\]\s*\[(?:DAY|NIGHT|MORNING|EVENING|CONTINUOUS)`)

// 好莱坞场次头前缀：INT. / EXT. / INT./EXT.
var hollywoodPrefixRE = regexp.MustCompile(`(?i)^\*{0,2}\s*(INT\.?\s*/\s*EXT\.?|EXT\.?\s*/\s*INT\.?|INT\.?|EXT\.?)\s+(.+)$`)

// NormalizeSceneHeaders 把 INT./EXT. 场次头改成「集号-场号 LOCATION [INT.] [NIGHT]」。
func NormalizeSceneHeaders(text string, epNum int) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	if epNum < 1 {
		epNum = 1
	}
	scene := 0
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if houseSceneRE.MatchString(trimmed) {
			scene++
			out = append(out, trimmed)
			continue
		}
		if converted, ok := convertHollywoodSlug(trimmed, epNum, &scene); ok {
			out = append(out, converted)
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func convertHollywoodSlug(line string, epNum int, scene *int) (string, bool) {
	m := hollywoodPrefixRE.FindStringSubmatch(line)
	if m == nil {
		return "", false
	}
	rest := strings.TrimSpace(m[2])
	rest = strings.Trim(rest, "*")
	rest = strings.TrimSpace(rest)
	if rest == "" {
		return "", false
	}

	// 最后一个 - / – / — 分隔地点与时段（支持 ROMANO MANSION - MASTER BEDROOM - NIGHT）
	sep := strings.LastIndexAny(rest, "-–—")
	if sep < 0 {
		return "", false
	}
	_, sepSize := utf8.DecodeRuneInString(rest[sep:])
	loc := strings.TrimSpace(rest[:sep])
	timeRaw := strings.TrimSpace(rest[sep+sepSize:])
	if loc == "" || timeRaw == "" {
		return "", false
	}

	ieRaw := strings.ToUpper(strings.ReplaceAll(m[1], " ", ""))
	ie := "INT."
	if strings.Contains(ieRaw, "EXT") && strings.Contains(ieRaw, "INT") {
		ie = "INT./EXT."
	} else if strings.HasPrefix(ieRaw, "EXT") {
		ie = "EXT."
	}
	loc = strings.ReplaceAll(loc, " - ", " – ")
	loc = strings.ReplaceAll(loc, " — ", " – ")
	loc = strings.ToUpper(loc)
	tod := normalizeTimeOfDay(timeRaw)

	*scene++
	return fmt.Sprintf("%d-%d %s [%s] [%s]", epNum, *scene, loc, ie, tod), true
}

func normalizeTimeOfDay(raw string) string {
	u := strings.ToUpper(strings.TrimSpace(raw))
	// 去掉括号补充：DAY (NEXT MORNING) → 以主时段为准
	main := u
	if i := strings.IndexByte(main, '('); i >= 0 {
		main = strings.TrimSpace(main[:i])
	}
	switch {
	case strings.Contains(main, "NIGHT") || strings.Contains(main, "EVENING") || strings.Contains(main, "DUSK") || strings.Contains(main, "MIDNIGHT"):
		return "NIGHT"
	case strings.Contains(main, "DAY") || strings.Contains(main, "MORNING") || strings.Contains(main, "AFTERNOON") || strings.Contains(main, "DAWN") || strings.Contains(main, "NOON"):
		return "DAY"
	case strings.Contains(main, "CONTINUOUS") || strings.Contains(main, "LATER") || strings.Contains(main, "MOMENTS"):
		// 对照样稿只用 DAY/NIGHT；连续场默认 DAY，避免丢场次头
		return "DAY"
	default:
		if main == "" {
			return "DAY"
		}
		// 未知时段：尽量压成 DAY/NIGHT 单词
		parts := strings.Fields(main)
		if len(parts) > 0 {
			p := parts[0]
			if p == "NIGHT" || p == "DAY" {
				return p
			}
		}
		return "DAY"
	}
}

// NormalizeScriptSceneHeaders 按各集真实集号改写场次头；有改动返回 true。
func NormalizeScriptSceneHeaders(script map[string]any) bool {
	if script == nil {
		return false
	}
	changed := false
	apply := func(eps []map[string]any) {
		for i := range eps {
			before := str(eps[i]["text"])
			epNum := EpisodeNumberFromText(before)
			if epNum < 1 {
				if m := titleEpRE.FindStringSubmatch(str(eps[i]["title"])); len(m) > 1 {
					epNum, _ = strconv.Atoi(m[1])
				}
			}
			if epNum < 1 {
				epNum = i + 1
			}
			after := NormalizeSceneHeaders(before, epNum)
			if after != before {
				eps[i]["text"] = after
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
		script["episodes"] = mapped
	}
	return changed
}

var titleEpRE = regexp.MustCompile(`第\s*(\d+)\s*集`)
