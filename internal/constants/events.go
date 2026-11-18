// Copyright (c) 2026 lingbyte. All rights reserved.

package constants

// Event topic names for the application event bus (pkg/common/eventbus).
// Publish with eventbus.New / NewWithSource; subscribe via Bus.Subscribe
// or bootstrap.Application.OnEvent.
const (
	// EventUserRegistered is emitted after a new user account is created.
	// Payload: types.UserRegisteredEvent
	EventUserRegistered = "user.registered"

	// EventUserLogin is emitted after a successful login.
	// Payload: types.UserLoginEvent
	EventUserLogin = "user.login"

	// EventUserPasswordChanged is emitted after a password change.
	// Payload: types.UserPasswordChangedEvent
	EventUserPasswordChanged = "user.password_changed"

	// EventUserDeleted is emitted after a user is soft-deleted.
	// Payload: types.UserDeletedEvent
	EventUserDeleted = "user.deleted"
)
