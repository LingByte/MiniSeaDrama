// Copyright (c) 2026 lingbyte. All rights reserved.

package asr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"time"
)

// KuaiShouASR calls快手 subtitle_generate API.
type KuaiShouASR struct {
	fileBinary []byte
	client     *http.Client
}

func newKuaiShou(path string) (*KuaiShouASR, error) {
	data, err := readAudio(path)
	if err != nil {
		return nil, err
	}
	return &KuaiShouASR{fileBinary: data, client: &http.Client{Timeout: 10 * time.Minute}}, nil
}

func (k *KuaiShouASR) cacheKey() string { return "KuaiShouASR-" + crc32Hex(k.fileBinary) }

func (k *KuaiShouASR) Run() (Data, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("typeId", "1")
	fw, _ := w.CreateFormFile("file", "test.mp3")
	_, _ = fw.Write(k.fileBinary)
	_ = w.Close()
	req, _ := http.NewRequest(http.MethodPost, "https://ai.kuaishou.com/api/effects/subtitle_generate", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := k.client.Do(req)
	if err != nil {
		return Data{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed struct {
		Data struct {
			Text []struct {
				Text      string  `json:"text"`
				StartTime float64 `json:"start_time"`
				EndTime   float64 `json:"end_time"`
			} `json:"text"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Data{}, fmt.Errorf("快手 ASR 返回无效 JSON：%w", err)
	}
	var segs []Segment
	for _, u := range parsed.Data.Text {
		segs = append(segs, Segment{Text: u.Text, StartTime: u.StartTime, EndTime: u.EndTime})
	}
	return Data{Segments: segs}, nil
}