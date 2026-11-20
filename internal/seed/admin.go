// Copyright (c) 2026 lingbyte. All rights reserved.

package seed

import (
	"fmt"
	"os"
	"strings"

	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/pkg/common/password"
	"gorm.io/gorm"
)

// AdminFromEnv reads ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_USERNAME from the environment.
type AdminFromEnv struct {
	Email    string
	Password string
	Username string
}

// LoadAdminEnv loads admin credentials from process environment.
func LoadAdminEnv() (AdminFromEnv, error) {
	email := strings.TrimSpace(os.Getenv("ADMIN_EMAIL"))
	pass := os.Getenv("ADMIN_PASSWORD")
	username := strings.TrimSpace(os.Getenv("ADMIN_USERNAME"))
	if email == "" || pass == "" {
		return AdminFromEnv{}, fmt.Errorf("ADMIN_EMAIL and ADMIN_PASSWORD are required for seed")
	}
	if username == "" {
		at := strings.IndexByte(email, '@')
		if at > 0 {
			username = email[:at]
		} else {
			username = email
		}
		username = strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
				return r
			}
			return '_'
		}, username)
		if len(username) < 3 {
			username = "admin_" + username
		}
	}
	return AdminFromEnv{Email: strings.ToLower(email), Password: pass, Username: username}, nil
}

// UpsertAdmin creates or updates the configured admin user and demotes other admins.
func UpsertAdmin(db *gorm.DB, admin AdminFromEnv) error {
	if db == nil {
		return fmt.Errorf("database is nil")
	}
	hashed, err := password.Hash(admin.Password, nil)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}

	var existing models.User
	err = db.Where("email = ?", admin.Email).First(&existing).Error
	switch {
	case err == nil:
		updates := map[string]any{
			"password": hashed,
			"role":     models.UserRoleAdmin,
			"status":   models.UserStatusActive,
		}
		if admin.Username != "" {
			updates["username"] = admin.Username
		}
		if err := db.Model(&existing).Updates(updates).Error; err != nil {
			return fmt.Errorf("update admin: %w", err)
		}
	case err == gorm.ErrRecordNotFound:
		u := models.User{
			Username: admin.Username,
			Email:    admin.Email,
			Password: hashed,
			Role:     models.UserRoleAdmin,
			Status:   models.UserStatusActive,
		}
		if err := u.Create(db); err != nil {
			return fmt.Errorf("create admin: %w", err)
		}
	default:
		return fmt.Errorf("lookup admin: %w", err)
	}

	// Keep only the configured email as admin.
	if err := db.Model(&models.User{}).
		Where("role = ? AND email <> ?", models.UserRoleAdmin, admin.Email).
		Update("role", models.UserRoleUser).Error; err != nil {
		return fmt.Errorf("demote other admins: %w", err)
	}
	return nil
}
