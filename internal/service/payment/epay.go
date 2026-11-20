// Copyright (c) 2026 lingbyte. All rights reserved.

package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/pkg/common/payment"
	"github.com/LingByte/miniseadrama/pkg/common/payment/epay"
	"github.com/gin-gonic/gin"
)

// PayQR 对齐前端 PayQr：{ img, qrcode, payurl }。
type PayQR struct {
	Img    string `json:"img"`
	Qrcode string `json:"qrcode"`
	PayURL string `json:"payurl"`
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// NewEpayProvider 从环境变量构建易支付/ZPay 适配器（与 lingpan 一致）。
func NewEpayProvider() *epay.Adapter {
	mode := epay.ModeAPI
	if strings.EqualFold(envOr("EPAY_CHECKOUT_MODE", "api"), "redirect") {
		mode = epay.ModeRedirect
	}
	return epay.New(epay.Config{
		PartnerID:    envOr("EPAY_PARTNER_ID", envOr("ZPAY_PID", "")),
		Key:          envOr("EPAY_KEY", envOr("ZPAY_KEY", "")),
		BaseURL:      strings.TrimRight(envOr("EPAY_BASE_URL", envOr("ZPAY_GATEWAY", "https://zpayz.cn")), "/"),
		CheckoutMode: mode,
	}, epay.WithHTTPTimeout(15*time.Second))
}

// Configured 报告支付网关是否已配置。
func Configured() bool {
	p := NewEpayProvider()
	return p.Configured()
}

// PartnerID 返回商户号（回调 pid 硬校验用）。
func PartnerID() string {
	return envOr("EPAY_PARTNER_ID", envOr("ZPAY_PID", ""))
}

// CallbackBase 对外可达根地址（用于 notify/return）。
func CallbackBase() string {
	return strings.TrimRight(envOr("PUBLIC_CALLBACK_BASE", envOr("PUBLIC_ORIGIN", "http://127.0.0.1:8080")), "/")
}

// NotifyURL / ReturnURL
func NotifyURL() string { return CallbackBase() + "/api/v1/pay/notify" }
func ReturnURL() string { return CallbackBase() + "/pay/return" }

// CreateAlipayCheckout 为订单创建支付宝扫码会话。
func CreateAlipayCheckout(ctx context.Context, tradeNo, name string, money float64, clientIP string) (*payment.CheckoutResult, string, *PayQR, error) {
	p := NewEpayProvider()
	if !p.Configured() {
		return nil, "", nil, payment.ErrNotConfigured
	}
	req := &payment.CheckoutRequest{
		TradeNo:   tradeNo,
		Money:     payment.Money(money),
		Currency:  "CNY",
		Name:      name,
		Device:    payment.DevicePC,
		NotifyURL: NotifyURL(),
		ReturnURL: ReturnURL(),
		ProductID: "alipay",
		ClientIP:  clientIP,
	}
	result, err := p.CreateCheckout(ctx, req)
	if err != nil {
		return nil, "", nil, err
	}
	payURL := strings.TrimSpace(result.CheckoutURL)
	if len(result.Params) > 0 {
		payURL = appendQuery(payURL, result.Params)
	}
	qr := ExtractPayQR(result)
	if payURL == "" && qr != nil && qr.PayURL != "" {
		payURL = qr.PayURL
	}
	return result, payURL, qr, nil
}

func appendQuery(base string, params map[string]string) string {
	base = strings.TrimSpace(base)
	if base == "" || len(params) == 0 {
		return base
	}
	q := url.Values{}
	for k, v := range params {
		if strings.TrimSpace(k) == "" {
			continue
		}
		q.Set(k, v)
	}
	enc := q.Encode()
	if enc == "" {
		return base
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return base + sep + enc
}

// ExtractPayQR 从 CheckoutResult.Raw 提取二维码字段。
func ExtractPayQR(checkout *payment.CheckoutResult) *PayQR {
	if checkout == nil || checkout.Raw == nil {
		return nil
	}
	raw, err := json.Marshal(checkout.Raw)
	if err != nil {
		return nil
	}
	var payload struct {
		Img    string `json:"img"`
		Qrcode string `json:"qrcode"`
		PayURL string `json:"payurl"`
		Code   any    `json:"code"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	qr := &PayQR{
		Img:    strings.TrimSpace(payload.Img),
		Qrcode: strings.TrimSpace(payload.Qrcode),
		PayURL: strings.TrimSpace(payload.PayURL),
	}
	if qr.Qrcode == "" {
		qr.Qrcode = qr.PayURL
	}
	if qr.PayURL == "" {
		qr.PayURL = strings.TrimSpace(checkout.CheckoutURL)
	}
	if qr.Img == "" && qr.Qrcode == "" && qr.PayURL == "" {
		return nil
	}
	return qr
}

// VerifyNotify 校验易支付异步通知。
func VerifyNotify(c *gin.Context) (*payment.WebhookEvent, error) {
	p := NewEpayProvider()
	if !p.Configured() {
		return nil, payment.ErrNotConfigured
	}
	params := CollectFormParams(c)
	return p.VerifyWebhook(c.Request.Context(), &payment.WebhookVerifyRequest{
		Provider:   payment.ProviderEpay,
		FormParams: params,
	})
}

// WriteNotifyResponse 写 success/fail 纯文本。
func WriteNotifyResponse(c *gin.Context, ok bool) {
	p := NewEpayProvider()
	resp, err := p.BuildWebhookResponse(c.Request.Context(), ok, "")
	if err != nil || resp == nil {
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(map[bool]string{true: "success", false: "fail"}[ok]))
		return
	}
	ct := resp.ContentType
	if ct == "" {
		ct = "text/plain; charset=utf-8"
	}
	c.Data(resp.StatusCode, ct, resp.Body)
}

// CollectFormParams 收集 query + form（与 lingpan 一致）。
func CollectFormParams(c *gin.Context) map[string]string {
	out := map[string]string{}
	for k, vs := range c.Request.URL.Query() {
		if len(vs) > 0 {
			out[k] = vs[0]
		}
	}
	_ = c.Request.ParseForm()
	for k, vs := range c.Request.PostForm {
		if len(vs) > 0 {
			out[k] = vs[0]
		}
	}
	return out
}

// QueryRemote 向网关查单。
func QueryRemote(ctx context.Context, tradeNo string) (*payment.OrderQueryResult, error) {
	p := NewEpayProvider()
	if !p.Configured() {
		return nil, payment.ErrNotConfigured
	}
	return p.QueryOrder(ctx, &payment.OrderQuery{TradeNo: tradeNo})
}

// Refund 发起退款（若网关支持）。
func Refund(ctx context.Context, tradeNo string, money float64) error {
	p := NewEpayProvider()
	if !p.Configured() {
		return payment.ErrNotConfigured
	}
	ref, ok := any(p).(payment.Refunder)
	if !ok {
		return fmt.Errorf("当前支付网关不支持退款接口")
	}
	_, err := ref.Refund(ctx, &payment.RefundRequest{
		TradeNo: tradeNo,
		Money:   payment.Money(money),
	})
	return err
}
