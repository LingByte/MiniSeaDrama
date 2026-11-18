// Copyright (c) 2026 lingbyte. All rights reserved.

package types

// UserRegisteredEvent is the payload for constants.EventUserRegistered.
type UserRegisteredEvent struct {
	UserID   uint   `json:"userID"`
	Username string `json:"username"`
	Email    string `json:"email"`
}

// UserLoginEvent is the payload for constants.EventUserLogin.
type UserLoginEvent struct {
	UserID   uint   `json:"userID"`
	Username string `json:"username"`
}

// UserPasswordChangedEvent is the payload for constants.EventUserPasswordChanged.
type UserPasswordChangedEvent struct {
	UserID uint `json:"userID"`
}

// UserDeletedEvent is the payload for constants.EventUserDeleted.
type UserDeletedEvent struct {
	UserID uint `json:"userID"`
}
