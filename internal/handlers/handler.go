// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/constants"
	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/internal/types"

	"github.com/LingByte/miniseadrama/pkg/common/password"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"
	"github.com/LingByte/miniseadrama/pkg/common/validate"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// System endpoints

// Health returns the overall health status.
func (h *Handlers) Health(c *gin.Context) {
	respgin.Success(c, gin.H{
		"status":  "healthy",
		"uptime":  time.Since(h.startTime).String(),
		"env":     h.cfg.App.Environment,
		"version": h.info.Version,
	})
}

// Liveness is the Kubernetes liveness probe endpoint.
func (h *Handlers) Liveness(c *gin.Context) {
	respgin.Success(c, gin.H{"status": "alive"})
}

// Readiness is the Kubernetes readiness probe endpoint.
func (h *Handlers) Readiness(c *gin.Context) {
	respgin.Success(c, gin.H{"status": "ready"})
}

// Version returns build and version metadata.
func (h *Handlers) Version(c *gin.Context) {
	respgin.Success(c, gin.H{
		"name":      h.info.Name,
		"version":   h.info.Version,
		"buildTime": h.info.BuildTime,
		"gitCommit": h.info.GitCommit,
	})
}

// User CRUD + registration + password management

// ListUsers returns a paginated, filterable list of users.
func (h *Handlers) ListUsers(c *gin.Context) {
	var req types.UserListRequest
	if err := c.ShouldBindQuery(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	page, size := req.Normalize()

	if h.db == nil {
		users := []types.UserResponse{
			{ID: 1, Username: "alice", Email: "alice@example.com", Role: "user", Status: 1, CreatedAt: time.Now()},
			{ID: 2, Username: "bob", Email: "bob@example.com", Role: "user", Status: 1, CreatedAt: time.Now()},
		}
		respgin.Success(c, response.NewPage(users, int64(len(users)), page, size))
		return
	}

	f := models.ListFilter{
		Keyword: req.Keyword,
		Status:  req.Status,
		Role:    req.Role,
	}
	users, total, err := models.User{}.List(h.db.WithContext(c.Request.Context()), page, size, f)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	result := make([]types.UserResponse, len(users))
	for i := range users {
		result[i] = types.ToUserResponse(&users[i])
	}
	respgin.Success(c, response.NewPage(result, total, page, size))
}

// GetUser returns a single user by ID.
func (h *Handlers) GetUser(c *gin.Context) {
	var req types.IDRequest
	if err := c.ShouldBindUri(&req); err != nil {
		respgin.WriteError(c, response.Err(response.CodeBadRequest))
		return
	}

	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}

	user, err := models.User{}.FindByID(h.db.WithContext(c.Request.Context()), req.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respgin.WriteError(c, response.Err(response.CodeNotFound))
			return
		}
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	respgin.Success(c, types.ToUserResponse(user))
}

// RegisterUser creates a new user account (public registration endpoint).
// Supports both username and email based registration.
// If username is not provided, it defaults to the email prefix.
// Role is always "user"; administrators are created only via -seed + ADMIN_* env.
func (h *Handlers) RegisterUser(c *gin.Context) {
	var req types.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	if err := validate.Validate(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}

	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeServiceUnavail))
		return
	}

	// If username not provided, derive from email prefix
	username := strings.TrimSpace(req.Username)
	if username == "" {
		at := indexOf(req.Email, "@")
		if at > 0 {
			username = req.Email[:at]
		} else {
			username = req.Email
		}
	}

	ctxDB := h.db.WithContext(c.Request.Context())
	emailTaken, err := models.User{}.EmailExists(ctxDB, req.Email)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	if emailTaken {
		respgin.WriteError(c, response.New(response.CodeConflict, "该邮箱已被注册，请直接登录或换一个邮箱"))
		return
	}
	// 邮箱前缀常撞上已有用户名（如 admin）；自动换一个可用名，避免阴间「资源冲突」
	unique, err := allocateUsername(ctxDB, username)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	username = unique

	// Hash password using ling-base/common/password (Argon2id by default)
	hashed, err := password.Hash(req.Password, nil)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	user := models.User{
		Username: username,
		Email:    req.Email,
		Phone:    req.Phone,
		Password: hashed,
		Role:     models.UserRoleUser,
		Status:   models.UserStatusActive,
	}

	if err := user.Create(h.db.WithContext(c.Request.Context())); err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	h.publish(c.Request.Context(), constants.EventUserRegistered, h, types.UserRegisteredEvent{
		UserID:   user.ID,
		Username: user.Username,
		Email:    user.Email,
	})
	respgin.Created(c, types.ToUserResponse(&user))
}

