// Copyright (c) 2026 lingbyte. All rights reserved.

package models

import (
	"encoding/json"
	"time"
)

// AdminScript 保存管理端上架的剧本元数据。
// 剧本表单字段较多且由前端演进，这里以 JSON 原文保存，避免频繁改表。
type AdminScript struct {
	ScriptID  string    `gorm:"primaryKey;size:64" json:"id"`
	// longtext：整剧试读/AI 分集正文常远超 MySQL TEXT 64KB 上限
	Payload   string    `gorm:"type:longtext" json:"-"`
	FileName  string    `gorm:"size:255" json:"fileName,omitempty"`
	FileSize  int64     `json:"fileSize,omitempty"`
	FilePath  string    `gorm:"size:500" json:"-"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// TableName 返回剧本表名。
func (AdminScript) TableName() string { return "admin_scripts" }

// ToScript 把数据库行还原成前端 Script 结构。
func (s *AdminScript) ToScript() map[string]any {
	script := map[string]any{}
	if s.Payload != "" {
		_ = json.Unmarshal([]byte(s.Payload), &script)
	}
	script["id"] = s.ScriptID
	if s.FileName != "" {
		script["fileName"] = s.FileName
		script["fileSize"] = s.FileSize
	}
	return script
}
