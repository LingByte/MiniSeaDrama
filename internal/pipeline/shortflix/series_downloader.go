// Copyright (c) 2026 lingbyte. All rights reserved.

package shortflix

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
)

// CancelledError indicates user stop.
type CancelledError struct{ Msg string }

func (e CancelledError) Error() string {
	if e.Msg == "" {
		return "下载已停止。"
	}
	return e.Msg
}

// ProgressEvent is emitted during episode downloads.
type ProgressEvent map[string]any

// SeriesDownloader downloads multiple episodes.
type SeriesDownloader struct {
	FFmpegPath string
	OnProgress func(ProgressEvent)
	cancel     atomic.Bool
}

// NewSeriesDownloader creates a downloader.
func NewSeriesDownloader(ffmpegPath string, onProgress func(ProgressEvent)) *SeriesDownloader {
	if onProgress == nil {
		onProgress = func(ProgressEvent) {}
	}
	return &SeriesDownloader{FFmpegPath: ffmpegPath, OnProgress: onProgress}
}

// Cancel stops further downloads.
func (d *SeriesDownloader) Cancel() { d.cancel.Store(true) }

// Download saves selected episodes under outputRoot.
func (d *SeriesDownloader) Download(ctx context.Context, series Series, outputRoot string, episodeNumbers []int, quality string, retries int, refresher func() (Series, error)) (string, error) {
	selected := map[int]struct{}{}
	for _, n := range episodeNumbers {
		selected[n] = struct{}{}
	}
	var episodes []Episode
	for _, ep := range series.Episodes {
		if len(selected) == 0 || selected[ep.Number] == struct{}{} {
			episodes = append(episodes, ep)
		}
	}
	if len(episodes) == 0 {
		return "", ShortFlixError{Msg: "没有选择任何可下载剧集。"}
	}
	dir := filepath.Join(outputRoot, safeFilename(series.Title))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	total := len(episodes)
	for i, ep := range episodes {
		if d.cancel.Load() {
			return "", CancelledError{Msg: "下载已停止。"}
		}
		version, err := SelectVersion(ep)
		if err != nil {
			return "", err
		}
		dest := filepath.Join(dir, fmt.Sprintf("%s - E%03d.mp4", safeFilename(series.Title), ep.Number))
		d.OnProgress(ProgressEvent{"type": "episode_started", "episode": ep.Number, "index": i + 1, "total": total})
		var last error
		for attempt := 1; attempt <= max(1, retries+1); attempt++ {
			if d.cancel.Load() {
				return "", CancelledError{}
			}
			last = DownloadEpisode(ctx, d.FFmpegPath, ep, version, dest)
			if last == nil {
				break
			}
			if refresher != nil && attempt < retries+1 {
				if fresh, err := refresher(); err == nil {
					for _, fep := range fresh.Episodes {
						if fep.Number == ep.Number {
							if nv, verr := SelectVersion(fep); verr == nil {
								version = nv
							}
						}
					}
				}
			}
		}
		if last != nil {
			return "", ShortFlixError{Msg: fmt.Sprintf("第 %d 集下载失败：%v", ep.Number, last)}
		}
		d.OnProgress(ProgressEvent{"type": "episode_completed", "episode": ep.Number, "index": i + 1, "total": total, "path": dest})
	}
	return dir, nil
}

func safeFilename(value string) string {
	invalid := `<>:"/\|?*`
	var b strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if r < 32 || strings.ContainsRune(invalid, r) {
			b.WriteRune('_')
		} else {
			b.WriteRune(r)
		}
	}
	cleaned := strings.Trim(strings.Join(strings.Fields(b.String()), " "), " .")
	if cleaned == "" {
		return "ShortFlix"
	}
	if len(cleaned) > 120 {
		cleaned = cleaned[:120]
	}
	return cleaned
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}