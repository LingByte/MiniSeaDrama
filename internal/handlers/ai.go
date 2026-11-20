// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/internal/pipeline"
	"github.com/LingByte/miniseadrama/internal/pipeline/jobs"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"

	"github.com/gin-gonic/gin"
)

var aiHTTPClient = &http.Client{Timeout: 180 * time.Second}

const docxMediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

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

// AIConfig 返回服务端已配置的模型信息（不含 API Key），供管理端只读展示。
func (h *Handlers) AIConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"base_url":    aiBaseURL(),
		"text_model":  aiTextModel(),
		"image_model": aiImageModel(),
		"has_api_key": aiAPIKey() != "",
	})
}

func writePipelineErr(c *gin.Context, err error) {
	if status, msg, ok := pipeline.APIErrorStatus(err); ok {
		code := response.CodeBadRequest
		switch status {
		case 404:
			code = response.CodeNotFound
		case 403:
			code = response.CodeForbidden
		}
		respgin.WriteError(c, response.New(code, msg))
		return
	}
	respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
}

// AICatalog 浏览 ShortFlix 短剧库（封面 + 标题），支持 cursor 分页与 q 搜索。
func (h *Handlers) AICatalog(c *gin.Context) {
	cookie, err := shortflixCookieOrFill(c.Query("cookie"))
	if err != nil {
		cookie = ""
	}
	var titles []string
	if h.db != nil {
		var rows []models.AdminScript
		if err := h.db.WithContext(c.Request.Context()).Find(&rows).Error; err == nil {
			for i := range rows {
				script := rows[i].ToScript()
				if t := str(script["title"]); t != "" {
					titles = append(titles, t)
				}
				if t := str(script["enTitle"]); t != "" {
					titles = append(titles, t)
				}
			}
		}
	}
	refresh := c.Query("refresh") == "1" || c.Query("refresh") == "true"
	page, err := pipeline.ListCatalogPage(
		cookie,
		strings.TrimSpace(c.Query("cursor")),
		strings.TrimSpace(c.Query("q")),
		48,
		titles,
		refresh,
	)
	if err != nil {
		writePipelineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"items":       page.Items,
		"count":       len(page.Items),
		"next_cursor": page.NextCursor,
		"has_more":    page.HasMore,
	})
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
	cookie, err := shortflixCookieOrFill(body.Cookie)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "ShortFlix 自动登录失败："+err.Error()))
		return
	}
	payload, err := pipeline.InspectSeries(strings.TrimSpace(body.URL), pipeline.ParseCookieHeader(cookie))
	if err != nil {
		writePipelineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, payload)
}

// AIExistingArtifacts 列出该剧工作目录里已存在的产物（任务未完成时也能用）。
func (h *Handlers) AIExistingArtifacts(c *gin.Context) {
	rawURL := strings.TrimSpace(c.Query("url"))
	if rawURL == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请提供 ShortFlix 剧目链接"))
		return
	}
	payload, err := pipeline.ListArtifacts(rawURL)
	if err != nil {
		writePipelineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, payload)
}

// AIExistingArtifactFile 下载已存在的产物文件。
func (h *Handlers) AIExistingArtifactFile(c *gin.Context) {
	rawURL := strings.TrimSpace(c.Query("url"))
	key := strings.TrimSpace(c.Query("key"))
	if rawURL == "" || key == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请提供剧目链接与产物类型"))
		return
	}
	path, name, err := pipeline.ResolveArtifactPath(rawURL, key)
	if err != nil {
		writePipelineErr(c, err)
		return
	}
	serveArtifactFile(c, path, name)
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
	cookie, err := shortflixCookieOrFill(body.Cookie)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "ShortFlix 自动登录失败："+err.Error()))
		return
	}
	params, err := pipeline.ValidateJobParams(map[string]any{
		"url":    strings.TrimSpace(body.URL),
		"cookie": pipeline.ParseCookieHeader(cookie),
		"engine": "bcut",
		"workers": 3, "batch_size": 3,
		"llm": map[string]any{
			"base_url": aiBaseURL(), "api_key": key, "model": aiTextModel(),
			"temperature": 0.8, "max_tokens": 8192, "timeout": 900,
		},
	})
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	if err := pipeline.CheckFFmpeg(fmt.Sprint(params["ffmpeg"])); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	_ = pipeline.EnsureDirs()
	job := jobs.DefaultManager.Create(params)
	c.JSON(http.StatusOK, job.ToDict(false))
}

// AIListJobs 列出近期生成任务（后台多任务面板用）。
func (h *Handlers) AIListJobs(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"items":       jobs.DefaultManager.List(),
		"max_workers": jobs.DefaultManager.MaxWorkers(),
	})
}

