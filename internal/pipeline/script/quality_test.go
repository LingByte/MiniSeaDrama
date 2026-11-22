// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"strings"
	"testing"
)

func TestBuildContinuityCard(t *testing.T) {
	prev := "Episode 5\n\n5-1 CABIN – NOAH'S BEDROOM [INT.] [NIGHT]\n\nETHAN\nI have to go.\n\nNOAH\nWait.\n\nEthan runs into the dark.\n\nEND OF EPISODE 5\n"
	card := buildContinuityCard(prev, "Ethan flees into the woods")
	if !strings.Contains(card.LastLocation, "CABIN") {
		t.Fatalf("location=%q", card.LastLocation)
	}
	if len(card.LastSpeakers) == 0 {
		t.Fatal("expected speakers")
	}
	out := card.Format()
	if !strings.Contains(out, "last_location") || !strings.Contains(out, "planned_hook") {
		t.Fatalf("format=%q", out)
	}
	if len([]rune(out)) > 900 {
		t.Fatalf("card too long: %d", len([]rune(out)))
	}
}

func TestValidateEpisodeTextOK(t *testing.T) {
	raw := "Episode 2\n\n2-1 ROOM [INT.] [NIGHT]\n\nETHAN\nHello there, this is a complete line.\n\nNOAH\nUnderstood.\n\n" +
		strings.Repeat("More action description that keeps the episode long enough for quality gate. ", 40) +
		"\n\nEND OF EPISODE 2\n"
	if err := validateEpisodeText(raw, 2); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestValidateEpisodeTextTruncated(t *testing.T) {
	raw := "Episode 4\n\n4-1 ROOM [INT.] [NIGHT]\n\nETHAN\nHello.\n\nMASON\nAnd an Empath is\n\nEND OF EPISODE 4\n"
	raw += strings.Repeat("padding text for length requirement here. ", 40)
	err := validateEpisodeText(raw, 4)
	if err == nil || !strings.Contains(err.Error(), "截断") {
		t.Fatalf("want truncation error, got %v", err)
	}
}

func TestValidateEpisodeTextAllowsDramaticDash(t *testing.T) {
	raw := "Episode 2\n\n2-1 ROOM [INT.] [NIGHT]\n\nETHAN\nDon't you dare—\n\n" +
		strings.Repeat("More action description that keeps the episode long enough for quality gate. ", 40) +
		"\n\nEND OF EPISODE 2\n"
	if err := validateEpisodeText(raw, 2); err != nil {
		t.Fatalf("dramatic dash should pass: %v", err)
	}
}

func TestValidateEpisodeTextMissingEnd(t *testing.T) {
	raw := "Episode 1\n\n1-1 A [INT.] [DAY]\n\n" + strings.Repeat("body content enough. ", 80)
	err := validateEpisodeText(raw, 1)
	if err == nil || !strings.Contains(err.Error(), "END OF EPISODE") {
		t.Fatalf("want missing end, got %v", err)
	}
}

func TestValidateEpisodeTextMaxTokensMarker(t *testing.T) {
	raw := "Episode 1\n\n1-1 A [INT.] [DAY]\n\nHi.\n/* truncated_by_max_tokens */\nEND OF EPISODE 1\n"
	raw += strings.Repeat("more. ", 200)
	err := validateEpisodeText(raw, 1)
	if err == nil || !strings.Contains(err.Error(), "max_tokens") {
		t.Fatalf("want max_tokens error, got %v", err)
	}
}

func TestIsModelRefusal(t *testing.T) {
	if !isModelRefusal("I can't help with this request. The episodes include explicit content.") {
		t.Fatal("expected refusal")
	}
	ok := "Episode 1\n\n1-1 ROOM [INT.] [NIGHT]\n\nETHAN\nHi.\n\n" + strings.Repeat("ok. ", 100) + "\nEND OF EPISODE 1\n"
	if isModelRefusal(ok) {
		t.Fatal("normal episode should not be refusal")
	}
}

func TestIsolateEpisodeDoesNotSynthesizeEnd(t *testing.T) {
	raw := "Episode 3\n\n3-1 A [INT.] [DAY]\n\nBody without end marker.\n"
	got := isolateEpisode(raw, 3)
	if strings.Contains(strings.ToUpper(got), "END OF EPISODE") {
		t.Fatalf("should not synthesize END: %q", got)
	}
}
