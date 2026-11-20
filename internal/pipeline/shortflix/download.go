// Copyright (c) 2026 lingbyte. All rights reserved.

package shortflix

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	ffmpg "github.com/LingByte/miniseadrama/internal/pipeline/ffmpeg"
)

// SelectVersion picks the best version (highest quality).
func SelectVersion(ep Episode) (EpisodeVersion, error) {
	if len(ep.Versions) == 0 {
		return EpisodeVersion{}, fmt.Errorf("第 %d 集没有可用视频版本。", ep.Number)
	}
	best := ep.Versions[0]
	for _, v := range ep.Versions[1:] {
		if qualityScore(v.Quality) > qualityScore(best.Quality) {
			best = v
		}
	}
	return best, nil
}

// DownloadEpisode remuxes HLS/MP4 via ffmpeg into dest .mp4.
func DownloadEpisode(ctx context.Context, ffmpegPath string, ep Episode, version EpisodeVersion, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if st, err := os.Stat(dest); err == nil && st.Size() > 0 {
		return nil
	}
	tmp := dest + ".part.mp4"
	_ = os.Remove(tmp)
	code, stderr, err := ffmpg.RunFFmpeg(ctx, ffmpegPath, []string{
		"-i", version.VideoURL,
		"-c", "copy",
		"-bsf:a", "aac_adtstoasc",
		tmp,
	}, 45*time.Minute)
	if err != nil && code != 0 {
		_ = os.Remove(tmp)
		detail := stderr
		if len(detail) > 400 {
			detail = detail[len(detail)-400:]
		}
		return fmt.Errorf("第 %d 集下载失败：%s", ep.Number, detail)
	}
	if st, err := os.Stat(tmp); err != nil || st.Size() == 0 {
		_ = os.Remove(tmp)
		return fmt.Errorf("第 %d 集下载结果为空", ep.Number)
	}
	return os.Rename(tmp, dest)
}

// EnglishSubtitleCandidates returns English-looking tracks for an episode.
func EnglishSubtitleCandidates(ep Episode) []Subtitle {
	var out []Subtitle
	seen := map[string]bool{}
	for _, v := range ep.Versions {
		for _, s := range v.Subtitles {
			title := s.Title
			low := toLower(title)
			if containsAny(low, "zh", "chi", "中", "cn") {
				continue
			}
			if !(containsAny(low, "en", "eng", "english") || true) {
				continue
			}
			// Prefer explicit English titles; still accept unknown if only option later
			if !containsAny(low, "en", "eng", "english") {
				continue
			}
			if seen[s.URL] {
				continue
			}
			seen[s.URL] = true
			out = append(out, s)
		}
	}
	return out
}

func toLower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}

func containsAny(s string, parts ...string) bool {
	for _, p := range parts {
		if len(p) == 0 {
			continue
		}
		for i := 0; i+len(p) <= len(s); i++ {
			if s[i:i+len(p)] == p {
				return true
			}
		}
	}
	return false
}
