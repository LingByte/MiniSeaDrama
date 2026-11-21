// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"errors"
	"strings"

	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// GetMe GET /api/v1/me — 当前登录用户资料（含头像展示 URL）。
func (h *Handlers) GetMe(c *gin.Context) {
	email, role, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
		return
	}
	user, err := models.User{}.FindByEmail(h.db.WithContext(c.Request.Context()), email)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respgin.WriteError(c, response.Err(response.CodeNotFound))
			return
		}
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	avatarURL, avatarKey := resolveAvatar(user.Avatar)
	outRole := role
	if user.Role == models.UserRoleAdmin {
		outRole = "admin"
	} else if outRole == "" {
		outRole = "buyer"
	}
	respgin.Success(c, gin.H{
		"email":     user.Email,
		"username":  user.Username,
		"role":      outRole,
		"avatar":    avatarURL,
		"avatarKey": avatarKey,
	})
}

// UpdateMe PATCH /api/v1/me — 更新当前用户资料（目前支持头像 key）。
func (h *Handlers) UpdateMe(c *gin.Context) {
	email, _, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
		return
	}
	var body struct {
		Avatar *string `json:"avatar"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请求体无效"))
		return
	}
	user, err := models.User{}.FindByEmail(h.db.WithContext(c.Request.Context()), email)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}
	updates := map[string]any{}
	if body.Avatar != nil {
		key := strings.TrimSpace(*body.Avatar)
		// 只存对象存储 key，禁止 data URL / 超长签名链
		if strings.HasPrefix(key, "data:") {
			respgin.WriteError(c, response.New(response.CodeBadRequest, "请先上传头像到对象存储"))
			return
		}
		if strings.HasPrefix(key, "http://") || strings.HasPrefix(key, "https://") || strings.HasPrefix(key, "/") {
			if extracted := extractMediaKey(key); extracted != "" {
				key = extracted
			} else {
				respgin.WriteError(c, response.New(response.CodeBadRequest, "头像请使用对象存储 key"))
				return
			}
		}
		if len(key) > 500 {
			respgin.WriteError(c, response.New(response.CodeBadRequest, "头像 key 过长"))
			return
		}
		updates["avatar"] = key
	}
	if len(updates) == 0 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "没有可更新的字段"))
		return
	}
	if err := user.Updates(h.db.WithContext(c.Request.Context()), updates); err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	_ = h.db.WithContext(c.Request.Context()).First(user, user.ID)
	avatarURL, avatarKey := resolveAvatar(user.Avatar)
	role := "buyer"
	if user.Role == models.UserRoleAdmin {
		role = "admin"
	}
	respgin.Success(c, gin.H{
		"email":     user.Email,
		"username":  user.Username,
		"role":      role,
		"avatar":    avatarURL,
		"avatarKey": avatarKey,
	})
}
