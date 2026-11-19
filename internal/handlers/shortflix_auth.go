// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ShortFlix 使用 better-auth：邮箱密码登录后签发 7 天有效的会话 Cookie。
// 后端自动完成登录，前端只需要填剧目链接，不再手工粘贴 Cookie。
const (
	shortflixLoginURL = "https://www.shortflix.net/api/auth/sign-in/email"
	// Max-Age=604800（7 天），提前 1 天刷新，避免长任务中途掉会话
	shortflixSessionName   = "__Secure-better-auth.session_token"
	shortflixSessionCookie = shortflixSessionName + "="
	shortflixTokenTTL      = 6 * 24 * time.Hour
	shortflixUserAgent     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

var (
	shortflixMu      sync.Mutex
	shortflixToken   string
	shortflixTokenAt time.Time
	shortflixClient  = &http.Client{Timeout: 30 * time.Second}
)

// shortflixCookie 返回 ShortFlix 登录 Cookie（带缓存），没有可用的会话时自动登录。
func shortflixCookie() (string, error) {
	shortflixMu.Lock()
	defer shortflixMu.Unlock()
	if shortflixToken != "" && time.Since(shortflixTokenAt) < shortflixTokenTTL {
		return shortflixSessionCookie + shortflixToken, nil
	}
	email := strings.TrimSpace(os.Getenv("SHORTFLIX_EMAIL"))
	password := os.Getenv("SHORTFLIX_PASSWORD")
	if email == "" || password == "" {
		return "", errors.New("未配置 SHORTFLIX_EMAIL / SHORTFLIX_PASSWORD，无法自动登录")
	}
	token, err := shortflixSignIn(email, password)
	if err != nil {
		return "", err
	}
	shortflixToken = token
	shortflixTokenAt = time.Now()
	return shortflixSessionCookie + token, nil
}

// shortflixSignIn 调用 better-auth 邮箱登录接口，返回会话 token。
// 缺少浏览器式请求头时网站返回 500，因此必须带上完整头。
func shortflixSignIn(email, password string) (string, error) {
	payload, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req, err := http.NewRequest(http.MethodPost, shortflixLoginURL, strings.NewReader(string(payload)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("User-Agent", shortflixUserAgent)
	req.Header.Set("Origin", "https://www.shortflix.net")
	req.Header.Set("Referer", "https://www.shortflix.net/login")
	req.Header.Set("no-redirect", "true")

	resp, err := shortflixClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("登录请求失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("登录失败（HTTP %d），请检查账号密码", resp.StatusCode)
	}
	for _, cookie := range resp.Cookies() {
		if cookie.Name == shortflixSessionName && cookie.Value != "" {
			return cookie.Value, nil
		}
	}
	return "", errors.New("登录成功但未返回会话 Cookie")
}

// shortflixCookieOrFill 优先使用前端显式传入的 Cookie，否则自动登录获取。
func shortflixCookieOrFill(raw string) (string, error) {
	if value := strings.TrimSpace(raw); value != "" {
		return value, nil
	}
	return shortflixCookie()
}
