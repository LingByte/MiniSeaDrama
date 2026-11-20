// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/LingByte/miniseadrama/internal/pipeline/shortflix"
)

// FindEpisodeSubtitlePath locates E00N.vtt / .srt under workdir/subtitles.
func FindEpisodeSubtitlePath(workdir string, episode int) (string, error) {
	if workdir == "" || episode < 1 {
		return "", errBadRequest("无效的工作目录或集数")
	}
	subsDir := filepath.Join(workdir, "subtitles")
	for _, suffix := range []string{".vtt", ".srt", ".txt"} {
		path := filepath.Join(subsDir, fmt.Sprintf("E%03d%s", episode, suffix))
		if st, err := os.Stat(path); err == nil && !st.IsDir() && st.Size() > 0 {
			return path, nil
		}
	}
	return "", errNotFound(fmt.Sprintf("第 %d 集字幕文件不存在", episode))
}

// ReadEpisodeSubtitle returns subtitle text for one episode.
func ReadEpisodeSubtitle(workdir string, episode int) (string, string, error) {
	path, err := FindEpisodeSubtitlePath(workdir, episode)
	if err != nil {
		return "", "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", errNotFound("读取字幕失败")
	}
	return string(data), filepath.Base(path), nil
}

// RetryEpisodeSubtitle re-downloads one episode's English subtitle into workdir.
func RetryEpisodeSubtitle(rawURL, cookie string, workdir string, episode int) (map[string]any, error) {
	if episode < 1 {
		return nil, errBadRequest("集数无效")
	}
	if workdir == "" {
		return nil, errBadRequest("任务工作目录未知，请等待识别完成后再重试")
	}
	cookie = ParseCookieHeader(cookie)
	series, err := shortflix.DiscoverSeries(strings.TrimSpace(rawURL), cookie)
	if err != nil {
		return nil, err
	}
	var target *shortflix.Episode
	for i := range series.Episodes {
		if series.Episodes[i].Number == episode {
			target = &series.Episodes[i]
			break
		}
	}
	if target == nil {
		return nil, errNotFound(fmt.Sprintf("剧目中没有第 %d 集", episode))
	}
	subsDir := filepath.Join(workdir, "subtitles")
	_ = os.MkdirAll(subsDir, 0o755)
	saved, lastErr := downloadEpisodeEnglishSubtitle(*target, subsDir, cookie)
	if saved == "" {
		if lastErr == "" {
			lastErr = "没有可用的英文字幕"
		}
		return map[string]any{
			"number": episode, "status": "fail", "error": lastErr,
		}, errBadRequest(fmt.Sprintf("第 %d 集字幕重试失败：%s", episode, lastErr))
	}
	content, name, _ := ReadEpisodeSubtitle(workdir, episode)
	return map[string]any{
		"number": episode, "status": "ok", "error": "",
		"file": name, "content": content,
	}, nil
}