// AIGetJob 查询生成任务进度。
func (h *Handlers) AIGetJob(c *gin.Context) {
	job := jobs.DefaultManager.Get(c.Param("id"))
	if job == nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务不存在。"))
		return
	}
	c.JSON(http.StatusOK, job.ToDict(false))
}

// AIGetJobFile 下载生成任务产物（Word / meta.json）。
func (h *Handlers) AIGetJobFile(c *gin.Context) {
	job := jobs.DefaultManager.Get(c.Param("id"))
	if job == nil || job.Result == nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务结果不存在。"))
		return
	}
	key := c.Param("key")
	workdir := filepath.Clean(fmt.Sprint(job.Result["workdir"]))
	var artifacts []map[string]any
	switch raw := job.Result["artifacts"].(type) {
	case []map[string]any:
		artifacts = raw
	case []any:
		for _, item := range raw {
			if m, ok := item.(map[string]any); ok {
				artifacts = append(artifacts, m)
			}
		}
	}
	var artifact map[string]any
	for _, item := range artifacts {
		if fmt.Sprint(item["key"]) == key {
			artifact = item
			break
		}
	}
	if artifact == nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "文件不存在。"))
		return
	}
	path := filepath.Clean(fmt.Sprint(artifact["path"]))
	rel, err := filepath.Rel(workdir, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		respgin.WriteError(c, response.New(response.CodeForbidden, "不允许下载工作目录之外的文件。"))
		return
	}
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		respgin.WriteError(c, response.New(response.CodeNotFound, "文件已被移动或删除。"))
		return
	}
	serveArtifactFile(c, path, filepath.Base(path))
}

// AIGetJobEpisodeSubtitle 查看某集字幕原文（下载成功后可读）。
func (h *Handlers) AIGetJobEpisodeSubtitle(c *gin.Context) {
	job := jobs.DefaultManager.Get(c.Param("id"))
	if job == nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务不存在。"))
		return
	}
	var episode int
	if _, err := fmt.Sscanf(c.Param("n"), "%d", &episode); err != nil || episode < 1 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "集数无效"))
		return
	}
	workdir := job.Workdir()
	if workdir == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "任务尚未创建工作目录"))
		return
	}
	content, name, err := pipeline.ReadEpisodeSubtitle(workdir, episode)
	if err != nil {
		writePipelineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"number": episode, "file": name, "content": content, "status": "ok",
	})
}

// AIRetryJobEpisodeSubtitle 对失败集（如 HTTP 502）重新拉取官方字幕。
func (h *Handlers) AIRetryJobEpisodeSubtitle(c *gin.Context) {
	job := jobs.DefaultManager.Get(c.Param("id"))
	if job == nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务不存在。"))
		return
	}
	var episode int
	if _, err := fmt.Sscanf(c.Param("n"), "%d", &episode); err != nil || episode < 1 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "集数无效"))
		return
	}
	workdir := job.Workdir()
	urlStr := job.ParamString("url")
	cookie := job.ParamString("cookie")
	job.PatchEpisodeSub(episode, "running", "")
	result, err := pipeline.RetryEpisodeSubtitle(urlStr, cookie, workdir, episode)
	if err != nil {
		errMsg := err.Error()
		if result != nil {
			if e, ok := result["error"].(string); ok && e != "" {
				errMsg = e
			}
		}
		job.PatchEpisodeSub(episode, "fail", errMsg)
		writePipelineErr(c, err)
		return
	}
	job.PatchEpisodeSub(episode, "ok", "")
	c.JSON(http.StatusOK, result)
}

