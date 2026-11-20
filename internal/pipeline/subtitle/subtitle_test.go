// Copyright (c) 2026 lingbyte. All rights reserved.

package subtitle

import "testing"

func TestParseWebVTTShortTimestamp(t *testing.T) {
	raw := "WEBVTT\n\n00:04.958 --> 00:05.541\nRemember how much\n\n00:05.541 --> 00:06.375\nyou liked that?\n"
	segs := ParseSubtitle(raw)
	if len(segs) != 2 {
		t.Fatalf("got %d cues, want 2", len(segs))
	}
	if segs[0].Text != "Remember how much" {
		t.Fatalf("cue0 text=%q", segs[0].Text)
	}
	if segs[0].StartMs != 4958 || segs[0].EndMs != 5541 {
		t.Fatalf("cue0 timing=%d-%d", segs[0].StartMs, segs[0].EndMs)
	}
	if segs[1].Text != "you liked that?" {
		t.Fatalf("cue1 text=%q", segs[1].Text)
	}
}

func TestParseSRTFullTimestamp(t *testing.T) {
	raw := "1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n"
	segs := ParseSubtitle(raw)
	if len(segs) != 1 || segs[0].Text != "Hello world" {
		t.Fatalf("got %+v", segs)
	}
	if segs[0].StartMs != 1000 || segs[0].EndMs != 2500 {
		t.Fatalf("timing=%d-%d", segs[0].StartMs, segs[0].EndMs)
	}
}
