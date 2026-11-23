// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LLMError is a user-facing model error.
type LLMError struct{ Msg string }

func (e LLMError) Error() string { return e.Msg }

// LLMConfig holds OpenAI-compatible chat settings.
type LLMConfig struct {
	BaseURL     string
	APIKey      string
	Model       string
	Temperature float64
	MaxTokens   int
	Timeout     time.Duration
}

// Configured reports whether credentials are present.
func (c LLMConfig) Configured() bool {
	return strings.TrimSpace(c.APIKey) != "" && strings.TrimSpace(c.Model) != "" && strings.TrimSpace(c.BaseURL) != ""
}

// Message is one chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// -------- 全局 LLM 请求限流 --------
// 三部 pipeline 并发时，如果同时打到同一个 API key 会触发 gateway 的 per-minute /
// per-key rate limit（429 / 503），单集重试就容易崩。这里在 client 层做一个
// 全局 per-key 并发信号量：同一个 BaseURL+APIKey 组合最多 N 个并发请求排队，
// pipeline 其他阶段（下载 / ASR）仍可并发，只有 LLM 请求串行排队。

var (
	llmConcurrencyOnce sync.Once
	llmConcurrencyMu   sync.Mutex
	llmConcurrencySem  map[string]chan struct{}
	// 默认最多 2 个并发请求到同一个 API key。可以用环境变量 LLM_MAX_CONCURRENT 覆盖。
	llmMaxConcurrent = 2
)

func initLLMConcurrency() {
	llmConcurrencyOnce.Do(func() {
		if v := strings.TrimSpace(os.Getenv("LLM_MAX_CONCURRENT")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				llmMaxConcurrent = n
			}
		}
		if llmMaxConcurrent > 8 {
			llmMaxConcurrent = 8 // 封顶，避免用户误设太大反而冲爆网关
		}
		llmConcurrencySem = map[string]chan struct{}{}
	})
}

// acquireLLMSlot 对同一个 API key 的并发请求排队，返回 release 函数。
func acquireLLMSlot(baseURL, apiKey string) func() {
	initLLMConcurrency()
	key := baseURL + "|" + apiKey
	llmConcurrencyMu.Lock()
	sem, ok := llmConcurrencySem[key]
	if !ok {
		sem = make(chan struct{}, llmMaxConcurrent)
		llmConcurrencySem[key] = sem
	}
	llmConcurrencyMu.Unlock()
	sem <- struct{}{}
	return func() { <-sem }
}

// LLMClient talks to an OpenAI-compatible chat endpoint.
type LLMClient struct {
	cfg      LLMConfig
	endpoint string
	client   *http.Client
}

