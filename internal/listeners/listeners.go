// Copyright (c) 2026 lingbyte. All rights reserved.

// Package listeners registers handlers for post-processing of domain
// events via pkg/common/eventbus.
//
// Events are defined in internal/constants/events.go and published by
// handlers after successful operations. Listeners subscribe to those
// topics and perform side-effects such as logging, cache invalidation,
// audit trails, notification dispatch, etc.
//
// Register all listeners during application startup:
//
//	app.AddInitHook("register-listeners", func(ctx context.Context) error {
//	    listeners.Register(app.Events(), db)
//	    return nil
//	})
package listeners

import (
	"github.com/LingByte/miniseadrama/pkg/common/eventbus"
	"github.com/LingByte/miniseadrama/pkg/common/logger"
	"gorm.io/gorm"
)

// Register connects all event listeners to the application event bus.
// Pass nil for db if database access is not needed in listeners.
func Register(bus eventbus.Bus, db *gorm.DB) {
	if bus == nil {
		logger.Lg.Warn("event bus is nil, skipping listener registration")
		return
	}
	registerUserListeners(bus, db)
	logger.Lg.Info("event listeners registered")
}

// safeHandler wraps a handler with panic recovery so a bad listener
// cannot crash the process. Prefer keeping handlers fast and
// non-blocking; spawn a goroutine inside the handler for heavy work.
func safeHandler(handler eventbus.Handler) eventbus.Handler {
	return eventbus.ApplyMiddleware(handler, eventbus.RecoverMiddleware())
}
