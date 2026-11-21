// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/models"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"
)

// persistCoverValue 把封面规范成「对象存储 key」：
// - data:image… → 上传后返回 key
// - 已是 http(s) / media URL → 尽量保留；过长 data 禁止入库
// - 已是 storage key → 原样返回
func persistCoverValue(scriptID, cover string) (string, error) {
	cover = strings.TrimSpace(cover)
	if cover == "" {
		return "", nil
	}
	if strings.HasPrefix(cover, "data:") {
		key, err := uploadDataURLCover(scriptID, cover)
		if err != nil {
			return "", err
		}
		return key, nil
	}
	if strings.HasPrefix(cover, "http://") || strings.HasPrefix(cover, "https://") {
		if len(cover) > 2048 {
			return "", fmt.Errorf("封面 URL 过长")
		}
		return cover, nil
	}
	if strings.HasPrefix(cover, pkgstorage.MediaPath) {
		// 已签名 URL 不能入库（会过期）；尝试抽出 key
		if k := extractMediaKey(cover); k != "" {
			return k, nil
		}
		return "", fmt.Errorf("封面签名链接不能直接保存，请重新上传封面")
	}
	if pkgstorage.IsStorageKey(cover) {
		return strings.TrimPrefix(cover, "/"), nil
	}
	return "", fmt.Errorf("不支持的封面格式")
}

func uploadDataURLCover(scriptID, dataURL string) (string, error) {
	comma := strings.Index(dataURL, ",")
	if comma < 0 {
		return "", fmt.Errorf("封面 data URL 无效")
	}
	meta := dataURL[:comma]
	raw := dataURL[comma+1:]
	ext := ".png"
	switch {
	case strings.Contains(meta, "image/jpeg"), strings.Contains(meta, "image/jpg"):
		ext = ".jpg"
	case strings.Contains(meta, "image/webp"):
		ext = ".webp"
	case strings.Contains(meta, "image/gif"):
		ext = ".gif"
	}
	bin, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		bin, err = base64.RawStdEncoding.DecodeString(raw)
	}
	if err != nil {
		return "", fmt.Errorf("封面 base64 解码失败")
	}
	_ = ext // 统一压成 JPEG
	compressed, err := pkgstorage.CompressCover(bin)
	if err != nil {
		return "", fmt.Errorf("封面压缩失败：%w", err)
	}
	bin = compressed
	if err := pkgstorage.CheckFileSize(int64(len(bin))); err != nil {
		return "", err
	}
	id := safeScriptID(scriptID)
	if id == "" {
		id = "cover"
	}
	key := pkgstorage.CoverObjectKey("covers", id, fmt.Sprintf("%d.jpg", time.Now().UnixNano()))
	if err := pkgstorage.PutBytes(key, bin); err != nil {
		return "", fmt.Errorf("封面写入对象存储失败：%w", err)
	}
	return key, nil
}

func extractMediaKey(u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return sanitizePath(parsed.Query().Get("key"))
}

// withResolvedCover 把脚本里的 cover key 展开成可访问的签名 URL（仅响应，不回写 DB）。
func withResolvedCover(script map[string]any) map[string]any {
	if script == nil {
		return script
	}
	cover := str(script["cover"])
	if cover == "" {
		return script
	}
	if resolved := pkgstorage.ResolveAccessURL(cover, pkgstorage.DisplayURLTTL); resolved != "" {
		script["cover"] = resolved
		if pkgstorage.IsStorageKey(cover) {
			script["coverKey"] = cover
		}
	} else if strings.HasPrefix(cover, "data:") {
		script["cover"] = ""
	}
	return script
}

// resolveAccessURL 展开对象存储 key / 旧路径为可访问 URL；已是 http(s) 则原样返回。
func resolveAccessURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "data:") {
		return ""
	}
	if resolved := pkgstorage.ResolveAccessURL(raw, pkgstorage.DisplayURLTTL); resolved != "" {
		return resolved
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	return ""
}

// resolveAvatar 返回展示 URL + 入库 key（若有）。
func resolveAvatar(raw string) (url string, key string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if pkgstorage.IsStorageKey(raw) {
		return resolveAccessURL(raw), raw
	}
	if u := resolveAccessURL(raw); u != "" {
		return u, ""
	}
	return "", ""
}

// enrichOrderAPI 补封面签名 URL；订单未存封面时回退到剧本 cover。
func (h *Handlers) enrichOrderAPI(o models.Order, mine bool) map[string]any {
	api := o.ToAPI(mine)
	cover := strings.TrimSpace(o.Cover)
	if cover == "" && h.db != nil && o.ScriptID != "" {
		var row models.AdminScript
		if err := h.db.Select("payload").First(&row, "script_id = ?", o.ScriptID).Error; err == nil {
			script := row.ToScript()
			cover = str(script["cover"])
		}
	}
	api["cover"] = resolveAccessURL(cover)
	return api
}
