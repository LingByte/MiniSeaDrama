// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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
		req, err := http.NewRequest(http.MethodPost, c.endpoint, bytes.NewReader(raw))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
		resp, err := c.client.Do(req)
		if err != nil {
			last = err
			time.Sleep(time.Duration(attempt*4) * time.Second)
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 48<<20))
		resp.Body.Close()
		if readErr != nil {
			last = readErr
			continue
		}
		if resp.StatusCode == 400 && opt.JSONMode && bytes.Contains(body, []byte("response_format")) {
			// 部分网关不支持 json_object：去掉后重试，仍靠提示词约束。
			delete(payload, "response_format")
			raw, _ = json.Marshal(payload)
			last = LLMError{fmt.Sprintf("网关不支持 response_format，已降级：%s", truncate(string(body), 200))}
			continue
		}
		if resp.StatusCode == 429 || resp.StatusCode == 500 || resp.StatusCode == 502 ||
			resp.StatusCode == 503 || resp.StatusCode == 504 {
			last = LLMError{fmt.Sprintf("模型接口返回 HTTP %d：%s", resp.StatusCode, truncate(string(body), 300))}
			time.Sleep(time.Duration(attempt*5) * time.Second)
			continue
		}
		if resp.StatusCode >= 400 {
			return "", LLMError{fmt.Sprintf("模型接口返回 HTTP %d：%s", resp.StatusCode, truncate(string(body), 500))}
		}
		ct := resp.Header.Get("Content-Type")
		var text string
		if stream || strings.Contains(ct, "event-stream") || bytes.Contains(body, []byte("data:")) {
			text = readStream(body)
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
				last = LLMError{"模型接口返回的不是 JSON。"}
				continue
			}
			if len(parsed.Choices) == 0 {
				last = LLMError{fmt.Sprintf("模型接口没有返回内容：%s", truncate(string(body), 300))}
				continue
			}
			text = contentToString(parsed.Choices[0].Message.Content)
			if parsed.Choices[0].FinishReason == "length" {
				// 标记截断，交给上层 JSON 修复/重试
				text += "\n/* truncated_by_max_tokens */"
			}
		}
		if strings.TrimSpace(text) == "" {
			last = LLMError{"模型返回了空内容。"}
			time.Sleep(time.Duration(attempt*3) * time.Second)
			continue
		}
		return text, nil
	}
	return "", LLMError{fmt.Sprintf("模型请求失败：%v", last)}
}

func readStream(body []byte) string {
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
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(chunk), &payload) != nil || len(payload.Choices) == 0 {
			continue
		}
		pieces = append(pieces, contentToString(payload.Choices[0].Delta.Content))
	}
	return strings.TrimSpace(strings.Join(pieces, ""))
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
