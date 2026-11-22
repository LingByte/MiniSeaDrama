// Copyright (c) 2026 lingbyte. All rights reserved.

package scriptdata

import (
	"strings"
	"testing"
)

func TestNormalizeSceneHeadersHollywood(t *testing.T) {
	raw := "FADE IN:\n\nINT. ROMANO MANSION - MASTER BEDROOM - NIGHT\n\nELENA sits up.\n\nEXT. CITY STREET - DAY\n\nCars pass.\n\nINT. ELENA'S CAR - DAY (NEXT MORNING)\n\nShe drives.\n\nEND OF EPISODE 1\n"
	got := NormalizeSceneHeaders(raw, 1)
	want := []string{
		"1-1 ROMANO MANSION – MASTER BEDROOM [INT.] [NIGHT]",
		"1-2 CITY STREET [EXT.] [DAY]",
		"1-3 ELENA'S CAR [INT.] [DAY]",
	}
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Fatalf("missing %q in:\n%s", w, got)
		}
	}
	if strings.Contains(got, "INT. ROMANO") {
		t.Fatalf("hollywood hollywood left:\n%s", got)
	}
}

func TestNormalizeSceneHeadersIdempotent(t *testing.T) {
	raw := "1-1 SU FAMILY HOUSE – DINING ROOM [INT.] [NIGHT]\n\n△ They eat.\n"
	got := NormalizeSceneHeaders(raw, 1)
	if got != raw {
		t.Fatalf("changed house format:\n%s", got)
	}
}

func TestCleanScriptEpisodesNormalizesScenes(t *testing.T) {
	script := map[string]any{
		"totalEpisodes": 1,
		"episodes": []map[string]any{
			{
				"title": "第 1 集",
				"text":  "INT. ROOM - NIGHT\n\nLIN: Hi.\n\nEND OF EPISODE 3\n",
			},
		},
	}
	if !CleanScriptEpisodes(script) {
		t.Fatal("expected change")
	}
	eps := script["episodes"].([]map[string]any)
	text := str(eps[0]["text"])
	if !strings.Contains(text, "3-1 ROOM [INT.] [NIGHT]") {
		t.Fatalf("scene not normalized: %q", text)
	}
}
