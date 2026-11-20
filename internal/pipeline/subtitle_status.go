// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/LingByte/miniseadrama/internal/pipeline/shortflix"
	"github.com/LingByte/miniseadrama/internal/pipeline/subtitle"
)

// SeriesSubtitleStatus 根据剧集版本信息判断是否有英文字幕软轨。
func SeriesSubtitleStatus(series shortflix.Series) string {
	if len(series.Episodes) == 0 {
		return shortflix.SubStatusUnknown
	}
	enEps, hardEps := 0, 0
	for _, ep := range series.Episodes {
		if episodeHasEnglishSoftSub(ep) {
			enEps++
			continue
		}
		if episodeLooksHardOnly(ep) {
			hardEps++
		}
	}
	if enEps > 0 {
		return shortflix.SubStatusSoftEN
	}
	if hardEps > 0 || len(series.Episodes) > 0 {
		return shortflix.SubStatusHardOnly
	}
	return shortflix.SubStatusUnknown
}

func episodeHasEnglishSoftSub(ep shortflix.Episode) bool {
	for _, ver := range ep.Versions {
		for _, sub := range ver.Subtitles {
			if subtitle.SubtitleTitleIsOtherLanguage(sub.Title) {
				continue
			}
			if subtitle.SubtitleTitleIsEnglish(sub.Title) {
				return true
			}
			// 无语言标记的轨也算候选（与下载逻辑一致）
			if strings.TrimSpace(sub.URL) != "" && strings.TrimSpace(sub.Title) == "" {
				return true
			}
		}
	}
	return false
}

func episodeLooksHardOnly(ep shortflix.Episode) bool {
	if len(ep.Versions) == 0 {
		return false
	}
	for _, ver := range ep.Versions {
		if !ver.HardSub {
			// 有软轨版本但没英文字幕
			if len(ver.Subtitles) == 0 {
				continue
			}
			return false
		}
	}
	// 全部 hard_sub，或没有任何英文字幕
	return !episodeHasEnglishSoftSub(ep)
}

// markSubtitleStatus 用预拉清单 + 本地工作目录给目录卡打字幕属性。
func markSubtitleStatus(items []shortflix.CatalogItem) {
	bySlug := loadSubtitleStatusIndex()
	for i := range items {
		slug := strings.ToLower(strings.TrimSpace(items[i].Slug))
		if st, ok := bySlug[slug]; ok {
			items[i].SubtitleStatus = st
		} else if items[i].SubtitleStatus == "" {
			items[i].SubtitleStatus = shortflix.SubStatusUnknown
		}
	}
}

func loadSubtitleStatusIndex() map[string]string {
	out := map[string]string{}
	// 1) prefetch_manifest.json
	manifestPath := filepath.Join(WorkDir(), "prefetch_manifest.json")
	if data, err := os.ReadFile(manifestPath); err == nil {
		var m struct {
			Results []struct {
				Slug   string   `json:"slug"`
				OK     bool     `json:"ok"`
				Error  string   `json:"error"`
				Errors []string `json:"errors"`
			} `json:"results"`
		}
		if json.Unmarshal(data, &m) == nil {
			for _, r := range m.Results {
				slug := strings.ToLower(strings.TrimSpace(r.Slug))
				if slug == "" {
					continue
				}
				if r.OK {
					out[slug] = shortflix.SubStatusSoftEN
					continue
				}
				blob := r.Error + strings.Join(r.Errors, " ")
				if strings.Contains(blob, "无英文字幕") || strings.Contains(blob, "硬字幕") {
					out[slug] = shortflix.SubStatusHardOnly
				}
			}
		}
	}
	// 2) 工作目录：有 E*.vtt/srt → soft_en；series.json 可辅助 hard_only
	entries, err := os.ReadDir(WorkDir())
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "cache" {
			continue
		}
		slug := strings.ToLower(extractBracketSlug(e.Name()))
		if slug == "" {
			continue
		}
		dir := filepath.Join(WorkDir(), e.Name())
		subsDir := filepath.Join(dir, "subtitles")
		n := 0
		if subEntries, err := os.ReadDir(subsDir); err == nil {
			for _, s := range subEntries {
				name := strings.ToLower(s.Name())
				if strings.HasPrefix(name, "e") && (strings.HasSuffix(name, ".vtt") || strings.HasSuffix(name, ".srt")) {
					n++
				}
			}
		}
		if n > 0 {
			out[slug] = shortflix.SubStatusSoftEN
			continue
		}
		if _, exists := out[slug]; exists {
			continue
		}
		// series.json 里全是 hard_sub
		if st := subtitleStatusFromSeriesJSON(filepath.Join(dir, "series.json")); st != "" {
			out[slug] = st
		}
	}
	return out
}

func subtitleStatusFromSeriesJSON(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var series shortflix.Series
	if json.Unmarshal(data, &series) != nil || len(series.Episodes) == 0 {
		return ""
	}
	return SeriesSubtitleStatus(series)
}
