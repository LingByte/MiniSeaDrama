// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"github.com/LingByte/miniseadrama/internal/pipeline/shortflix"
)

// InspectSeries discovers episode metadata for the UI.
func InspectSeries(url, cookie string) (map[string]any, error) {
	series, err := shortflix.DiscoverSeries(url, cookie)
	if err != nil {
		return nil, err
	}
	episodes := make([]map[string]any, 0, len(series.Episodes))
	for _, ep := range series.Episodes {
		qualities := make([]string, 0, len(ep.Versions))
		for _, v := range ep.Versions {
			qualities = append(qualities, v.Quality)
		}
		episodes = append(episodes, map[string]any{
			"number": ep.Number, "title": ep.Title, "duration": ep.Duration,
			"qualities": qualities,
			"has_english_sub": episodeHasEnglishSoftSub(ep),
			"hard_sub_only":   episodeLooksHardOnly(ep),
		})
	}
	subStatus := SeriesSubtitleStatus(series)
	note := ""
	switch subStatus {
	case shortflix.SubStatusSoftEN:
		note = "有官方英文字幕软轨，生成时会直接下载字幕（较快）"
	case shortflix.SubStatusHardOnly:
		note = "无英文字幕轨（硬字幕）：生成时将下载视频并用 ASR 转写，耗时更长但仍可生成"
	default:
		note = "字幕轨类型未知，开始生成后会自动探测"
	}
	return map[string]any{
		"title": series.Title, "slug": series.Slug, "cover": series.Cover,
		"source_url": series.SourceURL, "episode_count": len(series.Episodes), "episodes": episodes,
		"subtitle_status":  subStatus,
		"has_english_subs": subStatus == shortflix.SubStatusSoftEN,
		"subtitle_note":    note,
	}, nil
}