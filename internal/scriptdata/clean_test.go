// Copyright (c) 2026 lingbyte. All rights reserved.

package scriptdata

import (
	"strings"
	"testing"
)

func TestCleanEpisodeTextStripsDeliveryTail(t *testing.T) {
	raw := "INT. ROOM - NIGHT\n\nLIN: Hello.\n\n— END OF EPISODE 42 —\n\n---\n\nI'm writing the full 42-episode script systematically. Given the token requirement,\n写作中... 自检每集的：\n文件夹 The Hidden Heir/\n"
	got := CleanEpisodeText(raw)
	if strings.Contains(got, "I'm writing") || strings.Contains(got, "写作中") || strings.Contains(got, "文件夹") {
		t.Fatalf("meta still present: %q", got)
	}
	if !strings.Contains(got, "END OF EPISODE 42") {
		t.Fatalf("lost episode end: %q", got)
	}
	if !strings.Contains(got, "LIN: Hello.") {
		t.Fatalf("lost body: %q", got)
	}
}

func TestCleanEpisodeTextStripsThinkingBlock(t *testing.T) {
	raw := "INT. A\n\nHi.\n\n<thinking>\n用户给了策划摘要\n</thinking>\n\nEND OF EPISODE 1\n"
	got := CleanEpisodeText(raw)
	if strings.Contains(got, "thinking") || strings.Contains(got, "策划") {
		t.Fatalf("thinking left: %q", got)
	}
}

func TestCleanEpisodeTextHTMLEndAndDelivery(t *testing.T) {
	raw := `<p>INT. GYM</p><p>Hi.</p><p><b>— END OF EPISODE 3 —</b></p>` + "\n\n---\n\n**交付说明**\n\n文件夹已创建：`剧本skills`\n- `剧本.docx`\n"
	got := CleanEpisodeText(raw)
	if strings.Contains(got, "交付") || strings.Contains(got, "docx") || strings.Contains(got, "<p>") {
		t.Fatalf("meta/html left: %q", got)
	}
	if !strings.Contains(strings.ToUpper(got), "END OF EPISODE 3") {
		t.Fatalf("lost end: %q", got)
	}
}

func TestCleanEpisodeTextStripsMidBatchDelivery(t *testing.T) {
	raw := "INT. A\nHi.\nEND OF EPISODE 51\n\n---\n\n**交付说明**\n第49-51集完成了关键转折\n\nINT. B - DAY\nBye.\nEND OF EPISODE 52\n"
	got := CleanEpisodeText(raw)
	if strings.Contains(got, "交付") || strings.Contains(got, "关键转折") {
		t.Fatalf("mid delivery left: %q", got)
	}
	if !strings.Contains(got, "END OF EPISODE 51") || !strings.Contains(got, "END OF EPISODE 52") {
		t.Fatalf("lost ends: %q", got)
	}
}

func TestSplitMashedEpisodes(t *testing.T) {
	script := map[string]any{
		"totalEpisodes": 1,
		"episodes": []map[string]any{
			{"title": "第 1 集", "text": strings.Repeat("scene line enough body content here. ", 5) + "\nEND OF EPISODE 10\n\n" + strings.Repeat("other scene body content here ok. ", 5) + "\nEND OF EPISODE 11\n"},
		},
	}
	if !CleanScriptEpisodes(script) {
		t.Fatal("expected change")
	}
	eps, _ := script["episodes"].([]map[string]any)
	if len(eps) != 2 {
		t.Fatalf("want 2 got %d %#v", len(eps), eps)
	}
}
