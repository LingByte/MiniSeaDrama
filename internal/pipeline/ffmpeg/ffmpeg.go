// Copyright (c) 2026 lingbyte. All rights reserved.

package ffmpeg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var durationRE = regexp.MustCompile(`Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)`)

// MediaCancelled is raised when the user cancels a media command.
var MediaCancelled = errors.New("任务已取消")

// FindFFmpeg locates an ffmpeg binary.
func FindFFmpeg(explicit string) (string, error) {
	candidates := []string{
		strings.TrimSpace(explicit),
		strings.TrimSpace(os.Getenv("MINISEA_FFMPEG")),
		filepath.Join(repoRoot(), "bin", "ffmpeg"),
		filepath.Join(repoRoot(), "bin", "ffmpeg.exe"),
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		candidates = append(candidates, p)
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		st, err := os.Stat(c)
		if err != nil || st.IsDir() {
			continue
		}
		if runtime.GOOS != "windows" {
			if st.Mode()&0o111 == 0 {
				continue
			}
		}
		abs, _ := filepath.Abs(c)
		return abs, nil
	}
	return "", errors.New("没有找到 FFmpeg。请把 ffmpeg 放进项目 bin 目录，或设置 MINISEA_FFMPEG。")
}

func repoRoot() string {
	wd, _ := os.Getwd()
	return wd
}

// RunFFmpeg runs ffmpeg with args and optional cancel via context.
func RunFFmpeg(ctx context.Context, ffmpegPath string, args []string, timeout time.Duration) (int, string, error) {
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	cmdCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, ffmpegPath, append([]string{"-hide_banner", "-y"}, args...)...)
	cmd.Stdout = nil
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if errors.Is(cmdCtx.Err(), context.Canceled) {
		return -1, stderr.String(), MediaCancelled
	}
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if err != nil && code == 0 {
		code = -1
	}
	return code, stderr.String(), err
}

// ProbeDuration returns media duration in milliseconds.
func ProbeDuration(ffmpegPath, mediaPath string) int {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegPath, "-hide_banner", "-i", mediaPath)
	cmd.Stdout = nil
	out, _ := cmd.CombinedOutput()
	match := durationRE.FindStringSubmatch(string(out))
	if match == nil {
		return 0
	}
	var h, m int
	var s float64
	fmt.Sscanf(match[1], "%d", &h)
	fmt.Sscanf(match[2], "%d", &m)
	fmt.Sscanf(match[3], "%f", &s)
	return int((float64(h*3600+m*60) + s) * 1000)
}

// ExtractAudio writes mono 16 kHz MP3 for ASR engines.
func ExtractAudio(ctx context.Context, ffmpegPath, videoPath, audioPath string) error {
	if err := os.MkdirAll(filepath.Dir(audioPath), 0o755); err != nil {
		return err
	}
	code, stderr, err := RunFFmpeg(ctx, ffmpegPath, []string{
		"-i", videoPath,
		"-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", audioPath,
	}, 30*time.Minute)
	if errors.Is(err, MediaCancelled) {
		return MediaCancelled
	}
	st, statErr := os.Stat(audioPath)
	if code != 0 || statErr != nil || st.Size() == 0 {
		detail := strings.TrimSpace(stderr)
		if len(detail) > 500 {
			detail = detail[len(detail)-500:]
		}
		return fmt.Errorf("音频提取失败：%s", detail)
	}
	return nil
}