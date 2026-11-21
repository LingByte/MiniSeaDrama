// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/LingByte/miniseadrama/internal/models"
	paysvc "github.com/LingByte/miniseadrama/internal/service/payment"
	"github.com/LingByte/miniseadrama/pkg/common/payment"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	liveQueryMu   sync.Mutex
	lastLiveQuery = map[string]time.Time{}

	// 进程内订单锁（对齐 lingpan LockOrder）：多实例下仍依赖 DB 事务；
	// 单机上可挡住 notify / 查单 / 退款对同一 out_trade_no 的竞态。
	orderLocksMu sync.Mutex
	orderLocks   = map[string]*refCountedMutex{}
)

type refCountedMutex struct {
	mu       sync.Mutex
	refCount int
}

func lockOrder(tradeNo string) {
	orderLocksMu.Lock()
	rcm, ok := orderLocks[tradeNo]
	if !ok {
		rcm = &refCountedMutex{}
		orderLocks[tradeNo] = rcm
	}
	rcm.refCount++
	orderLocksMu.Unlock()
	rcm.mu.Lock()
}

func unlockOrder(tradeNo string) {
	orderLocksMu.Lock()
	rcm, ok := orderLocks[tradeNo]
	if !ok {
		orderLocksMu.Unlock()
		return
	}
	orderLocksMu.Unlock()
	rcm.mu.Unlock()

	orderLocksMu.Lock()
	rcm.refCount--
	if rcm.refCount == 0 {
		delete(orderLocks, tradeNo)
	}
	orderLocksMu.Unlock()
}

func moneyEqual(a, b float64) bool {
	return math.Round(a*100) == math.Round(b*100)
}

var (
	errOrderAmountMismatch = errors.New("payment amount mismatch")
	errOrderNotPending     = errors.New("order not pending")
)

// currentAccount 从 JWT claims 解析当前买家邮箱（subject=username → 查库）。
func (h *Handlers) currentAccount(c *gin.Context) (email string, role string, err error) {
	claims := ClaimsFromContext(c)
	if claims == nil || claims.Subject == "" {
		return "", "", errors.New("unauthorized")
	}
	if h.db == nil {
		return "", "", errors.New("db unavailable")
	}
	user, err := models.User{}.FindByUsernameOrEmail(h.db.WithContext(c.Request.Context()), claims.Subject, "")
	if err != nil {
		return "", "", err
	}
	return strings.ToLower(strings.TrimSpace(user.Email)), user.Role, nil
}

func clientIP(c *gin.Context) string {
	ip := c.ClientIP()
	if ip == "" {
		host, _, _ := net.SplitHostPort(c.Request.RemoteAddr)
		ip = host
	}
	if ip == "" {
		ip = "127.0.0.1"
	}
	return ip
}

func roundMoney(v float64) float64 {
	return math.Round(v*100) / 100
}

// orderCoverURL 订单只存轻量封面：拒绝 data: 大图（AI 生成的 base64 可到数 MB），
// 否则写库/回包都会拖垮下单接口甚至触发序列化失败。
func orderCoverURL(cover string) string {
	cover = strings.TrimSpace(cover)
	if cover == "" {
		return ""
	}
	if strings.HasPrefix(cover, "data:") || len(cover) > 2048 {
		return ""
	}
	return cover
}

func (h *Handlers) scriptFileExists(scriptID string) bool {
	if h.db != nil {
		var row models.AdminScript
		if err := h.db.Select("file_path").First(&row, "script_id = ?", scriptID).Error; err == nil && row.FilePath != "" {
			if ok, _ := pkgstorage.Exists(row.FilePath); ok {
				return true
			}
			if _, err := os.Stat(row.FilePath); err == nil {
				return true
			}
		}
	}
	dir := scriptFileDir
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	prefix := scriptID + "."
	for _, e := range entries {
		if !e.IsDir() && (e.Name() == scriptID || strings.HasPrefix(e.Name(), prefix)) {
			return true
		}
	}
	pattern := filepath.Join(dir, scriptID+"*")
	matches, _ := filepath.Glob(pattern)
	return len(matches) > 0
}

