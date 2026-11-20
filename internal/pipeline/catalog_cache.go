// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/pipeline/shortflix"
)

const catalogCacheTTL = 24 * time.Hour

type catalogCacheEntry struct {
	At         time.Time             `json:"at"`
	Cursor     string                `json:"cursor"`
	Query      string                `json:"query"`
	Limit      int                   `json:"limit"`
	Items      []shortflix.CatalogItem `json:"items"`
	NextCursor string                `json:"next_cursor"`
	HasMore    bool                  `json:"has_more"`
}

func catalogCacheDir() string {
	return filepath.Join(CacheDir(), "catalog")
}

func catalogPageKey(cursor, query string, limit int) string {
	h := sha1.Sum([]byte(strings.TrimSpace(cursor) + "|" + strings.TrimSpace(query) + "|" + itoa(limit)))
	return hex.EncodeToString(h[:])[:16]
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func catalogPagePath(cursor, query string, limit int) string {
	return filepath.Join(catalogCacheDir(), "page_"+catalogPageKey(cursor, query, limit)+".json")
}

func loadCatalogPageCache(cursor, query string, limit int) (shortflix.CatalogPage, bool) {
	path := catalogPagePath(cursor, query, limit)
	raw, err := os.ReadFile(path)
	if err != nil {
		return shortflix.CatalogPage{}, false
	}
	var entry catalogCacheEntry
	if json.Unmarshal(raw, &entry) != nil || len(entry.Items) == 0 {
		return shortflix.CatalogPage{}, false
	}
	if time.Since(entry.At) > catalogCacheTTL {
		// 过期仍可用作兜底，由调用方决定；这里返回 false 让优先走网络
		return shortflix.CatalogPage{}, false
	}
	return shortflix.CatalogPage{
		Items:      entry.Items,
		NextCursor: entry.NextCursor,
		HasMore:    entry.HasMore,
	}, true
}

func loadCatalogPageCacheStale(cursor, query string, limit int) (shortflix.CatalogPage, bool) {
	path := catalogPagePath(cursor, query, limit)
	raw, err := os.ReadFile(path)
	if err != nil {
		return shortflix.CatalogPage{}, false
	}
	var entry catalogCacheEntry
	if json.Unmarshal(raw, &entry) != nil || len(entry.Items) == 0 {
		return shortflix.CatalogPage{}, false
	}
	return shortflix.CatalogPage{
		Items:      entry.Items,
		NextCursor: entry.NextCursor,
		HasMore:    entry.HasMore,
	}, true
}

func saveCatalogPageCache(cursor, query string, limit int, page shortflix.CatalogPage) {
	if len(page.Items) == 0 {
		return
	}
	_ = os.MkdirAll(catalogCacheDir(), 0o755)
	// 缓存里不落 loaded（随本地状态变），字幕状态可留着
	items := make([]shortflix.CatalogItem, len(page.Items))
	copy(items, page.Items)
	for i := range items {
		items[i].Loaded = false
	}
	entry := catalogCacheEntry{
		At:         time.Now(),
		Cursor:     cursor,
		Query:      query,
		Limit:      limit,
		Items:      items,
		NextCursor: page.NextCursor,
		HasMore:    page.HasMore,
	}
	raw, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(catalogPagePath(cursor, query, limit), raw, 0o644)
}
