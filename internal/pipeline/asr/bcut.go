// Copyright (c) 2026 lingbyte. All rights reserved.

package asr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/pipeline/subtitle"
)

const (
	apiBase         = "https://member.bilibili.com/x/bcut/rubick-interface"
	apiReqUpload    = apiBase + "/resource/create"
	apiCommitUpload = apiBase + "/resource/create/complete"
	apiCreateTask   = apiBase + "/task"
	apiQueryResult  = apiBase + "/task/result"
)

var bcutHeaders = map[string]string{
	"User-Agent":   "Bilibili/1.0.0 (https://www.bilibili.com)",
	"Content-Type": "application/json",
}

type bcutEngine struct{ path string }

func newBcut(path string) (engine, error) {
	return bcutEngine{path: path}, nil
}

func (b bcutEngine) cacheKey() string {
	data, err := os.ReadFile(b.path)
	if err != nil {
		return "BcutASR-" + b.path
	}
	return "BcutASR-" + crc32Hex(data)
}

func (b bcutEngine) Run() (Data, error) {
	segs, err := TranscribeBcut(b.path)
	if err != nil {
		return Data{}, err
	}
	var out []Segment
	for _, s := range segs {
		out = append(out, Segment{Text: s.Text, StartTime: float64(s.StartMs), EndTime: float64(s.EndMs)})
	}
	return Data{Segments: out}, nil
}

// TranscribeBcut runs Bilibili Bcut ASR on an MP3 file and returns segments.
func TranscribeBcut(audioPath string) ([]subtitle.Segment, error) {
	data, err := os.ReadFile(audioPath)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 300 * time.Second}

	reqBody, _ := json.Marshal(map[string]any{
		"type":             2,
		"name":             "audio.mp3",
		"size":             len(data),
		"ResourceFileType": "mp3",
		"model_id":         "8",
	})
	resp, err := postJSON(client, apiReqUpload, reqBody)
	if err != nil {
		return nil, err
	}
	d, _ := resp["data"].(map[string]any)
	if d == nil {
		return nil, fmt.Errorf("必剪申请上传失败")
	}
	inBossKey := asStr(d["in_boss_key"])
	resourceID := asStr(d["resource_id"])
	uploadID := asStr(d["upload_id"])
	uploadURLs, _ := d["upload_urls"].([]any)
	perSize := int(asFloat(d["per_size"]))
	if perSize <= 0 || len(uploadURLs) == 0 {
		return nil, fmt.Errorf("必剪上传参数无效")
	}

	var etags []string
	for i, u := range uploadURLs {
		urlStr := asStr(u)
		start := i * perSize
		end := start + perSize
		if end > len(data) {
			end = len(data)
		}
		req, err := http.NewRequest(http.MethodPut, urlStr, bytes.NewReader(data[start:end]))
		if err != nil {
			return nil, err
		}
		for k, v := range bcutHeaders {
			req.Header.Set(k, v)
		}
		putResp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		etag := putResp.Header.Get("Etag")
		_, _ = io.Copy(io.Discard, putResp.Body)
		putResp.Body.Close()
		if putResp.StatusCode >= 400 {
			return nil, fmt.Errorf("必剪分片上传失败 HTTP %d", putResp.StatusCode)
		}
		etags = append(etags, etag)
	}

	commitBody, _ := json.Marshal(map[string]any{
		"InBossKey":  inBossKey,
		"ResourceId": resourceID,
		"Etags":      strings.Join(etags, ","),
		"UploadId":   uploadID,
		"model_id":   "8",
	})
	commit, err := postJSON(client, apiCommitUpload, commitBody)
	if err != nil {
		return nil, err
	}
	cd, _ := commit["data"].(map[string]any)
	downloadURL := asStr(cd["download_url"])
	if downloadURL == "" {
		return nil, fmt.Errorf("必剪提交上传失败")
	}

	taskBody, _ := json.Marshal(map[string]any{"resource": downloadURL, "model_id": "8"})
	taskResp, err := postJSON(client, apiCreateTask, taskBody)
	if err != nil {
		return nil, err
	}
	td, _ := taskResp["data"].(map[string]any)
	taskID := asStr(td["task_id"])
	if taskID == "" {
		return nil, fmt.Errorf("必剪创建任务失败")
	}

	var result map[string]any
	for i := 0; i < 500; i++ {
		result, err = getTaskResult(client, taskID)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		if int(asFloat(result["state"])) == 4 {
			break
		}
		time.Sleep(time.Second)
	}
	if result == nil || int(asFloat(result["state"])) != 4 {
		return nil, fmt.Errorf("必剪任务查询超时或未完成")
	}
	raw := asStr(result["result"])
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("必剪结果解析失败: %w", err)
	}
	utterances, _ := parsed["utterances"].([]any)
	var segs []subtitle.Segment
	for _, u := range utterances {
		m, _ := u.(map[string]any)
		if m == nil {
			continue
		}
		segs = append(segs, subtitle.Segment{
			StartMs: int(asFloat(m["start_time"])),
			EndMs:   int(asFloat(m["end_time"])),
			Text:    asStr(m["transcript"]),
		})
	}
	return segs, nil
}

func postJSON(client *http.Client, url string, body []byte) (map[string]any, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range bcutHeaders {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(data))
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func getTaskResult(client *http.Client, taskID string) (map[string]any, error) {
	req, err := http.NewRequest(http.MethodGet, apiQueryResult+"?model_id=7&task_id="+taskID, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range bcutHeaders {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	d, _ := out["data"].(map[string]any)
	return d, nil
}

func asStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	default:
		return fmt.Sprint(v)
	}
}

func asFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case json.Number:
		f, _ := t.Float64()
		return f
	default:
		return 0
	}
}
