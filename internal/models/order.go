// Copyright (c) 2026 lingbyte. All rights reserved.

package models

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// Order 剧本购买订单（对齐前端 Order 结构与易支付 out_trade_no）。
type Order struct {
	ID          string     `gorm:"primaryKey;size:32" json:"id"`
	ScriptID    string     `gorm:"size:64;index;not null" json:"scriptId"`
	ScriptTitle string     `gorm:"size:256" json:"scriptTitle"`
	Cover       string     `gorm:"type:text" json:"cover"`
	SaleType    string     `gorm:"size:32" json:"saleType"`
	Account     string     `gorm:"size:128;index;not null" json:"account"`
	Original    float64    `json:"original"`
	Paid        float64    `json:"paid"`
	Discounts   string     `gorm:"type:text" json:"-"` // JSON array
	Buyer       string     `gorm:"size:128" json:"buyer"`
	Company     string     `gorm:"size:256" json:"company"`
	Email       string     `gorm:"size:128" json:"email"`
	Country     string     `gorm:"size:64" json:"country"`
	PayMethod   string     `gorm:"size:64" json:"payMethod"`
	PayChannel  string     `gorm:"size:32" json:"payChannel"`
	TradeNo     string     `gorm:"size:128" json:"tradeNo"`
	PaidAt      *time.Time `json:"paidAt,omitempty"`
	ClosedNote  string     `gorm:"size:512" json:"closedNote,omitempty"`
	Status      string     `gorm:"size:32;index;not null" json:"status"` // pending|paid|refunded|closed
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

func (Order) TableName() string { return "orders" }

// ToAPI 转为前端约定结构。
func (o Order) ToAPI(mine bool) map[string]any {
	var discounts []any
	if o.Discounts != "" {
		_ = json.Unmarshal([]byte(o.Discounts), &discounts)
	}
	if discounts == nil {
		discounts = []any{}
	}
	out := map[string]any{
		"id": o.ID, "scriptId": o.ScriptID, "scriptTitle": o.ScriptTitle,
		"cover": o.Cover, "saleType": o.SaleType, "account": o.Account,
		"original": o.Original, "paid": o.Paid, "discounts": discounts,
		"buyer": o.Buyer, "company": o.Company, "email": o.Email,
		"payMethod": o.PayMethod, "payChannel": o.PayChannel,
		"createdAt": o.CreatedAt.UTC().Format(time.RFC3339),
		"status":    o.Status, "mine": mine,
	}
	if o.Country != "" {
		out["country"] = o.Country
	}
	if o.TradeNo != "" {
		out["tradeNo"] = o.TradeNo
	}
	if o.PaidAt != nil {
		out["paidAt"] = o.PaidAt.UTC().Format(time.RFC3339)
	}
	if o.ClosedNote != "" {
		out["closedNote"] = o.ClosedNote
	}
	return out
}

// NextOrderID 生成唯一 HM 订单号（时间戳 + 随机，避免 Count+1 并发碰撞）。
func NextOrderID(_ *gorm.DB) (string, error) {
	var n uint32
	if err := binary.Read(rand.Reader, binary.BigEndian, &n); err != nil {
		return "", err
	}
	return fmt.Sprintf("HM%s%04d", time.Now().Format("060102150405"), n%10000), nil
}
