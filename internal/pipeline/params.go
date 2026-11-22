// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"fmt"
	"os"
	"strings"

	"github.com/LingByte/miniseadrama/internal/pipeline/asr"
	"github.com/LingByte/miniseadrama/internal/pipeline/ffmpeg"
)

// ValidateJobParams normalizes create-job input.
func ValidateJobParams(payload map[string]any) (map[string]any, error) {
	url := strings.TrimSpace(fmt.Sprint(payload["url"]))
	if url == "" {
		return nil, fmt.Errorf("请填写 ShortFlix 剧目链接。")
	}
	engine := strings.ToLower(strings.TrimSpace(fmt.Sprint(payload["engine"])))
	if engine == "" {
		engine = asr.DefaultEngine
	}
	if _, ok := asr.EngineInfo[engine]; !ok {
		return nil, fmt.Errorf("不支持的 ASR 接口：%s", engine)
	}
	llm, _ := payload["llm"].(map[string]any)
	if llm == nil {
		llm = map[string]any{}
	}
	outputRoot := strings.TrimSpace(fmt.Sprint(payload["output_root"]))
	if outputRoot == "" {
		outputRoot = WorkDir()
	}
	return map[string]any{
		"url": url,
		"cookie": fmt.Sprint(payload["cookie"]),
		"engine": engine,
		"workers": clampInt(payload["workers"], 3, 1, 6),
		"batch_size": clampInt(payload["batch_size"], 1, 1, 6),
		"force_asr": boolParam(payload["force_asr"]),
		"redo_asr":  boolParam(payload["redo_asr"]),
		"ffmpeg":    strings.TrimSpace(fmt.Sprint(payload["ffmpeg"])),
		"output_root": outputRoot,
		"llm": map[string]any{
			"base_url":    defaultString(strings.TrimSpace(fmt.Sprint(llm["base_url"])), envOr("AI_BASE_URL", "https://team.lingecho.com/v1")),
			"api_key":     strings.TrimSpace(fmt.Sprint(llm["api_key"])),
			"model":       defaultString(strings.TrimSpace(fmt.Sprint(llm["model"])), envOr("AI_TEXT_MODEL", "claude-opus-5.5特价")),
			"temperature": floatParam(llm["temperature"], 0.8),
			"max_tokens":  clampInt(llm["max_tokens"], 16384, 256, 32768),
			"timeout":     clampInt(llm["timeout"], 900, 60, 3600),
		},
	}, nil
}

// CheckFFmpeg validates ffmpeg is available when job will need it.
func CheckFFmpeg(explicit string) error {
	_, err := ffmpeg.FindFFmpeg(explicit)
	return err
}

func clampInt(v any, def, low, high int) int {
	n := intFromAny(v, def)
	if n < low {
		return low
	}
	if n > high {
		return high
	}
	return n
}

func defaultString(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func boolParam(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

func floatParam(v any, def float64) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int:
		return float64(t)
	default:
		return def
	}
}

func intFromAny(v any, def int) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	default:
		return def
	}
}