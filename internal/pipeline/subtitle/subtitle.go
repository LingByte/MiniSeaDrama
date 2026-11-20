// Copyright (c) 2026 lingbyte. All rights reserved.

package subtitle

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Segment is a timed subtitle cue.
type Segment struct {
	StartMs int
	EndMs   int
	Text    string
}

var (
	// HH:MM:SS.mmm / H:MM:SS,mmm（SRT / 完整 VTT）
	timeREHMS = regexp.MustCompile(`(?i)^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?`)
	// MM:SS.mmm（ShortFlix / 部分播放器导出的短格式 VTT）
	timeREMS = regexp.MustCompile(`(?i)^(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`)
	arrowRE  = regexp.MustCompile(`-->`)
	tagRE    = regexp.MustCompile(`(?s)<[^>]+>`)
	wsRE     = regexp.MustCompile(`\s+`)
	latinRE  = regexp.MustCompile(`[A-Za-z]`)
)

func parseFracMS(frac string) int {
	if frac == "" {
		return 0
	}
	for len(frac) < 3 {
		frac += "0"
	}
	if len(frac) > 3 {
		frac = frac[:3]
	}
	ms, _ := strconv.Atoi(frac)
	return ms
}

func parseClock(s string) (int, error) {
	s = strings.TrimSpace(s)
	if m := timeREHMS.FindStringSubmatch(s); m != nil {
		h, _ := strconv.Atoi(m[1])
		mi, _ := strconv.Atoi(m[2])
		sec, _ := strconv.Atoi(m[3])
		return ((h*60+mi)*60+sec)*1000 + parseFracMS(m[4]), nil
	}
	if m := timeREMS.FindStringSubmatch(s); m != nil {
		mi, _ := strconv.Atoi(m[1])
		sec, _ := strconv.Atoi(m[2])
		return (mi*60+sec)*1000 + parseFracMS(m[3]), nil
	}
	return 0, fmt.Errorf("bad time: %s", s)
}

func FormatClock(ms int) string {
	if ms < 0 {
		ms = 0
	}
	h := ms / 3600000
	ms %= 3600000
	m := ms / 60000
	ms %= 60000
	s := ms / 1000
	ms %= 1000
	return fmt.Sprintf("%02d:%02d:%02d,%03d", h, m, s, ms)
}

// ParseSubtitleFile parses SRT or VTT content from disk.
func ParseSubtitleFile(path string) ([]Segment, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseSubtitle(string(data)), nil
}

// ParseSubtitle parses SRT/VTT text.
func ParseSubtitle(content string) []Segment {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.TrimPrefix(content, "\ufeff")
	if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(content)), "WEBVTT") {
		content = stripWebVTTHeader(content)
	}
	blocks := strings.Split(content, "\n\n")
	var segs []Segment
	for _, block := range blocks {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) == 0 {
			continue
		}
		idx := 0
		if !arrowRE.MatchString(lines[0]) && len(lines) > 1 && arrowRE.MatchString(lines[1]) {
			idx = 1
		}
		if idx >= len(lines) || !arrowRE.MatchString(lines[idx]) {
			continue
		}
		parts := arrowRE.Split(lines[idx], 2)
		if len(parts) != 2 {
			continue
		}
		start, err1 := parseClock(parts[0])
		end, err2 := parseClock(strings.Fields(parts[1])[0])
		if err1 != nil || err2 != nil {
			continue
		}
		textLines := lines[idx+1:]
		var cleaned []string
		for _, l := range textLines {
			l = tagRE.ReplaceAllString(l, "")
			l = strings.TrimSpace(l)
			if l != "" {
				cleaned = append(cleaned, l)
			}
		}
		text := strings.Join(cleaned, " ")
		text = wsRE.ReplaceAllString(text, " ")
		if text == "" {
			continue
		}
		segs = append(segs, Segment{StartMs: start, EndMs: end, Text: text})
	}
	return segs
}

func stripWebVTTHeader(content string) string {
	lines := strings.Split(content, "\n")
	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])
		i++
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToUpper(line), "WEBVTT") {
			continue
		}
		if strings.Contains(line, ":") && !arrowRE.MatchString(line) {
			continue
		}
		break
	}
	return strings.Join(lines[i:], "\n")
}

// OffsetSegments shifts all cues by offsetMs.
func OffsetSegments(segs []Segment, offsetMs int) []Segment {
	out := make([]Segment, len(segs))
	for i, s := range segs {
		out[i] = Segment{StartMs: s.StartMs + offsetMs, EndMs: s.EndMs + offsetMs, Text: s.Text}
	}
	return out
}

// DedupeSegments removes near-duplicate consecutive cues.
func DedupeSegments(segs []Segment) []Segment {
	if len(segs) == 0 {
		return segs
	}
	out := []Segment{segs[0]}
	for _, s := range segs[1:] {
		prev := out[len(out)-1]
		if strings.EqualFold(prev.Text, s.Text) && s.StartMs-prev.EndMs < 400 {
			if s.EndMs > prev.EndMs {
				out[len(out)-1].EndMs = s.EndMs
			}
			continue
		}
		out = append(out, s)
	}
	return out
}

// SegmentsToSRT renders SRT text.
func SegmentsToSRT(segs []Segment) string {
	var b strings.Builder
	for i, s := range segs {
		fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", i+1, FormatClock(s.StartMs), FormatClock(s.EndMs), s.Text)
	}
	return b.String()
}

// SegmentsToParagraphs joins cues into readable paragraphs.
func SegmentsToParagraphs(segs []Segment) string {
	var parts []string
	for _, s := range segs {
		parts = append(parts, s.Text)
	}
	return strings.Join(parts, " ")
}

// DialogueRuneCount counts non-header dialogue runes in a merged transcript.
// Episode N headers are ignored so empty merges don't look "long".
func DialogueRuneCount(transcript string) int {
	var n int
	for _, line := range strings.Split(transcript, "\n") {
		trim := strings.TrimSpace(line)
		if trim == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(trim), "episode ") {
			continue
		}
		n += len([]rune(trim))
	}
	return n
}

// LooksEnglish heuristics for official EN tracks.
func LooksEnglish(content string) bool {
	letters, latin := 0, 0
	for _, r := range content {
		if unicode.IsLetter(r) {
			letters++
			if r <= unicode.MaxASCII && ((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')) {
				latin++
			}
		}
	}
	if letters < 20 {
		return latinRE.MatchString(content)
	}
	return float64(latin)/float64(letters) > 0.55
}

// TitleIsEnglish checks subtitle track title.
func TitleIsEnglish(title string) bool {
	t := strings.ToLower(title)
	return strings.Contains(t, "en") || strings.Contains(t, "english") || strings.Contains(t, "eng")
}

// TitleIsOtherLanguage rejects Chinese track titles.
func TitleIsOtherLanguage(title string) bool {
	t := strings.ToLower(title)
	return strings.Contains(t, "zh") || strings.Contains(t, "chi") || strings.Contains(t, "中") || strings.Contains(t, "cn")
}


// TitleIsEnglish is kept for callers; SubtitleTitleIsEnglish is an alias.
func SubtitleTitleIsEnglish(title string) bool { return TitleIsEnglish(title) }

// SubtitleTitleIsOtherLanguage aliases TitleIsOtherLanguage.
func SubtitleTitleIsOtherLanguage(title string) bool { return TitleIsOtherLanguage(title) }
