// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var artifactFiles = map[string]string{
	"script_docx": "剧本.docx",
	"setting_docx": "设定.docx",
	"meta_json":    "设定要点.json",
	"script_md":    "剧本.md",
	"plan_json":    "plan.json",
}

// ArtifactFiles returns known artifact keys.
func ArtifactFiles() map[string]string {
	out := map[string]string{}
	for k, v := range artifactFiles {
		out[k] = v
	}
	return out
}

var slugRE = regexp.MustCompile(`/videos/([^/?#]+)`)

func outputDirForURL(rawURL string) (string, bool) {
	m := slugRE.FindStringSubmatch(rawURL)
	if len(m) < 2 {
		return "", false
	}
	slug := m[1]
	root := WorkDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	var candidates []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if strings.Contains(e.Name(), "["+slug+"]") {
			out := filepath.Join(root, e.Name(), "output")
			if st, err := os.Stat(out); err == nil && st.IsDir() {
				candidates = append(candidates, out)
			}
		}
	}
	if len(candidates) == 0 {
		return "", false
	}
	sort.Slice(candidates, func(i, j int) bool {
		si, _ := os.Stat(candidates[i])
		sj, _ := os.Stat(candidates[j])
		if si == nil || sj == nil {
			return i < j
		}
		return si.ModTime().After(sj.ModTime())
	})
	return candidates[0], true
}

// ListArtifacts lists files under the latest workdir for a slug.
func ListArtifacts(rawURL string) (map[string]any, error) {
	outputDir, ok := outputDirForURL(rawURL)
	if !ok {
		return nil, errNotFound("还没有生成过该剧的产物。")
	}
	var artifacts []map[string]any
	for key, name := range artifactFiles {
		path := filepath.Join(outputDir, name)
		st, err := os.Stat(path)
		if err != nil || st.IsDir() {
			continue
		}
		artifacts = append(artifacts, map[string]any{
			"key": key, "label": name, "size": st.Size(),
			"updated_at": st.ModTime().Unix(),
		})
	}
	if len(artifacts) == 0 {
		return nil, errNotFound("该剧工作目录里没有可用产物。")
	}
	return map[string]any{
		"workdir": filepath.Dir(outputDir), "artifacts": artifacts,
	}, nil
}

// ResolveArtifactPath finds a file inside an output directory.
func ResolveArtifactPath(rawURL, key string) (string, string, error) {
	name, ok := artifactFiles[key]
	if !ok {
		return "", "", errBadRequest("不支持的产物类型。")
	}
	outputDir, ok := outputDirForURL(rawURL)
	if !ok {
		return "", "", errNotFound("还没有生成过该剧的产物。")
	}
	path := filepath.Join(outputDir, name)
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		return "", "", errNotFound("文件不存在。")
	}
	return path, name, nil
}

type apiError struct {
	status int
	msg    string
}

func (e apiError) Error() string { return e.msg }

func errNotFound(msg string) error  { return apiError{status: 404, msg: msg} }
func errBadRequest(msg string) error { return apiError{status: 400, msg: msg} }

// APIErrorStatus extracts HTTP status from pipeline API errors.
func APIErrorStatus(err error) (int, string, bool) {
	var ae apiError
	if errors.As(err, &ae) {
		return ae.status, ae.msg, true
	}
	return 500, err.Error(), false
}
