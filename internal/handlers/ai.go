// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"

	"github.com/gin-gonic/gin"
)

var (
	aiHTTPClient      = &http.Client{Timeout: 180 * time.Second}
	jobHTTPClient     = &http.Client{Timeout: 60 * time.Second}
	inspectHTTPClient = &http.Client{Timeout: 180 * time.Second}
	// pyCandidateIdx 记住最近一次可用的生成服务地址（0=配置地址，1=WSL 网关）
	pyCandidateIdx int32
)

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func aiBaseURL() string { return envOr("AI_BASE_URL", "https://team.lingecho.com/v1") }
func aiAPIKey() string  { return strings.TrimSpace(os.Getenv("AI_API_KEY")) }
func aiTextModel() string {
	return envOr("AI_TEXT_MODEL", "claude-opus-5.5特价")
}
func aiImageModel() string { return envOr("AI_IMAGE_MODEL", "tt-image-2.5") }
func pyServiceURL() string {
	return strings.TrimRight(envOr("PY_SERVICE_URL", "http://127.0.0.1:8000"), "/")
}

// pyCandidates 返回可尝试的生成服务地址。
// Go 跑在 WSL、miniseadrama 跑在 Windows 时，WSL 内的 127.0.0.1 指向 WSL 自身，
// 需要改走 WSL 默认网关（即 Windows 主机）才能访问到 8000 端口。
func pyCandidates() []string {
	base := pyServiceURL()
	out := []string{base}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return out
	}
	if gw := wslGatewayIP(); gw != "" {
		alt := *u
		alt.Host = net.JoinHostPort(gw, u.Port())
		if alt.String() != base {
			out = append(out, alt.String())
		}
	}
	return out
}

// wslGatewayIP 从 /proc/net/route 读取默认网关；非 WSL/Linux 环境返回空字符串。
func wslGatewayIP() string {
	data, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[1] != "00000000" {
			continue
		}
		value, err := strconv.ParseUint(fields[2], 16, 32)
		if err != nil {
			continue
		}
		return fmt.Sprintf("%d.%d.%d.%d", byte(value), byte(value>>8), byte(value>>16), byte(value>>24))
	}
	return ""
}

// doPython 按候选地址依次请求生成服务，成功后记住可用地址。
func doPython(c *gin.Context, method, path string, body []byte, client *http.Client) (*http.Response, error) {
	candidates := pyCandidates()
	start := int(atomic.LoadInt32(&pyCandidateIdx)) % len(candidates)
	var lastErr error
	for i := 0; i < len(candidates); i++ {
		idx := (start + i) % len(candidates)
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(c.Request.Context(), method, candidates[idx]+path, reader)
		if err != nil {
			return nil, err
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if idx != start {
			atomic.StoreInt32(&pyCandidateIdx, int32(idx))
		}
		return resp, nil
	}
	return nil, lastErr
}

// AIInspect 识别剧目集数：开始生成前先让运营核对集数是否正确。
func (h *Handlers) AIInspect(c *gin.Context) {
	var body struct {
		URL    string `json:"url"`
		Cookie string `json:"cookie"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.URL) == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请填写 ShortFlix 剧目链接"))
		return
	}
	raw, _ := json.Marshal(map[string]any{
		"url":    strings.TrimSpace(body.URL),
		"cookie": body.Cookie,
	})
	resp, err := doPython(c, http.MethodPost, "/api/inspect", raw, inspectHTTPClient)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "无法连接生成服务，请先启动 miniseadrama（python run.py --host 0.0.0.0）"))
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	c.Data(resp.StatusCode, "application/json; charset=utf-8", data)
}

// AIExistingArtifacts 列出该剧工作目录里已存在的产物（任务未完成时也能用）。
func (h *Handlers) AIExistingArtifacts(c *gin.Context) {
	rawURL := strings.TrimSpace(c.Query("url"))
	if rawURL == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请提供 ShortFlix 剧目链接"))
		return
	}
	h.proxyPython(c, "/api/artifacts?url="+url.QueryEscape(rawURL), jobHTTPClient)
}

// AIExistingArtifactFile 下载已存在的产物文件。
func (h *Handlers) AIExistingArtifactFile(c *gin.Context) {
	rawURL := strings.TrimSpace(c.Query("url"))
	key := strings.TrimSpace(c.Query("key"))
	if rawURL == "" || key == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请提供剧目链接与产物类型"))
		return
	}
	h.proxyPython(
		c,
		"/api/artifacts/file?url="+url.QueryEscape(rawURL)+"&key="+url.QueryEscape(key),
		aiHTTPClient,
	)
}

// AICreateJob 用服务端密钥创建整剧生成任务（前端不接触 API Key）。
func (h *Handlers) AICreateJob(c *gin.Context) {
	var body struct {
		URL    string `json:"url"`
		Cookie string `json:"cookie"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.URL) == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请填写 ShortFlix 剧目链接"))
		return
	}
	key := aiAPIKey()
	if key == "" {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "服务端未配置 AI_API_KEY"))
		return
	}
	payload := map[string]any{
		"source":          "online",
		"url":             strings.TrimSpace(body.URL),
		"cookie":          body.Cookie,
		"subtitle_source": "auto",
		"engine":          "bcut",
		"workers":         3,
		"batch_size":      3,
		"llm": map[string]any{
			"base_url":    aiBaseURL(),
			"api_key":     key,
			"model":       aiTextModel(),
			"temperature": 0.8,
			"max_tokens":  8192,
		},
	}
	raw, _ := json.Marshal(payload)
	resp, err := doPython(c, http.MethodPost, "/api/jobs", raw, jobHTTPClient)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "无法连接生成服务，请先启动 miniseadrama（python run.py --host 0.0.0.0）"))
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	c.Data(resp.StatusCode, "application/json; charset=utf-8", data)
}

