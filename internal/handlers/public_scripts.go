// Copyright (c) 2026 lingbyte. All rights reserved.

package handlers

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/pkg/common/response"
	respgin "github.com/LingByte/miniseadrama/pkg/common/response/gin"

	"github.com/gin-gonic/gin"
)

const (
	catalogPageDefault = 15
	catalogPageMax     = 48
	catalogCacheTTL    = 20 * time.Second
)

// catalogCard 书架卡片字段：无分集正文 / 无长简介，搜索仍可用 logline。
type catalogCard struct {
	ID             string
	Title          string
	EnTitle        string
	Logline        string
	Cover          string
	Tags           []string
	Markets        []string
	Audience       string
	Language       string
	TotalEpisodes  int
	TrialCount     int
	Price          float64
	Sales          int
	Rating         float64
	CreatedAt      string
	Quality        string
	SaleType       string
	BuyoutSold     bool
	Extra          map[string][]string
	SearchBlob     string
}

type catalogSnapshot struct {
	at    time.Time
	cards []catalogCard
}

var catalogCache struct {
	mu   sync.Mutex
	snap catalogSnapshot
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	default:
		return 0
	}
}

func asStringSlice(v any) []string {
	switch xs := v.(type) {
	case []string:
		return append([]string(nil), xs...)
	case []any:
		out := make([]string, 0, len(xs))
		for _, x := range xs {
			if s := str(x); s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func asExtraMap(v any) map[string][]string {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return nil
	}
	out := make(map[string][]string, len(m))
	for k, raw := range m {
		out[k] = asStringSlice(raw)
	}
	return out
}

func toCatalogCard(script map[string]any, sold bool) catalogCard {
	tags := asStringSlice(script["tags"])
	markets := asStringSlice(script["markets"])
	quality := str(script["quality"])
	extra := asExtraMap(script["extra"])
	c := catalogCard{
		ID:            str(script["id"]),
		Title:         str(script["title"]),
		EnTitle:       str(script["enTitle"]),
		Logline:       str(script["logline"]),
		Cover:         str(script["cover"]),
		Tags:          tags,
		Markets:       markets,
		Audience:      str(script["audience"]),
		Language:      str(script["language"]),
		TotalEpisodes: asInt(script["totalEpisodes"]),
		TrialCount:    asInt(script["trialCount"]),
		Price:         asFloat(script["price"]),
		Sales:         asInt(script["sales"]),
		Rating:        asFloat(script["rating"]),
		CreatedAt:     str(script["createdAt"]),
		Quality:       quality,
		SaleType:      str(script["saleType"]),
		BuyoutSold:    sold,
		Extra:         extra,
	}
	parts := []string{c.Title, c.EnTitle, c.Logline, str(script["synopsis"]), c.Quality, c.Language}
	parts = append(parts, tags...)
	parts = append(parts, markets...)
	c.SearchBlob = strings.ToLower(strings.Join(parts, " "))
	return c
}

func (c catalogCard) toAPI() map[string]any {
	extra := c.Extra
	if extra == nil {
		extra = map[string][]string{}
	}
	out := map[string]any{
		"id":            c.ID,
		"title":         c.Title,
		"enTitle":       c.EnTitle,
		"logline":       c.Logline,
		"synopsis":      "",
		"cover":         c.Cover,
		"tags":          c.Tags,
		"markets":       c.Markets,
		"audience":      c.Audience,
		"language":      c.Language,
		"totalEpisodes": c.TotalEpisodes,
		"trialCount":    c.TrialCount,
		"episodes":      []any{},
		"price":         c.Price,
		"status":        "on",
		"sales":         c.Sales,
		"rating":        c.Rating,
		"createdAt":     c.CreatedAt,
		"quality":       c.Quality,
		"saleType":      c.SaleType,
		"buyoutSold":    c.BuyoutSold,
		"extra":         extra,
		"priceHistory":  []any{},
	}
	return withResolvedCover(out)
}

func (h *Handlers) buyoutSoldSet(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	if h.db == nil {
		return out
	}
	var ids []string
	_ = h.db.WithContext(ctx).Model(&models.Order{}).
		Where("status = ? AND sale_type = ?", "paid", "buyout").
		Distinct().Pluck("script_id", &ids)
	for _, id := range ids {
		if id != "" {
			out[id] = true
		}
	}
	return out
}

func (h *Handlers) loadCatalogCards(ctx context.Context) ([]catalogCard, error) {
	catalogCache.mu.Lock()
	if time.Since(catalogCache.snap.at) < catalogCacheTTL && catalogCache.snap.cards != nil {
		cards := catalogCache.snap.cards
		catalogCache.mu.Unlock()
		return cards, nil
	}
	catalogCache.mu.Unlock()

	if h.db == nil {
		return nil, nil
	}
	// MySQL：在库内清空 episodes，避免把分集 longtext 拉进应用（书架不需要正文）。
	var rows []models.AdminScript
	var err error
	if h.db.Dialector.Name() == "mysql" {
		err = h.db.WithContext(ctx).Raw(`
			SELECT script_id, file_name, file_size, file_path, created_at, updated_at,
				JSON_SET(payload, '$.episodes', JSON_ARRAY()) AS payload
			FROM admin_scripts
			ORDER BY updated_at DESC`).Scan(&rows).Error
	} else {
		err = h.db.WithContext(ctx).Order("updated_at DESC").Find(&rows).Error
	}
	if err != nil {
		return nil, err
	}
	sold := h.buyoutSoldSet(ctx)
	cards := make([]catalogCard, 0, len(rows))
	for i := range rows {
		script := rows[i].ToScript()
		if !strings.EqualFold(str(script["status"]), "on") {
			continue
		}
		// 仅当前仍是买断售卖、且已有买断成交时才标已买断（改成批发后不应再显示）
		marked := sold[rows[i].ScriptID] && strings.EqualFold(str(script["saleType"]), "buyout")
		cards = append(cards, toCatalogCard(script, marked))
	}

	catalogCache.mu.Lock()
	catalogCache.snap = catalogSnapshot{at: time.Now(), cards: cards}
	catalogCache.mu.Unlock()
	return cards, nil
}

func catalogVals(c catalogCard, gid string) []string {
	switch gid {
	case "plot":
		return c.Tags
	case "market":
		return c.Markets
	case "quality":
		if c.Quality == "" {
			return nil
		}
		return []string{c.Quality}
	default:
		if c.Extra == nil {
			return nil
		}
		return c.Extra[gid]
	}
}

func containsStr(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func filterCatalog(cards []catalogCard, q, plot, market, quality, saleType, tagSel string) []catalogCard {
	kw := strings.ToLower(strings.TrimSpace(q))
	out := make([]catalogCard, 0, len(cards))
	for _, c := range cards {
		if plot != "" && plot != "全部" && !containsStr(c.Tags, plot) {
			continue
		}
		if market != "" && market != "全部市场" && !containsStr(c.Markets, market) {
			continue
		}
		if quality != "" && quality != "全部品质" && c.Quality != quality {
			continue
		}
		if saleType != "" && saleType != "全部" && c.SaleType != saleType {
			continue
		}
		if tagSel != "" && tagSel != "全部标签" {
			parts := strings.SplitN(tagSel, "::", 2)
			if len(parts) != 2 || !containsStr(catalogVals(c, parts[0]), parts[1]) {
				continue
			}
		}
		if kw != "" && !strings.Contains(c.SearchBlob, kw) {
			continue
		}
		out = append(out, c)
	}
	return out
}

func sortCatalog(cards []catalogCard, sortKey string) {
	switch sortKey {
	case "new":
		sort.SliceStable(cards, func(i, j int) bool { return cards[i].CreatedAt > cards[j].CreatedAt })
	case "sales":
		sort.SliceStable(cards, func(i, j int) bool { return cards[i].Sales > cards[j].Sales })
	case "priceAsc":
		sort.SliceStable(cards, func(i, j int) bool { return cards[i].Price < cards[j].Price })
	case "priceDesc":
		sort.SliceStable(cards, func(i, j int) bool { return cards[i].Price > cards[j].Price })
	default: // hot
		sort.SliceStable(cards, func(i, j int) bool {
			ai := float64(cards[i].Sales) * cards[i].Rating
			aj := float64(cards[j].Sales) * cards[j].Rating
			if ai == aj {
				return cards[i].CreatedAt > cards[j].CreatedAt
			}
			return ai > aj
		})
	}
}

func pageByCursor(cards []catalogCard, cursor string, limit int) (page []catalogCard, next string) {
	start := 0
	if cursor != "" {
		for i := range cards {
			if cards[i].ID == cursor {
				start = i + 1
				break
			}
		}
	}
	if start > len(cards) {
		start = len(cards)
	}
	end := start + limit
	if end > len(cards) {
		end = len(cards)
	}
	page = cards[start:end]
	if end < len(cards) && len(page) > 0 {
		next = page[len(page)-1].ID
	}
	return page, next
}

// ListPublicScripts GET /api/v1/scripts — 上架剧本游标分页（书架卡片，无分集正文）。
func (h *Handlers) ListPublicScripts(c *gin.Context) {
	limit := catalogPageDefault
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > catalogPageMax {
		limit = catalogPageMax
	}
	cursor := strings.TrimSpace(c.Query("cursor"))
	q := c.Query("q")
	plot := c.Query("plot")
	market := c.Query("market")
	quality := c.Query("quality")
	saleType := c.Query("saleType")
	if saleType == "" {
		saleType = c.Query("sale_type")
	}
	tagSel := c.Query("tag")
	sortKey := c.Query("sort")
	if sortKey == "" {
		sortKey = "hot"
	}

	cards, err := h.loadCatalogCards(c.Request.Context())
	if err != nil {
		respgin.WriteError(c, response.Err(response.CodeInternal))
		return
	}

	plotCounts := map[string]int{}
	newCount := 0
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	for _, card := range cards {
		for _, t := range card.Tags {
			plotCounts[t]++
		}
		if t, err := time.Parse(time.RFC3339, card.CreatedAt); err == nil && t.After(cutoff) {
			newCount++
		}
	}

	filtered := filterCatalog(cards, q, plot, market, quality, saleType, tagSel)
	sortCatalog(filtered, sortKey)
	page, next := pageByCursor(filtered, cursor, limit)

	scripts := make([]map[string]any, 0, len(page))
	for _, card := range page {
		scripts = append(scripts, card.toAPI())
	}

	featured := []map[string]any{}
	if cursor == "" {
		hot := append([]catalogCard(nil), cards...)
		sortCatalog(hot, "sales")
		n := 4
		if len(hot) < n {
			n = len(hot)
		}
		for i := 0; i < n; i++ {
			featured = append(featured, hot[i].toAPI())
		}
	}

	respgin.Success(c, gin.H{
		"scripts":     scripts,
		"nextCursor":  next,
		"total":       len(filtered),
		"onSaleTotal": len(cards),
		"plotCounts":  plotCounts,
		"featured":    featured,
		"newCount":    newCount,
	})
}
