// Copyright (c) 2026 lingbyte. All rights reserved.

package asr

// Segment is one utterance with millisecond timestamps.
type Segment struct {
	Text      string  `json:"text"`
	StartTime float64 `json:"start_time"`
	EndTime   float64 `json:"end_time"`
}

// Data holds ASR output segments.
type Data struct {
	Segments []Segment
}

// HasData returns true when utterances exist.
func (d Data) HasData() bool {
	return len(d.Segments) > 0
}