// AIGetJob 查询生成任务进度。
func (h *Handlers) AIGetJob(c *gin.Context) {
	h.proxyPython(c, "/api/jobs/"+c.Param("id"), jobHTTPClient)
}

// AIGetJobFile 下载生成任务产物（Word / meta.json）。
func (h *Handlers) AIGetJobFile(c *gin.Context) {
	h.proxyPython(c, "/api/jobs/"+c.Param("id")+"/files/"+c.Param("key"), aiHTTPClient)
}

// AIPauseJob 暂停生成任务（在安全点停下，可继续）。
func (h *Handlers) AIPauseJob(c *gin.Context) {
	h.jobControl(c, "pause")
}

// AIResumeJob 继续已暂停的生成任务。
func (h *Handlers) AIResumeJob(c *gin.Context) {
	h.jobControl(c, "resume")
}

func (h *Handlers) jobControl(c *gin.Context, action string) {
	resp, err := doPython(
		c,
		http.MethodPost,
		"/api/jobs/"+c.Param("id")+"/"+action,
		[]byte("{}"),
		jobHTTPClient,
	)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "无法连接生成服务"))
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	c.Data(resp.StatusCode, "application/json; charset=utf-8", data)
}

// AIGenerateCover 用 tt-image-2.5 生成竖版 3:4 封面并回传 dataURL。
func (h *Handlers) AIGenerateCover(c *gin.Context) {
	var body struct {
		Prompt string `json:"prompt"`
		Title  string `json:"title"`
	}
	_ = c.ShouldBindJSON(&body)
	key := aiAPIKey()
	if key == "" {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "服务端未配置 AI_API_KEY"))
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		prompt = strings.TrimSpace(body.Title) + " 短剧海报，人物居中，电影感光影，高清细节，画面不要文字"
	}
	if len(prompt) > 800 {
		prompt = prompt[:800]
	}
	payload := map[string]any{
		"model":           aiImageModel(),
		"prompt":          prompt,
		"n":               1,
		"size":            "1024x1365",
		"response_format": "b64_json",
	}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, aiBaseURL()+"/images/generations", bytes.NewReader(raw))
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := aiHTTPClient.Do(req)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "生图服务连接失败"))
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if resp.StatusCode >= 400 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "生图失败："+strings.TrimSpace(string(data))))
		return
	}
	var parsed struct {
		Data []struct {
			B64 string `json:"b64_json"`
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil || len(parsed.Data) == 0 {
		respgin.WriteError(c, response.New(response.CodeInternal, "生图接口未返回图片"))
		return
	}
	item := parsed.Data[0]
	image := ""
	if item.B64 != "" {
		image = "data:image/png;base64," + item.B64
	} else if item.URL != "" {
		imgResp, err := aiHTTPClient.Get(item.URL)
		if err != nil {
			respgin.WriteError(c, response.New(response.CodeServiceUnavail, "封面图片下载失败"))
			return
		}
		defer imgResp.Body.Close()
		buf, _ := io.ReadAll(io.LimitReader(imgResp.Body, 20<<20))
		image = "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf)
	}
	if image == "" {
		respgin.WriteError(c, response.New(response.CodeInternal, "生图接口未返回图片"))
		return
	}
	respgin.Success(c, gin.H{"image": image})
}

// proxyPython 把只读请求透传给 Python 服务。
func (h *Handlers) proxyPython(c *gin.Context, path string, client *http.Client) {
	resp, err := doPython(c, http.MethodGet, path, nil, client)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "无法连接生成服务"))
		return
	}
	defer resp.Body.Close()
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Header("Content-Type", contentType)
	if disposition := resp.Header.Get("Content-Disposition"); disposition != "" {
		c.Header("Content-Disposition", disposition)
	}
	c.Status(resp.StatusCode)
	_, _ = io.Copy(c.Writer, resp.Body)
}
