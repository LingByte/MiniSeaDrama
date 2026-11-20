// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/models"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const scriptFileDir = "data/scripts" // 仅兼容旧本地路径

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
			scripts = append(scripts, withResolvedCover(rows[i].ToScript()))
		}
	}
	respgin.Success(c, gin.H{
		"scripts":   scripts,
		"orders":    h.listAllOrdersAPI(),
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
			script := withResolvedCover(rows[i].ToScript())
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
		respgin.WriteError(c, response.New(response.CodeInternal, scriptSaveErrMsg(err)))
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
		respgin.WriteError(c, response.New(response.CodeInternal, scriptSaveErrMsg(err)))
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

// UploadAdminScriptFile 接收 Word 并写入对象存储（file_path 存 storage key）。
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
	if err := pkgstorage.CheckFileSize(int64(len(data))); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	key := pkgstorage.ObjectKey("scripts", safeScriptID(id), fmt.Sprintf("%d_%s", time.Now().Unix(), name))
	if err := pkgstorage.Write(key, bytes.NewReader(data)); err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "写入对象存储失败："+err.Error()))
		return
	}

	updates := map[string]any{
		"file_name": name,
		"file_size": len(data),
		"file_path": key,
	}
	if err := h.db.WithContext(c.Request.Context()).Model(&models.AdminScript{}).
		Where("script_id = ?", id).Updates(updates).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	row.FileName = name
	row.FileSize = int64(len(data))
	row.FilePath = key
	respgin.Success(c, gin.H{
		"script":   withResolvedCover(row.ToScript()),
		"fileName": name,
		"fileSize": len(data),
		"fileKey":  key,
	})
}

// DownloadScriptFile 鉴权后签发带过期时间的下载 URL（不再直出文件流）。
func (h *Handlers) DownloadScriptFile(c *gin.Context) {
	id := c.Param("id")
	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	email, role, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
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
	if !strings.EqualFold(role, "admin") {
		var n int64
		_ = h.db.WithContext(c.Request.Context()).Model(&models.Order{}).
			Where("script_id = ? AND account = ? AND status = ?", id, email, "paid").
			Count(&n)
		if n == 0 {
			respgin.WriteError(c, response.New(response.CodeForbidden, "购买后才能下载完整剧本"))
			return
		}
	}

	name := row.FileName
	if name == "" {
		name = row.ScriptID + ".docx"
	}
	expiresAt := time.Now().Add(pkgstorage.DownloadURLTTL)

	key := row.FilePath
	if ok, _ := pkgstorage.Exists(key); !ok {
		// 兼容旧本地盘路径：迁入对象存储后再签发
		if _, err := os.Stat(row.FilePath); err != nil {
			respgin.WriteError(c, response.New(response.CodeNotFound, "该剧本尚未上传 Word 文件"))
			return
		}
		data, err := os.ReadFile(row.FilePath)
		if err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
		key = pkgstorage.ObjectKey("scripts", safeScriptID(id), name)
		if err := pkgstorage.PutBytes(key, data); err != nil {
			respgin.WriteError(c, response.New(response.CodeInternal, "迁移文件到对象存储失败"))
			return
		}
		_ = h.db.WithContext(c.Request.Context()).Model(&models.AdminScript{}).
			Where("script_id = ?", id).Update("file_path", key)
	}
	u, err := pkgstorage.SignedURL(key, pkgstorage.DownloadURLTTL)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "签发下载链接失败"))
		return
	}
	respgin.Success(c, gin.H{
		"url": u, "expiresAt": expiresAt.UTC().Format(time.RFC3339),
		"fileName": name, "fileKey": key,
	})
}

// saveScript 写入或更新剧本 JSON，并返回前端可直接使用的结构。
func (h *Handlers) saveScript(c *gin.Context, id string, script map[string]any) (map[string]any, error) {
	if h.db == nil {
		return nil, errors.New("database unavailable")
	}
	script["id"] = id
	// 封面禁止 base64 入库：data URL 上传对象存储，只存 key
	if cover, err := persistCoverValue(id, str(script["cover"])); err != nil {
		return nil, err
	} else {
		script["cover"] = cover
	}
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
	return withResolvedCover(row.ToScript()), nil
}

func str(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

// scriptSaveErrMsg 把常见落库失败转成可操作的提示（payload 超 TEXT 等）。
func scriptSaveErrMsg(err error) string {
	if err == nil {
		return "保存失败"
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "data too long"),
		strings.Contains(lower, "1406"),
		strings.Contains(msg, "Data too long for column 'payload'"):
		return "剧本内容过大，无法写入数据库。请缩短分集正文后重试，或联系管理员将 payload 升级为 LONGTEXT。"
	case strings.Contains(lower, "packet bigger"),
		strings.Contains(lower, "max_allowed_packet"):
		return "剧本内容超过 MySQL 单包上限，请缩短分集正文或调大 max_allowed_packet。"
	default:
		return "保存剧本失败：" + msg
	}
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