// CreateUser creates a new user. Role is always "user" (admins via -seed only).
func (h *Handlers) CreateUser(c *gin.Context) {
	var req types.CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	if err := validate.Validate(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}

	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeServiceUnavail))
		return
	}

	ctxDB := h.db.WithContext(c.Request.Context())
	nameTaken, err := models.User{}.UsernameExists(ctxDB, req.Username)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	if nameTaken {
		respgin.WriteError(c, response.New(response.CodeConflict, "该用户名已被占用，请换一个"))
		return
	}
	emailTaken, err := models.User{}.EmailExists(ctxDB, req.Email)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	if emailTaken {
		respgin.WriteError(c, response.New(response.CodeConflict, "该邮箱已被注册，请直接登录或换一个邮箱"))
		return
	}

	// Hash password using ling-base/common/password
	hashed, err := password.Hash(req.Password, nil)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	// Admins can only be provisioned via `go run ./cmd/server -seed` + ADMIN_* env.
	user := models.User{
		Username: req.Username,
		Email:    req.Email,
		Phone:    req.Phone,
		Password: hashed,
		Role:     models.UserRoleUser,
		Status:   models.UserStatusActive,
	}

	if err := user.Create(h.db.WithContext(c.Request.Context())); err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	h.publish(c.Request.Context(), constants.EventUserRegistered, h, types.UserRegisteredEvent{
		UserID:   user.ID,
		Username: user.Username,
		Email:    user.Email,
	})
	respgin.Created(c, types.ToUserResponse(&user))
}

// UpdateUser updates a user's profile fields.
func (h *Handlers) UpdateUser(c *gin.Context) {
	var idReq types.IDRequest
	if err := c.ShouldBindUri(&idReq); err != nil {
		respgin.WriteError(c, response.Err(response.CodeBadRequest))
		return
	}

	var req types.UpdateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	if err := validate.Validate(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}

	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}

	user, err := models.User{}.FindByID(h.db.WithContext(c.Request.Context()), idReq.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respgin.WriteError(c, response.Err(response.CodeNotFound))
			return
		}
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	// Apply partial updates
	updates := map[string]interface{}{}
	if req.Username != nil {
		updates["username"] = *req.Username
	}
	if req.Email != nil {
		updates["email"] = *req.Email
	}
	if req.Phone != nil {
		updates["phone"] = *req.Phone
	}
	if req.Avatar != nil {
		updates["avatar"] = *req.Avatar
	}
	if req.Role != nil {
		updates["role"] = *req.Role
	}
	if req.Status != nil {
		updates["status"] = *req.Status
	}

	if len(updates) > 0 {
		if err := user.Updates(h.db.WithContext(c.Request.Context()), updates); err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
	}
	respgin.Success(c, types.ToUserResponse(user))
}

// ChangePassword changes a user's password (requires old password verification).
func (h *Handlers) ChangePassword(c *gin.Context) {
	var idReq types.IDRequest
	if err := c.ShouldBindUri(&idReq); err != nil {
		respgin.WriteError(c, response.Err(response.CodeBadRequest))
		return
	}

	var req types.ChangePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}
	if err := validate.Validate(&req); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, err.Error()))
		return
	}

	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeServiceUnavail))
		return
	}

	user, err := models.User{}.FindByID(h.db.WithContext(c.Request.Context()), idReq.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respgin.WriteError(c, response.Err(response.CodeNotFound))
			return
		}
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	// Verify old password using ling-base/common/password
	if !password.Verify(req.OldPassword, user.Password) {
		respgin.WriteError(c, response.New(response.CodeUnauthorized, "incorrect old password"))
		return
	}

	// Hash new password
	hashed, err := password.Hash(req.NewPassword, nil)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	if err := (models.User{}).UpdatePassword(h.db.WithContext(c.Request.Context()), user.ID, hashed); err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	h.publish(c.Request.Context(), constants.EventUserPasswordChanged, h, types.UserPasswordChangedEvent{
		UserID: user.ID,
	})
	respgin.Success(c, gin.H{"message": "password changed"})
}

// DeleteUser soft-deletes a user by ID.
func (h *Handlers) DeleteUser(c *gin.Context) {
	var req types.IDRequest
	if err := c.ShouldBindUri(&req); err != nil {
		respgin.WriteError(c, response.Err(response.CodeBadRequest))
		return
	}

	if h.db == nil {
		respgin.WriteError(c, response.Err(response.CodeNotFound))
		return
	}

	if err := (models.User{}).DeleteByID(h.db.WithContext(c.Request.Context()), req.ID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respgin.WriteError(c, response.Err(response.CodeNotFound))
			return
		}
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	h.publish(c.Request.Context(), constants.EventUserDeleted, h, types.UserDeletedEvent{
		UserID: req.ID,
	})
	respgin.NoContent(c)
}

// indexOf returns the index of the first occurrence of substr in s, or -1.
func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

// allocateUsername 若 base 可用则直接用；否则追加短后缀（邮箱前缀撞 admin 等场景）。
func allocateUsername(db *gorm.DB, base string) (string, error) {
	base = strings.TrimSpace(base)
	if base == "" {
		base = "user"
	}
	if len(base) > 40 {
		base = base[:40]
	}
	taken, err := models.User{}.UsernameExists(db, base)
	if err != nil {
		return "", err
	}
	if !taken {
		return base, nil
	}
	for i := 0; i < 8; i++ {
		var b [2]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		cand := fmt.Sprintf("%s_%04x", base, int(b[0])<<8|int(b[1]))
		if len(cand) > 50 {
			cand = cand[:50]
		}
		taken, err = models.User{}.UsernameExists(db, cand)
		if err != nil {
			return "", err
		}
		if !taken {
			return cand, nil
		}
	}
	return "", fmt.Errorf("unable to allocate username")
}
