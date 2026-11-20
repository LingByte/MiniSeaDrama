// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"os"
	"path/filepath"
	"strings"
)

// RepoRoot is resolved lazily from cwd (cmd/server runs at repo root).
func RepoRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

// WorkDir is the pipeline output root (data/pipeline/).
func WorkDir() string {
	if v := strings.TrimSpace(os.Getenv("PIPELINE_WORK_DIR")); v != "" {
		return v
	}
	return filepath.Join(RepoRoot(), "data", "pipeline")
}

// CacheDir holds ASR cache and temp artifacts.
func CacheDir() string {
	return filepath.Join(WorkDir(), "cache")
}

// SkillPath points at the script-generation skill markdown.
func SkillPath() string {
	name := "至简海漫Skills_V1.4智能体版.md"
	candidates := []string{
		filepath.Join(RepoRoot(), "skills", "haiman", name),
		filepath.Join(RepoRoot(), "skills", name),
		filepath.Join(RepoRoot(), "miniseadrama", "skills", name),
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return candidates[0]
}

// EnsureDirs creates work and cache directories.
func EnsureDirs() error {
	for _, d := range []string{WorkDir(), CacheDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// SafeFilename strips unsafe characters for filesystem paths.
func SafeFilename(value, fallback string) string {
	if fallback == "" {
		fallback = "drama"
	}
	var b strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			b.WriteRune('_')
		} else {
			b.WriteRune(r)
		}
	}
	cleaned := strings.Trim(strings.Join(strings.Fields(b.String()), " "), " .")
	if cleaned == "" {
		return fallback
	}
	if len(cleaned) > 100 {
		cleaned = cleaned[:100]
	}
	return cleaned
}