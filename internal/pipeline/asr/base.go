// Copyright (c) 2026 lingbyte. All rights reserved.

package asr

import (
	"encoding/json"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var cacheMu sync.Mutex

type engine interface {
	Run() (Data, error)
	cacheKey() string
}

func readAudio(path string) ([]byte, error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".flac", ".m4a", ".mp3", ".wav":
	default:
		return nil, os.ErrInvalid
	}
	return os.ReadFile(path)
}

func crc32Hex(data []byte) string {
	return formatHex(crc32.ChecksumIEEE(data))
}

func formatHex(v uint32) string {
	const hexdigits = "0123456789abcdef"
	var b [8]byte
	for i := 7; i >= 0; i-- {
		b[i] = hexdigits[v&0xf]
		v >>= 4
	}
	return string(b[:])
}

func loadCache(path string) map[string]json.RawMessage {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]json.RawMessage{}
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(data, &m) != nil {
		return map[string]json.RawMessage{}
	}
	return m
}

func saveCache(path string, cache map[string]json.RawMessage) {
	if len(cache) == 0 {
		return
	}
	cacheMu.Lock()
	defer cacheMu.Unlock()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	raw, _ := json.MarshalIndent(cache, "", "  ")
	if len(raw) > 10<<20 {
		_ = os.Remove(path)
		return
	}
	_ = os.WriteFile(path, raw, 0o644)
}