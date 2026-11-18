// Copyright (c) 2026 lingbyte. All rights reserved.

package listeners

import (
	"context"

	"github.com/LingByte/miniseadrama/internal/constants"
	"github.com/LingByte/miniseadrama/internal/types"

	"github.com/LingByte/miniseadrama/pkg/common/eventbus"
	"github.com/LingByte/miniseadrama/pkg/common/logger"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// registerUserListeners subscribes handlers for user-related events.
func registerUserListeners(bus eventbus.Bus, db *gorm.DB) {
	_ = db // reserved for future listener side-effects

	bus.Subscribe(constants.EventUserRegistered, safeHandler(func(ctx context.Context, e *eventbus.Event) error {
		p, ok := e.Payload.(types.UserRegisteredEvent)
		if !ok {
			logger.Lg.Warn("unexpected payload for user.registered", zap.Any("payload", e.Payload))
			return nil
		}
		logger.Lg.Info("user registered",
			zap.Uint("userID", p.UserID),
			zap.String("username", p.Username),
			zap.String("email", p.Email),
		)
		// TODO: send welcome email, create default preferences, etc.
		return nil
	}))

	bus.Subscribe(constants.EventUserLogin, safeHandler(func(ctx context.Context, e *eventbus.Event) error {
		p, ok := e.Payload.(types.UserLoginEvent)
		if !ok {
			logger.Lg.Warn("unexpected payload for user.login", zap.Any("payload", e.Payload))
			return nil
		}
		logger.Lg.Info("user login",
			zap.Uint("userID", p.UserID),
			zap.String("username", p.Username),
		)
		// TODO: update audit log, check suspicious login patterns, etc.
		return nil
	}))

	bus.Subscribe(constants.EventUserPasswordChanged, safeHandler(func(ctx context.Context, e *eventbus.Event) error {
		p, ok := e.Payload.(types.UserPasswordChangedEvent)
		if !ok {
			logger.Lg.Warn("unexpected payload for user.password_changed", zap.Any("payload", e.Payload))
			return nil
		}
		logger.Lg.Info("user password changed", zap.Uint("userID", p.UserID))
		// TODO: send security notification email, invalidate sessions, etc.
		return nil
	}))

	bus.Subscribe(constants.EventUserDeleted, safeHandler(func(ctx context.Context, e *eventbus.Event) error {
		p, ok := e.Payload.(types.UserDeletedEvent)
		if !ok {
			logger.Lg.Warn("unexpected payload for user.deleted", zap.Any("payload", e.Payload))
			return nil
		}
		logger.Lg.Info("user deleted", zap.Uint("userID", p.UserID))
		// TODO: cleanup user data, revoke tokens, notify related services, etc.
		return nil
	}))
}