func buyoutSold(db *gorm.DB, scriptID string) bool {
	var n int64
	_ = db.Model(&models.Order{}).
		Where("script_id = ? AND status = ? AND sale_type = ?", scriptID, "paid", "buyout").
		Count(&n)
	return n > 0
}

// ListOrders GET /api/v1/orders — 当前用户订单。
func (h *Handlers) ListOrders(c *gin.Context) {
	email, _, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
		return
	}
	var rows []models.Order
	if err := h.db.WithContext(c.Request.Context()).
		Where("account = ?", email).
		Order("created_at DESC").
		Find(&rows).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, o := range rows {
		out = append(out, h.enrichOrderAPI(o, true))
	}
	respgin.Success(c, gin.H{"orders": out})
}

// CreateOrder POST /api/v1/orders — 下单并拉起支付宝扫码。
func (h *Handlers) CreateOrder(c *gin.Context) {
	email, _, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
		return
	}
	var body struct {
		ScriptID string `json:"scriptId"`
		Buyer    string `json:"buyer"`
		Company  string `json:"company"`
		Email    string `json:"email"`
		Type     string `json:"type"`
		Country  string `json:"country"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请求体无效"))
		return
	}
	if strings.TrimSpace(body.Buyer) == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请填写联系人"))
		return
	}
	buyerEmail := strings.TrimSpace(body.Email)
	if buyerEmail == "" || !strings.Contains(buyerEmail, "@") {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "请填写有效邮箱"))
		return
	}
	if !paysvc.Configured() {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "支付网关未配置（EPAY_PARTNER_ID / EPAY_KEY）"))
		return
	}

	script, err := h.loadScriptMap(c, body.ScriptID)
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本不存在或已下架"))
		return
	}
	if !strings.EqualFold(str(script["status"]), "on") {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本不存在或已下架"))
		return
	}
	saleType := str(script["saleType"])
	if saleType == "buyout" && buyoutSold(h.db, body.ScriptID) {
		respgin.WriteError(c, response.New(response.CodeConflict, "该剧本已被买断，无法再次购买"))
		return
	}
	if !h.scriptFileExists(body.ScriptID) {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "该剧本尚未上传完整剧本文件，暂时无法购买，请联系客服"))
		return
	}

	price := roundMoney(asFloat64(script["price"]))
	if price < 0.01 {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本售价无效，无法下单"))
		return
	}
	ctx := c.Request.Context()
	var order models.Order
	err = h.db.WithContext(ctx).
		Where("status = ? AND script_id = ? AND account = ?", "pending", body.ScriptID, email).
		First(&order).Error
	cover := orderCoverURL(str(script["cover"]))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		id, err := models.NextOrderID(h.db.WithContext(ctx))
		if err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
		discounts, _ := json.Marshal([]any{})
		order = models.Order{
			ID: id, ScriptID: body.ScriptID, ScriptTitle: str(script["title"]),
			Cover: cover, SaleType: saleType, Account: email,
			Original: price, Paid: price, Discounts: string(discounts),
			Buyer: strings.TrimSpace(body.Buyer), Company: strings.TrimSpace(body.Company),
			Email: buyerEmail, Country: strings.TrimSpace(body.Country),
			PayMethod: "支付宝", PayChannel: "alipay", Status: "pending",
		}
		if err := h.db.WithContext(ctx).Create(&order).Error; err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
	} else if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	} else {
		// 复用 pending 单时同步最新标价，避免少扣/多扣
		order.Buyer = strings.TrimSpace(body.Buyer)
		order.Company = strings.TrimSpace(body.Company)
		order.Email = buyerEmail
		order.Country = strings.TrimSpace(body.Country)
		order.ScriptTitle = str(script["title"])
		order.Cover = cover
		order.SaleType = saleType
		order.Original = price
		order.Paid = price
		order.PayChannel = "alipay"
		order.PayMethod = "支付宝"
		if err := h.db.WithContext(ctx).Save(&order).Error; err != nil {
			respgin.WriteError(c, response.Err(response.CodeInternal))
			return
		}
	}

	name := fmt.Sprintf("海漫剧本《%s》%s", order.ScriptTitle, map[string]string{"buyout": "买断", "wholesale": "批发试用"}[saleType])
	_, payURL, qr, err := paysvc.CreateAlipayCheckout(ctx, order.ID, name, order.Paid, clientIP(c))
	if err != nil && !errors.Is(err, payment.ErrNotConfigured) {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "创建支付会话失败："+err.Error()))
		return
	}
	// 不回传完整 script（含剧集正文/大图），避免响应过大导致序列化失败或前端超时
	respgin.Success(c, gin.H{"order": order.ToAPI(true), "payUrl": payURL, "qr": qr})
}

// PayOrder POST /api/v1/orders/:id/pay — 继续支付。
func (h *Handlers) PayOrder(c *gin.Context) {
	email, _, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
		return
	}
	id := c.Param("id")
	var order models.Order
	if err := h.db.WithContext(c.Request.Context()).First(&order, "id = ?", id).Error; err != nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "订单不存在"))
		return
	}
	if !strings.EqualFold(order.Account, email) {
		respgin.WriteError(c, response.New(response.CodeNotFound, "订单不存在"))
		return
	}
	if order.Status != "pending" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "该订单当前状态不可支付"))
		return
	}
	if !h.scriptFileExists(order.ScriptID) {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "剧本文件尚未上传或已移除，暂时无法支付"))
		return
	}
	name := fmt.Sprintf("海漫剧本《%s》", order.ScriptTitle)
	_, payURL, qr, err := paysvc.CreateAlipayCheckout(c.Request.Context(), order.ID, name, order.Paid, clientIP(c))
	if err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "创建支付会话失败："+err.Error()))
		return
	}
	respgin.Success(c, gin.H{"payUrl": payURL, "qr": qr})
}

// PayStatus GET /api/v1/pay/status?out_trade_no=
func (h *Handlers) PayStatus(c *gin.Context) {
	email, role, err := h.currentAccount(c)
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeUnauthorized))
		return
	}
	out := strings.TrimSpace(c.Query("out_trade_no"))
	if out == "" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "缺少 out_trade_no"))
		return
	}
	var order models.Order
	if err := h.db.WithContext(c.Request.Context()).First(&order, "id = ?", out).Error; err != nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "订单不存在"))
		return
	}
	if !strings.EqualFold(order.Account, email) && role != "admin" {
		respgin.WriteError(c, response.New(response.CodeNotFound, "订单不存在"))
		return
	}
	if order.Status == "pending" {
		h.tryLiveQuery(&order)
	}
	respgin.Success(c, gin.H{"order": order.ToAPI(strings.EqualFold(order.Account, email))})
}

func (h *Handlers) tryLiveQuery(order *models.Order) {
	liveQueryMu.Lock()
	last := lastLiveQuery[order.ID]
	if time.Since(last) < 2*time.Second {
		liveQueryMu.Unlock()
		return
	}
	lastLiveQuery[order.ID] = time.Now()
	liveQueryMu.Unlock()

	res, err := paysvc.QueryRemote(context.Background(), order.ID)
	if err != nil || res == nil || res.Status != payment.StatusSuccess {
		return
	}
	money := float64(res.MoneyPaid)
	// 查单路径也必须校验金额，避免少扣费被误记为已付
	if money > 0 && !moneyEqual(money, order.Paid) {
		return
	}
	if money <= 0 {
		// 网关未回金额时仍允许完成（官方查单 status=1 且签名链路可信），但以订单标价为准
		money = order.Paid
	}
	updated, err := h.completePaidOrder(order.ID, res.ProviderOrderID, money, true)
	if err == nil && updated != nil {
		*order = *updated
	}
}

// PayNotify GET|POST /api/v1/pay/notify — 易支付异步回调（公开）。
func (h *Handlers) PayNotify(c *gin.Context) {
	params := paysvc.CollectFormParams(c)
	if len(params) == 0 {
		paysvc.WriteNotifyResponse(c, false)
		return
	}
	// 商户号硬校验（对齐 Node；签名本身也覆盖 pid，双保险）
	if pid := strings.TrimSpace(params["pid"]); pid != "" && pid != paysvc.PartnerID() {
		paysvc.WriteNotifyResponse(c, false)
		return
	}

	ev, err := paysvc.VerifyNotify(c)
	if err != nil {
		paysvc.WriteNotifyResponse(c, false)
		return
	}
	if ev.Status != payment.StatusSuccess {
		// 非成功事件：应答 success 避免网关无意义重试（对齐 lingpan）
		paysvc.WriteNotifyResponse(c, true)
		return
	}

	money := float64(ev.MoneyPaid)
	if money <= 0 {
		fmt.Sscanf(params["money"], "%f", &money)
	}
	if money <= 0 {
		paysvc.WriteNotifyResponse(c, false)
		return
	}

	tradeNo := strings.TrimSpace(ev.TradeNo)
	if tradeNo == "" {
		paysvc.WriteNotifyResponse(c, false)
		return
	}

	lockOrder(tradeNo)
	defer unlockOrder(tradeNo)

	if _, err := h.completePaidOrder(tradeNo, ev.ProviderOrderID, money, true); err != nil {
		paysvc.WriteNotifyResponse(c, false)
		return
	}
	paysvc.WriteNotifyResponse(c, true)
}

// completePaidOrder 事务内完成支付（对齐 lingpan RechargeEpay）：
// 行锁 + 状态幂等 + 金额校验 + 买断互斥；重复回调返回 (order, nil)。
func (h *Handlers) completePaidOrder(orderID, gatewayTradeNo string, money float64, requireAmount bool) (*models.Order, error) {
	if h.db == nil || orderID == "" {
		return nil, gorm.ErrInvalidDB
	}
	var out models.Order
	var needRefund bool
	err := h.db.Transaction(func(tx *gorm.DB) error {
		var order models.Order
		q := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", orderID)
		if err := q.First(&order).Error; err != nil {
			return err
		}
		if order.Status == "paid" {
			out = order
			return nil // 幂等
		}
		if order.Status != "pending" {
			return errOrderNotPending
		}
		if requireAmount && !moneyEqual(money, order.Paid) {
			return errOrderAmountMismatch
		}

		// 买断互斥：事务内再查一次，避免双买家同时付成功
		if order.SaleType == "buyout" {
			var n int64
			if err := tx.Model(&models.Order{}).
				Where("script_id = ? AND status = ? AND sale_type = ? AND id <> ?", order.ScriptID, "paid", "buyout", order.ID).
				Count(&n).Error; err != nil {
				return err
			}
			if n > 0 {
				order.Status = "closed"
				order.ClosedNote = "该剧本已被其他买家买断，订单已关闭，将尝试原路退款"
				if err := tx.Save(&order).Error; err != nil {
					return err
				}
				out = order
				needRefund = true
				return nil
			}
		}

		now := time.Now()
		order.Status = "paid"
		order.TradeNo = gatewayTradeNo
		order.PaidAt = &now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		if order.SaleType == "buyout" {
			if err := tx.Model(&models.Order{}).
				Where("script_id = ? AND status = ? AND id <> ?", order.ScriptID, "pending", order.ID).
				Updates(map[string]any{
					"status":      "closed",
					"closed_note": "该剧本已被买断，订单自动关闭",
				}).Error; err != nil {
				return err
			}
		}

		_ = bumpScriptSalesTx(tx, order.ScriptID)
		out = order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if needRefund {
		// 事务外尽力退款，失败留给人工处理（对齐 Node markPaid）
		go func(id string, amount float64) {
			_ = paysvc.Refund(context.Background(), id, amount)
		}(out.ID, out.Paid)
	}
	return &out, nil
}

func bumpScriptSalesTx(tx *gorm.DB, scriptID string) error {
	var row models.AdminScript
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "script_id = ?", scriptID).Error; err != nil {
		return nil // 剧本缺失不阻断支付完成
	}
	payload := map[string]any{}
	if row.Payload != "" {
		_ = json.Unmarshal([]byte(row.Payload), &payload)
	}
	sales := asFloat64(payload["sales"])
	payload["sales"] = int(sales) + 1
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	row.Payload = string(raw)
	_ = tx.Save(&row).Error
	return nil
}

// AdminRefundOrder POST /api/v1/admin/orders/:id/refund
func (h *Handlers) AdminRefundOrder(c *gin.Context) {
	_, role, err := h.currentAccount(c)
	if err != nil || role != "admin" {
		respgin.WriteError(c, response.Err(response.CodeForbidden))
		return
	}
	id := c.Param("id")
	lockOrder(id)
	defer unlockOrder(id)

	var order models.Order
	if err := h.db.WithContext(c.Request.Context()).First(&order, "id = ?", id).Error; err != nil {
		respgin.WriteError(c, response.New(response.CodeNotFound, "订单不存在"))
		return
	}
	if order.Status == "refunded" {
		respgin.Success(c, gin.H{"order": order.ToAPI(false)})
		return
	}
	if order.Status != "paid" {
		respgin.WriteError(c, response.New(response.CodeBadRequest, "仅已支付订单可退款"))
		return
	}
	if err := paysvc.Refund(c.Request.Context(), order.ID, order.Paid); err != nil {
		respgin.WriteError(c, response.New(response.CodeServiceUnavail, "网关退款失败："+err.Error()))
		return
	}
	order.Status = "refunded"
	if err := h.db.Save(&order).Error; err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}
	respgin.Success(c, gin.H{"order": order.ToAPI(false)})
}

func (h *Handlers) loadScriptMap(c *gin.Context, id string) (map[string]any, error) {
	var row models.AdminScript
	if err := h.db.WithContext(c.Request.Context()).First(&row, "script_id = ?", id).Error; err != nil {
		return nil, err
	}
	return row.ToScript(), nil
}

func asFloat64(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case json.Number:
		f, _ := t.Float64()
		return f
	case string:
		var f float64
		fmt.Sscanf(t, "%f", &f)
		return f
	default:
		return 0
	}
}

// ListAllOrders 供 AdminAll 使用。
func (h *Handlers) listAllOrdersAPI() []map[string]any {
	if h.db == nil {
		return []map[string]any{}
	}
	var rows []models.Order
	_ = h.db.Order("created_at DESC").Find(&rows).Error
	out := make([]map[string]any, 0, len(rows))
	for _, o := range rows {
		out = append(out, h.enrichOrderAPI(o, false))
	}
	return out
}

// PayReturnRedirect GET /pay/return → /#/pay/return?out_trade_no=
func (h *Handlers) PayReturnRedirect(c *gin.Context) {
	out := strings.TrimSpace(c.Query("out_trade_no"))
	target := "/#/pay/return"
	if out != "" {
		target += "?out_trade_no=" + out
	}
	c.Redirect(302, target)
}

// StartPayReconciler 后台轮询未支付订单（对齐 Node 30s 保底）。
func (h *Handlers) StartPayReconciler() {
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for range t.C {
			if h.db == nil || !paysvc.Configured() {
				continue
			}
			var rows []models.Order
			cutoff := time.Now().Add(-48 * time.Hour)
			_ = h.db.Where("status = ? AND created_at > ?", "pending", cutoff).Limit(50).Find(&rows).Error
			for i := range rows {
				h.tryLiveQuery(&rows[i])
			}
		}
	}()
}
