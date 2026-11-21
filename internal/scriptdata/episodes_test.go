package scriptdata

import (
	"strings"
	"testing"
)

func TestSplitEpisodeText(t *testing.T) {
	pad := strings.Repeat("scene line with enough body content here. ", 5)
	raw := "chat preamble\n\n**Episode 1**\n\nHello one " + pad + "\n\n**Episode 2**\n\nHello two " + pad + "\n\n**Episode 3**\n\nHello three " + pad + "\n"
	eps := SplitEpisodeText(raw)
	if len(eps) != 3 {
		t.Fatalf("want 3 got %d", len(eps))
	}
	if eps[0]["title"] != "第 1 集" || !strings.HasPrefix(eps[0]["text"].(string), "Hello one") {
		t.Fatalf("ep1 %+v", eps[0])
	}
	if !strings.HasPrefix(eps[2]["text"].(string), "Hello three") {
		t.Fatalf("ep3 %+v", eps[2])
	}
}

func TestNormalizeEpisodes(t *testing.T) {
	body := strings.Repeat("scene line with enough body content here. ", 40)
	blob := "**Episode 1**\n\nA " + body + "\n\n**Episode 2**\n\nB " + body + "\n\n**Episode 3**\n\nC " + body + "\n\n**Episode 4**\n\nD " + body + "\n"
	script := map[string]any{
		"totalEpisodes": 1,
		"trialCount":    1,
		"episodes": []any{
			map[string]any{"title": "第 1 集", "text": blob},
		},
	}
	if !NormalizeEpisodes(script) {
		t.Fatal("expected normalize")
	}
	eps, _ := script["episodes"].([]map[string]any)
	if len(eps) < 4 {
		t.Fatalf("eps=%d", len(eps))
	}
	if script["trialCount"].(int) != 3 {
		t.Fatalf("trial=%v", script["trialCount"])
	}
	if script["totalEpisodes"].(int) < 4 {
		t.Fatalf("total=%v", script["totalEpisodes"])
	}
}
