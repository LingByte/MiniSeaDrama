// Copyright (c) 2026 lingbyte. All rights reserved.

package asr

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DefaultEngine is the preferred ASR backend.
const DefaultEngine = "bcut"

// EngineInfo maps engine key to label.
var EngineInfo = map[string]string{
	"bcut":     "必剪 B 接口",
	"jianying": "剪映 J 接口",
	"kuaishou": "快手 K 接口",
}

type progressFn func(string)

// Transcribe runs one engine with retries.
func Transcribe(audioPath, engine string, useCache bool, retries int, progress progressFn) (Data, error) {
	key := engine
	if key == "" {
		key = DefaultEngine
	}
	key = stringsLower(key)
	if _, ok := EngineInfo[key]; !ok {
		return Data{}, fmt.Errorf("未知的 ASR 接口：%s", engine)
	}
	label := EngineInfo[key]
	attempts := retries + 1
	if attempts < 1 {
		attempts = 1
	}
	cachePath := filepath.Join(cacheDir(), "asr_cache.json")
	cache := loadCache(cachePath)
	var last error
	for attempt := 1; attempt <= attempts; attempt++ {
		if progress != nil {
			progress(fmt.Sprintf("%s 第 %d/%d 次识别", label, attempt, attempts))
		}
		eng, err := newEngine(key, audioPath)
		if err != nil {
			last = err
			continue
		}
		ck := eng.cacheKey()
		if useCache {
			if raw, ok := cache[ck]; ok {
				if data, err := dataFromCache(key, raw); err == nil && data.HasData() {
					return data, nil
				}
			}
		}
		data, err := eng.Run()
		if err != nil {
			last = err
			if attempt < attempts {
				if progress != nil {
					progress(fmt.Sprintf("%s 失败，%d 秒后重试：%v", label, attempt*2, err))
				}
				time.Sleep(time.Duration(attempt*2) * time.Second)
			}
			continue
		}
		if !data.HasData() {
			last = fmt.Errorf("%s：没有识别出文字", label)
			continue
		}
		if useCache {
			if raw, err := encodeCache(key, data); err == nil {
				cache[ck] = raw
				saveCache(cachePath, cache)
			}
		}
		return data, nil
	}
	if last == nil {
		last = fmt.Errorf("%s 识别失败", label)
	}
	return Data{}, fmt.Errorf("%s 识别失败：%w", label, last)
}

func stringsLower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

func cacheDir() string {
	if v := os.Getenv("PIPELINE_WORK_DIR"); v != "" {
		return filepath.Join(v, "cache")
	}
	wd, _ := os.Getwd()
	return filepath.Join(wd, "data", "pipeline", "cache")
}

func encodeCache(_ string, data Data) (json.RawMessage, error) {
	return json.Marshal(data)
}

func dataFromCache(_ string, raw json.RawMessage) (Data, error) {
	var d Data
	err := json.Unmarshal(raw, &d)
	return d, err
}

func newEngine(key, path string) (engine, error) {
	switch key {
	case "bcut":
		return newBcut(path)
	case "kuaishou":
		return newKuaiShou(path)
	case "jianying":
		return newJianYing(path)
	default:
		return nil, fmt.Errorf("unsupported engine %s", key)
	}
}