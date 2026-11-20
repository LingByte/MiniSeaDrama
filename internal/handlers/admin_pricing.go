// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"

	"github.com/gin-gonic/gin"
)

// AdminPricing 批量更新剧本价格，并写入 priceHistory。
func (h *Handlers) AdminPricing(c *gin.Context) {
	if h.db == nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "数据库不可用"))
		return
	}
	var body struct {
		Changes []struct {
			ID    string  `json:"id"`
			Price float64 `json:"price"`
		} `json:"changes"`
		Note string `json:"note"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Changes) == 0 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请提供至少一条调价记录"))
		return
	}
	note := strings.TrimSpace(body.Note)
	if note == "" {
		note = "定价中心调价"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	updated := 0
	for _, ch := range body.Changes {
		id := strings.TrimSpace(ch.ID)
		if id == "" {
			continue
		}
		price := ch.Price
		if price < 0 {
			respgin.WriteError(c, response.New(response.CodeBadRequest, "价格不能为负数"))
			return
		}
		// 保留最多一位小数（支持 19.9 这类特价）
		price = float64(int(price*10+0.5)) / 10

		var row models.AdminScript
		if err := h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error; err != nil {
			respgin.WriteError(c, response.New(response.CodeNotFound, "剧本不存在："+id))
			return
		}
		script := row.ToScript()
		history, _ := script["priceHistory"].([]any)
		if history == nil {
			if raw, ok := script["priceHistory"].([]map[string]any); ok {
				for _, item := range raw {
					history = append(history, item)
				}
			}
		}
		history = append(history, map[string]any{
			"price": price,
			"at":    now,
			"note":  note,
		})
		script["price"] = price
		script["priceHistory"] = history
		script["id"] = id

		payload, err := json.Marshal(script)
		if err != nil {
			respgin.WriteError(c, response.New(response.CodeInternal, "序列化剧本失败"))
			return
		}
		if err := h.db.WithContext(c.Request.Context()).Model(&models.AdminScript{}).
			Where("script_id = ?", id).
			Update("payload", string(payload)).Error; err != nil {
			respgin.WriteError(c, response.New(response.CodeInternal, scriptSaveErrMsg(err)))
			return
		}
		updated++
	}
	respgin.Success(c, gin.H{"ok": true, "updated": updated})
}

// PatchAdminScript 局部更新（目前用于上下架状态）。
func (h *Handlers) PatchAdminScript(c *gin.Context) {
	id := c.Param("id")
	if h.db == nil || id == "" {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请求体无效"))
		return
	}
	status := strings.TrimSpace(body.Status)
	if status != "on" && status != "off" && status != "draft" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "状态仅支持 on / off / draft"))
		return
	}
	var row models.AdminScript
	if err := h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	script := row.ToScript()
	script["status"] = status
	script["id"] = id
	payload, err := json.Marshal(script)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, "序列化剧本失败"))
		return
	}
	if err := h.db.WithContext(c.Request.Context()).Model(&models.AdminScript{}).
		Where("script_id = ?", id).
		Update("payload", string(payload)).Error; err != nil {
		respgin.WriteError(c, response.New(response.CodeInternal, scriptSaveErrMsg(err)))
		return
	}
	row.Payload = string(payload)
	respgin.Success(c, gin.H{"script": row.ToScript()})
}