// AIPauseJob 暂停生成任务（在安全点停下，可继续）。
func (h *Handlers) AIPauseJob(c *gin.Context) {
	if !jobs.DefaultManager.Pause(c.Param("id")) {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务不存在或已结束。"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "paused": true})
}

// AIResumeJob 继续已暂停的生成任务。
func (h *Handlers) AIResumeJob(c *gin.Context) {
	if !jobs.DefaultManager.Resume(c.Param("id")) {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务不存在。"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "paused": false})
}

// AICancelJob 取消生成任务。
func (h *Handlers) AICancelJob(c *gin.Context) {
	if !jobs.DefaultManager.Cancel(c.Param("id")) {
		respgin.WriteError(c, response.New(response.CodeNotFound, "任务不存在。"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func serveArtifactFile(c *gin.Context, path, filename string) {
	if strings.EqualFold(filepath.Ext(path), ".docx") {
		c.Header("Content-Type", docxMediaType)
	} else if strings.EqualFold(filepath.Ext(path), ".json") {
		c.Header("Content-Type", "application/json; charset=utf-8")
	} else {
		c.Header("Content-Type", "text/plain; charset=utf-8")
	}
	c.FileAttachment(path, filename)
}

// AIGenerateCover 用 tt-image-2.5 生成竖版 3:4 封面，写入对象存储后回传签名 URL。
// 英文标题由模型直接画进海报（电影海报式排版），不走前端叠字。
func (h *Handlers) AIGenerateCover(c *gin.Context) {
	var body struct {
		Prompt  string `json:"prompt"`
		Title   string `json:"title"`
		EnTitle string `json:"enTitle"`
	}
	_ = c.ShouldBindJSON(&body)
	key := aiAPIKey()
	if key == "" {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "服务端未配置 AI_API_KEY"))
		return
	}
	enTitle := strings.TrimSpace(body.EnTitle)
	if enTitle == "" {
		enTitle = strings.TrimSpace(body.Title)
	}
	prompt := buildCoverPrompt(strings.TrimSpace(body.Prompt), strings.TrimSpace(body.Title), enTitle)
	if len(prompt) > 800 {
		prompt = prompt[:800]
	}
	payload := map[string]any{
		"model": aiImageModel(), "prompt": prompt, "n": 1,
		"size": "1024x1365", "response_format": "b64_json",
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
	var bin []byte
	if item.B64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(item.B64)
		if err != nil {
			decoded, err = base64.RawStdEncoding.DecodeString(item.B64)
		}
		if err != nil {
			respgin.WriteError(c, response.New(response.CodeInternal, "生图 base64 解码失败"))
			return
		}
		bin = decoded
	} else if item.URL != "" {
		imgResp, err := aiHTTPClient.Get(item.URL)
		if err != nil {
			respgin.WriteError(c, response.New(response.CodeServiceUnavail, "封面图片下载失败"))
			return
		}
		defer imgResp.Body.Close()
		bin, _ = io.ReadAll(io.LimitReader(imgResp.Body, 20<<20))
	}
	if len(bin) == 0 {
		respgin.WriteError(c, response.New(response.CodeInternal, "生图接口未返回图片"))
		return
	}
	objectKey := pkgstorage.ObjectKey("covers", "ai", fmt.Sprintf("%d.png", time.Now().UnixNano()))
	if err := pkgstorage.PutBytes(objectKey, bin); err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "封面写入对象存储失败："+err.Error()))
		return
	}
	url, err := pkgstorage.SignedURL(objectKey, pkgstorage.DisplayURLTTL)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "签发封面链接失败"))
		return
	}
	// 只回传对象 key + 临时访问 URL，禁止 data URL / base64 回写数据库
	respgin.Success(c, gin.H{"image": url, "key": objectKey, "url": url})
}

// buildCoverPrompt 组装生图提示：保留画面描述，去掉「不要文字」类约束，并要求模型画出英文标题。
func buildCoverPrompt(visual, cnTitle, enTitle string) string {
	visual = stripNoTextInstructions(visual)
	if visual == "" {
		if cnTitle != "" {
			visual = cnTitle + " short drama movie poster, centered characters, cinematic lighting, ultra detailed"
		} else {
			visual = "short drama movie poster, centered characters, cinematic lighting, ultra detailed"
		}
	}
	title := enTitle
	if title == "" {
		title = cnTitle
	}
	if title == "" {
		return visual + ", vertical 3:4 poster"
	}
	// 明确要求模型把英文标题画进画面，并给出精确拼写
	return visual + fmt.Sprintf(
		". Vertical 3:4 short-drama movie poster. Prominently display the English title text \"%s\" "+
			"as elegant cinematic poster typography near the bottom or integrated into the composition. "+
			"Spell the title exactly as given. No other random text, logos, or watermarks.",
		title,
	)
}

var noTextPhrases = []string{
	"画面不要文字", "画面不要任何文字", "不要任何文字", "不要文字",
	"不要出现任何文字", "不要出现文字", "无文字", "纯画面无字",
	"no text", "no title text", "without text", "without any text",
	"no letters", "no typography", "textless",
}

func stripNoTextInstructions(prompt string) string {
	out := prompt
	for _, p := range noTextPhrases {
		out = strings.ReplaceAll(out, p, "")
		out = strings.ReplaceAll(out, strings.ToUpper(p), "")
	}
	// 清理多余标点空白
	out = strings.ReplaceAll(out, "，，", "，")
	out = strings.ReplaceAll(out, ",,", ",")
	out = strings.ReplaceAll(out, "。。", "。")
	return strings.TrimSpace(strings.Trim(out, "，,。.;； "))
}
