// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const scriptFileDir = "data/scripts"

// AdminAll 返回管理端所需的全部数据（剧本 + 订单 + 标签分类）。
func (h *Handlers) AdminAll(c *gin.Context) {
	scripts := []map[string]any{}
	if h.db != nil {
		var rows []models.AdminScript
		if err := h.db.WithContext(c.Request.Context()).Order("updated_at DESC").Find(&rows).Error; err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
		for i := range rows {
			scripts = append(scripts, rows[i].ToScript())
		}
	}
	respgin.Success(c, gin.H{
		"scripts":   scripts,
		"orders":    []any{},
		"tagGroups": []any{},
	})
}

// Bootstrap 返回前台浏览所需的已上架剧本与标签分类。
func (h *Handlers) Bootstrap(c *gin.Context) {
	scripts := []map[string]any{}
	if h.db != nil {
		var rows []models.AdminScript
		if err := h.db.WithContext(c.Request.Context()).Order("updated_at DESC").Find(&rows).Error; err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
		for i := range rows {
			script := rows[i].ToScript()
			if strings.EqualFold(str(script["status"]), "on") {
				scripts = append(scripts, script)
			}
		}
	}
	respgin.Success(c, gin.H{"scripts": scripts, "tagGroups": []any{}})
}

// CreateAdminScript 新建剧本。
func (h *Handlers) CreateAdminScript(c *gin.Context) {
	var body struct {
		Script map[string]any `json:"script"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Script == nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本数据不完整"))
		return
	}
	id := str(body.Script["id"])
	if id == "" || str(body.Script["title"]) == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本 ID 或标题为空"))
		return
	}
	script, err := h.saveScript(c, id, body.Script)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	respgin.Success(c, gin.H{"script": script})
}

// UpsertAdminScript 幂等保存剧本（存在即更新，不存在则创建）。
func (h *Handlers) UpsertAdminScript(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Script map[string]any `json:"script"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Script == nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本数据不完整"))
		return
	}
	if str(body.Script["title"]) == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请至少填写中文剧名"))
		return
	}
	script, err := h.saveScript(c, id, body.Script)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	respgin.Success(c, gin.H{"script": script})
}

// DeleteAdminScript 删除剧本及其 Word 文件。
func (h *Handlers) DeleteAdminScript(c *gin.Context) {
	id := c.Param("id")
	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	var row models.AdminScript
	if err := h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	if row.FilePath != "" {
		_ = os.Remove(row.FilePath)
	}
	if err := h.db.WithContext(c.Request.Context()).Delete(&row).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	respgin.Success(c, gin.H{"ok": true})
}

// UploadAdminScriptFile 接收原始 Word 内容并落盘（文件名从 query 读取）。
func (h *Handlers) UploadAdminScriptFile(c *gin.Context) {
	id := c.Param("id")
	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeServiceUnavail))
		return
	}
	var row models.AdminScript
	if err := h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}

	name := strings.ReplaceAll(c.Query("filename"), "\\", "/")
	name = filepath.Base(strings.TrimSpace(name))
	ext := strings.ToLower(filepath.Ext(name))
	if ext != ".doc" && ext != ".docx" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "只支持 .doc / .docx 文件"))
		return
	}
	data, err := io.ReadAll(io.LimitReader(c.Request.Body, 200<<20))
	if err != nil || len(data) == 0 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "文件内容为空"))
		return
	}
	if err := os.MkdirAll(scriptFileDir, 0o755); err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	path := filepath.Join(scriptFileDir, safeScriptID(id)+ext)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	updates := map[string]any{
		"file_name": name,
		"file_size": len(data),
		"file_path": path,
	}
	if err := h.db.WithContext(c.Request.Context()).Model(&models.AdminScript{}).
		Where("script_id = ?", id).Updates(updates).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	row.FileName = name
	row.FileSize = int64(len(data))
	row.FilePath = path
	respgin.Success(c, gin.H{
		"script":   row.ToScript(),
		"fileName": name,
		"fileSize": len(data),
	})
}

// DownloadScriptFile 下载剧本 Word（管理员或已购买用户）。
func (h *Handlers) DownloadScriptFile(c *gin.Context) {
	id := c.Param("id")
	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	var row models.AdminScript
	if err := h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	if row.FilePath == "" {
		respgin.WriteError(c, response.New(response.CodeNotFound, "该剧本尚未上传 Word 文件"))
		return
	}
	if _, err := os.Stat(row.FilePath); err != nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "该剧本尚未上传 Word 文件"))
		return
	}
	name := row.FileName
	if name == "" {
		name = row.ScriptID + filepath.Ext(row.FilePath)
	}
	c.Header("Content-Disposition", "attachment; filename*=UTF-8''"+urlQueryEscape(name))
	c.Header("Cache-Control", "no-store, private")
	c.File(row.FilePath)
}

// saveScript 写入或更新剧本 JSON，并返回前端可直接使用的结构。
func (h *Handlers) saveScript(c *gin.Context, id string, script map[string]any) (map[string]any, error) {
	if h.db == nil {
		return nil, errors.New("database unavailable")
	}
	script["id"] = id
	payload, err := json.Marshal(script)
	if err != nil {
		return nil, err
	}

	var row models.AdminScript
	err = h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		row = models.AdminScript{ScriptID: id, Payload: string(payload)}
		if err := h.db.WithContext(c.Request.Context()).Create(&row).Error; err != nil {
			return nil, err
		}
	case err != nil:
		return nil, err
	default:
		if err := h.db.WithContext(c.Request.Context()).Model(&models.AdminScript{}).
			Where("script_id = ?", id).
			Update("payload", string(payload)).Error; err != nil {
			return nil, err
		}
		row.Payload = string(payload)
	}
	return row.ToScript(), nil
}

func str(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func safeScriptID(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "script"
	}
	return b.String()
}

func urlQueryEscape(value string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || strings.ContainsRune("-_.~", rune(ch)) {
			b.WriteByte(ch)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[ch>>4])
		b.WriteByte(hex[ch&0x0f])
	}
	return b.String()
}
