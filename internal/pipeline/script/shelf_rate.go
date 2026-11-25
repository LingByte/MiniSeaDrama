// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/LingByte/miniseadrama/internal/pricing"
)

// ShelfRateInput is one script snapshot for shelf tagging/grading.
type ShelfRateInput struct {
	ID       string
	Title    string
	EnTitle  string
	Logline  string
	Synopsis string
	Audience string
}

// ShelfRateResult is the model’s shelf assignment.
type ShelfRateResult struct {
	ID       string   `json:"id"`
	Grade    string   `json:"grade"`
	Tags     []string `json:"tags"`
	Audience string   `json:"audience"`
	Reason   string   `json:"reason"`
}

// RateShelfBatch asks the model to diversify plot tags and grades for a batch.
// Target mix (approx): D 40% / C 30% / B 22% / A 7% / S ≤1%.
func RateShelfBatch(client *LLMClient, items []ShelfRateInput) ([]ShelfRateResult, error) {
	if client == nil {
		return nil, LLMError{"LLM client 未初始化"}
	}
	if len(items) == 0 {
		return nil, nil
	}
	type row struct {
		ID       string `json:"id"`
		Title    string `json:"title"`
		EnTitle  string `json:"enTitle,omitempty"`
		Logline  string `json:"logline,omitempty"`
		Synopsis string `json:"synopsis,omitempty"`
		Audience string `json:"audience,omitempty"`
	}
	payload := make([]row, 0, len(items))
	for _, it := range items {
		payload = append(payload, row{
			ID:       it.ID,
			Title:    truncateRunes(it.Title, 40),
			EnTitle:  truncateRunes(it.EnTitle, 60),
			Logline:  truncateRunes(it.Logline, 80),
			Synopsis: truncateRunes(it.Synopsis, 220),
			Audience: it.Audience,
		})
	}
	rawItems, _ := json.Marshal(payload)
	tagList := strings.Join(pricing.PlotTags, "、")
	n := len(items)
	sys := `你是海外短剧剧本货架运营。给每部剧本打情节标签与质量评级，供后台二审。
规则：
1) grade 只能是 S/A/B/C/D。本批约 ` + fmt.Sprintf("%d", n) + ` 部，目标分布（可略浮动）：D≈40%、C≈30%、B≈22%、A≈7%、S≤1%（本批最多 1 个 S）。多数应是批发特价到基础档（D/C），不要几乎全是 B。
2) tags 必须从白名单里选 2～4 个，且真正贴合剧情。禁止整批发「豪门+反转」；同类题材也要换角度（如打脸/隐藏身份/契约婚姻/重生/大女主/爽文/命定伴侣等）。
3) audience 只能是「女频」或「男频」。
4) 只输出 JSON：{"items":[{"id":"...","grade":"D","tags":["重生","打脸"],"audience":"女频","reason":"一句话"}]}，items 必须覆盖输入的每一个 id。`
	user := "情节标签白名单：" + tagList + "\n\n剧本列表 JSON：\n" + string(rawItems)
	text, err := client.ChatOpt([]Message{
		{Role: "system", Content: sys},
		{Role: "user", Content: user},
	}, ChatOptions{JSONMode: true, MaxTokens: 8192, Temperature: 0.55})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Items []ShelfRateResult `json:"items"`
	}
	if err := json.Unmarshal([]byte(extractJSONObject(text)), &parsed); err != nil {
		return nil, fmt.Errorf("解析评级 JSON 失败: %w", err)
	}
	byID := make(map[string]ShelfRateResult, len(parsed.Items))
	for _, it := range parsed.Items {
		id := strings.TrimSpace(it.ID)
		if id == "" {
			continue
		}
		it.Grade = strings.ToUpper(strings.TrimSpace(it.Grade))
		if it.Grade == "" || !strings.Contains("SABCD", it.Grade[:1]) {
			it.Grade = "C"
		} else {
			it.Grade = string(it.Grade[0])
		}
		it.Tags = pricing.NormalizePlotTags(it.Tags, 4)
		if len(it.Tags) == 0 {
			it.Tags = []string{"爽文", "逆袭"}
		}
		if it.Audience != "男频" {
			it.Audience = "女频"
		}
		byID[id] = it
	}
	out := make([]ShelfRateResult, 0, len(items))
	for _, it := range items {
		if got, ok := byID[it.ID]; ok {
			out = append(out, got)
			continue
		}
		out = append(out, ShelfRateResult{
			ID: it.ID, Grade: "C", Tags: []string{"爽文", "逆袭"}, Audience: "女频", Reason: "模型未返回，回落 C",
		})
	}
	return out, nil
}

// RateSingleShelf rates one new script after generation (light call).
func RateSingleShelf(client *LLMClient, title, logline, synopsis, audience string) (grade string, tags []string, aud string, err error) {
	res, err := RateShelfBatch(client, []ShelfRateInput{{
		ID: "x", Title: title, Logline: logline, Synopsis: synopsis, Audience: audience,
	}})
	if err != nil {
		return "B", nil, "女频", err
	}
	if len(res) == 0 {
		return "C", []string{"爽文", "逆袭"}, "女频", nil
	}
	return res[0].Grade, res[0].Tags, res[0].Audience, nil
}

func truncateRunes(s string, n int) string {
	s = strings.TrimSpace(s)
	if s == "" || n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "{"); i >= 0 {
		if j := strings.LastIndex(s, "}"); j > i {
			return s[i : j+1]
		}
	}
	return s
}
