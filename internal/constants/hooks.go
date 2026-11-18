// Copyright (c) 2026 lingbyte. All rights reserved.

package constants

// Init hook names used with bootstrap.Application.AddInitHook.
// Centralized here to avoid string-typo bugs and make hook ordering
// easy to audit.
const (
	// HookSeedRBAC seeds default roles, permissions, and admin
	// role-permission assignments (RBAC only).
	HookSeedRBAC = "seed-rbac"

	// HookRegisterListeners connects domain event listeners to the
	// application event bus (pkg/common/eventbus).
	HookRegisterListeners = "register-listeners"
)