// NewLLMClient creates a chat client.
func NewLLMClient(cfg LLMConfig) (*LLMClient, error) {
	if !cfg.Configured() {
		return nil, LLMError{"请先填写模型接口地址、API Key 和模型名称。"}
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 900 * time.Second
	}
	if cfg.MaxTokens <= 0 {
		cfg.MaxTokens = 16384
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	endpoint := base
	if !strings.HasSuffix(base, "/chat/completions") {
		endpoint = base + "/chat/completions"
	}
	return &LLMClient{
		cfg:      cfg,
		endpoint: endpoint,
		client:   &http.Client{Timeout: cfg.Timeout + 30*time.Second},
	}, nil
}

// ChatOptions overrides defaults for one call.
type ChatOptions struct {
	JSONMode    bool
	MaxTokens   int
	Temperature float64
	// Stream forces SSE; JSON mode defaults to non-stream for gateway compatibility.
	Stream *bool
}

// Chat sends messages and returns assistant text.
func (c *LLMClient) Chat(messages []Message, jsonMode bool) (string, error) {
	return c.ChatOpt(messages, ChatOptions{JSONMode: jsonMode})
}

// ChatOpt sends messages with per-call options.
func (c *LLMClient) ChatOpt(messages []Message, opt ChatOptions) (string, error) {
	maxTokens := c.cfg.MaxTokens
	if opt.MaxTokens > 0 {
		maxTokens = opt.MaxTokens
	}
	temp := c.cfg.Temperature
	if opt.Temperature > 0 {
		temp = opt.Temperature
	} else if opt.JSONMode {
		temp = 0.3
	}
	stream := !opt.JSONMode
	if opt.Stream != nil {
		stream = *opt.Stream
	}

	payload := map[string]any{
		"model":       c.cfg.Model,
		"messages":    messages,
		"temperature": temp,
		"max_tokens":  maxTokens,
		"stream":      stream,
	}
	if opt.JSONMode {
		payload["response_format"] = map[string]string{"type": "json_object"}
	}
	raw, _ := json.Marshal(payload)
	var last error
	for attempt := 1; attempt <= 3; attempt++ {
		// ---- 全局限流：同一个 API key 最多 N 个并发请求 ----
		release := acquireLLMSlot(c.cfg.BaseURL, c.cfg.APIKey)

		req, err := http.NewRequest(http.MethodPost, c.endpoint, bytes.NewReader(raw))
		if err != nil {
			release()
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
		resp, err := c.client.Do(req)
		if err != nil {
			release()
			last = err
			time.Sleep(time.Duration(attempt*4) * time.Second)
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 48<<20))
		resp.Body.Close()
		if readErr != nil {
			release()
			last = readErr
			continue
		}
		if resp.StatusCode == 400 && opt.JSONMode && bytes.Contains(body, []byte("response_format")) {
			// 部分网关不支持 json_object：去掉后重试，仍靠提示词约束。
			delete(payload, "response_format")
			raw, _ = json.Marshal(payload)
			release()
			last = LLMError{fmt.Sprintf("网关不支持 response_format，已降级：%s", truncate(string(body), 200))}
			continue
		}
		if resp.StatusCode == 429 || resp.StatusCode == 500 || resp.StatusCode == 502 ||
			resp.StatusCode == 503 || resp.StatusCode == 504 {
			// ---- 尊重 Retry-After header：API 端限流时告诉我们要等多久 ----
			wait := retryAfterSeconds(resp.Header.Get("Retry-After"))
			if wait <= 0 {
				wait = attempt * 5
			}
			release()
			last = LLMError{fmt.Sprintf("模型接口返回 HTTP %d（等待 %ds）：%s", resp.StatusCode, wait, truncate(string(body), 300))}
			time.Sleep(time.Duration(wait) * time.Second)
			continue
		}
		// 4xx 其它（401 / 403 / 404 等）直接报，不重试
		if resp.StatusCode >= 400 {
			release()
			return "", LLMError{fmt.Sprintf("模型接口返回 HTTP %d：%s", resp.StatusCode, truncate(string(body), 500))}
		}
		// 成功拿到响应，释放 slot 并解析
		ct := resp.Header.Get("Content-Type")
		var text string
		finishOK := true
		if stream || strings.Contains(ct, "event-stream") || bytes.Contains(body, []byte("data:")) {
			var finish string
			text, finish = readStream(body)
			if finish == "length" && !strings.Contains(text, "truncated_by_max_tokens") {
				text += "\n/* truncated_by_max_tokens */"
				finishOK = false
			}
		} else {
			var parsed struct {
				Choices []struct {
					Message struct {
						Content any `json:"content"`
					} `json:"message"`
					FinishReason string `json:"finish_reason"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(body, &parsed); err != nil {
				release()
				last = LLMError{"模型接口返回的不是 JSON。"}
				continue
			}
			if len(parsed.Choices) == 0 {
				release()
				last = LLMError{fmt.Sprintf("模型接口没有返回内容：%s", truncate(string(body), 300))}
				continue
			}
			text = contentToString(parsed.Choices[0].Message.Content)
			if parsed.Choices[0].FinishReason == "length" {
				text += "\n/* truncated_by_max_tokens */"
				finishOK = false
			}
		}
		release() // 响应已处理完毕，尽早释放 slot 给下一个请求
		if strings.TrimSpace(text) == "" {
			last = LLMError{"模型返回了空内容。"}
			time.Sleep(time.Duration(attempt*3) * time.Second)
			continue
		}
		_ = finishOK
		return text, nil
	}
	return "", LLMError{fmt.Sprintf("模型请求失败：%v", last)}
}

// retryAfterSeconds 解析 API 返回的 Retry-After header（格式：秒数 或 HTTP 日期）。
func retryAfterSeconds(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		if n > 300 {
			n = 300 // 兜底：最长等 5 分钟
		}
		return n
	}
	// 也可能是 HTTP 日期："Fri, 31 Dec 2025 23:59:59 GMT"
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, time.RFC850, "Monday, 02-Jan-06 15:04:05 MST"} {
		if t, err := time.Parse(layout, raw); err == nil {
			d := time.Until(t).Seconds()
			if d > 0 {
				if d > 300 {
					d = 300
				}
				return int(d)
			}
		}
	}
	return 0
}

func readStream(body []byte) (text string, finishReason string) {
	var pieces []string
	sc := bufio.NewScanner(bytes.NewReader(body))
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 8<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		chunk := strings.TrimSpace(line[5:])
		if chunk == "[DONE]" {
			break
		}
		var payload struct {
			Choices []struct {
				Delta struct {
					Content any `json:"content"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(chunk), &payload) != nil || len(payload.Choices) == 0 {
			continue
		}
		pieces = append(pieces, contentToString(payload.Choices[0].Delta.Content))
		if fr := strings.TrimSpace(payload.Choices[0].FinishReason); fr != "" {
			finishReason = fr
		}
	}
	return strings.TrimSpace(strings.Join(pieces, "")), finishReason
}

func contentToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var b strings.Builder
		for _, item := range t {
			if m, ok := item.(map[string]any); ok {
				b.WriteString(fmt.Sprint(m["text"]))
			}
		}
		return b.String()
	default:
		return ""
	}
}
