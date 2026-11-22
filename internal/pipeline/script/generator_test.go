// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"fmt"
	"strings"
	"testing"
)

func TestIsolateEpisodeCutsMashedNextHeader(t *testing.T) {
	raw := "Episode 2\n\nHello body enough.\n\nEND OF EPISODE 2****Episode 3\n\nShould not keep this.\n"
	got := isolateEpisode(raw, 2)
	if strings.Contains(got, "Episode 3") || strings.Contains(got, "Should not") {
		t.Fatalf("leaked next episode: %q", got)
	}
	if !strings.Contains(got, "END OF EPISODE 2") {
		t.Fatalf("lost end marker: %q", got)
	}
}

func TestSplitEpisodesAcceptsBoldHeaders(t *testing.T) {
	raw := "**Episode 1**\n\nHello there, this is episode one body with enough text.\n\n— END OF EPISODE 1 —\n\n**Episode 2**\n\nBye for now, this is episode two body with enough text.\n\n— END OF EPISODE 2 —\n"
	got := splitEpisodes(raw)
	if len(got) < 2 {
		t.Fatalf("want >=2 got %d %#v", len(got), got)
	}
	if got[0]["title"] != "第 1 集" || got[1]["title"] != "第 2 集" {
		t.Fatalf("titles %#v", []any{got[0]["title"], got[1]["title"]})
	}
}

func TestSplitEpisodesDoesNotDropEarlyWhenOnlyBareMidHeader(t *testing.T) {
	// 模拟真实脏数据：前几集是 **Episode N**，中间才裸写 Episode 10
	raw := ""
	for n := 1; n <= 9; n++ {
		raw += fmt.Sprintf("**Episode %d**\n\nBody %d content enough here for splitter.\n\nEND OF EPISODE %d\n\n", n, n, n)
	}
	raw += "Episode 10\n\nBody 10 content enough here for splitter.\n\nEND OF EPISODE 10\n\n"
	raw += "Episode 11\n\nBody 11 content enough here for splitter.\n\nEND OF EPISODE 11\n"
	got := splitEpisodes(raw)
	if len(got) < 10 {
		t.Fatalf("want >=10 episodes, got %d titles=%v", len(got), titles(got))
	}
	if got[0]["title"] != "第 1 集" {
		t.Fatalf("first should be 第 1 集, got %v (all=%v)", got[0]["title"], titles(got))
	}
}

func titles(eps []map[string]any) []string {
	out := make([]string, len(eps))
	for i, e := range eps {
		out[i], _ = e["title"].(string)
	}
	return out
}
