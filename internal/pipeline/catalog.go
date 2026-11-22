// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/LingByte/miniseadrama/internal/pipeline/shortflix"
)

// ListCatalogPage 浏览短剧库。
// 默认只读本地（磁盘分页缓存 + data/pipeline 工作目录 / prefetch 清单），不连 ShortFlix。
// refresh=true 才打源头站，失败仍回落本地。
func ListCatalogPage(cookie, cursor, query string, limit int, loadedTitles []string, refresh bool) (shortflix.CatalogPage, error) {
	if limit <= 0 || limit > 50 {
		limit = 48
	}
	cursor = strings.TrimSpace(cursor)
	query = strings.TrimSpace(query)

	serveLocal := func() shortflix.CatalogPage {
		if cached, ok := loadCatalogPageCacheStale(cursor, query, limit); ok {
			markLoaded(cached.Items, loadedTitles)
			markSubtitleStatus(cached.Items)
			return cached
		}
		page := pageFromLocalIndex(cursor, query, limit)
		markLoaded(page.Items, loadedTitles)
		markSubtitleStatus(page.Items)
		return page
	}

	if !refresh {
		local := serveLocal()
		// 本地有货直接返回；清空缓存后本地为空则自动打源头（不必再点「刷新」）
		if len(local.Items) > 0 {
			return local, nil
		}
	}

	// 强制刷新，或本地为空：尝试源头，成功则写入缓存
	page, err := shortflix.DiscoverCatalogPage(cookie, cursor, query, limit)
	if err != nil || len(page.Items) == 0 {
		local := serveLocal()
		if len(local.Items) > 0 {
			return local, nil
		}
		if err != nil {
			return shortflix.CatalogPage{}, err
		}
		return local, nil
	}
	saveCatalogPageCache(cursor, query, limit, page)
	markLoaded(page.Items, loadedTitles)
	markSubtitleStatus(page.Items)
	return page, nil
}

// ListCatalog returns the first catalog page (兼容旧调用).
func ListCatalog(cookie string, loadedTitles []string) ([]shortflix.CatalogItem, error) {
	page, err := ListCatalogPage(cookie, "", "", 48, loadedTitles, false)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func markLoaded(items []shortflix.CatalogItem, loadedTitles []string) {
	titleSet := map[string]struct{}{}
	for _, t := range loadedTitles {
		key := normalizeTitle(t)
		if key != "" {
			titleSet[key] = struct{}{}
		}
	}
	workdirSlugs, workdirTitles := loadedWorkdirIndex()
	for i := range items {
		slug := strings.ToLower(strings.TrimSpace(items[i].Slug))
		title := normalizeTitle(items[i].Title)
		_, byTitle := titleSet[title]
		_, byDirTitle := workdirTitles[title]
		_, bySlug := workdirSlugs[slug]
		items[i].Loaded = byTitle || byDirTitle || bySlug
	}
}

func normalizeTitle(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
}

// loadedWorkdirIndex 扫描 data/pipeline 下形如 "Title [slug]" 的目录。
func loadedWorkdirIndex() (slugs map[string]struct{}, titles map[string]struct{}) {
	slugs = map[string]struct{}{}
	titles = map[string]struct{}{}
	root := WorkDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return slugs, titles
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if name == "cache" {
			continue
		}
		slug := extractBracketSlug(name)
		if slug != "" {
			slugs[strings.ToLower(slug)] = struct{}{}
		}
		if title := extractDirTitle(name); title != "" {
			titles[normalizeTitle(title)] = struct{}{}
		}
	}
	return slugs, titles
}

func extractDirTitle(name string) string {
	start := strings.LastIndex(name, "[")
	if start <= 0 {
		return strings.TrimSpace(name)
	}
	return strings.TrimSpace(name[:start])
}

func extractBracketSlug(name string) string {
	start := strings.LastIndex(name, "[")
	end := strings.LastIndex(name, "]")
	if start < 0 || end <= start {
		return ""
	}
	return strings.TrimSpace(name[start+1 : end])
}

// pageFromLocalIndex 用 prefetch_manifest + 工作目录拼本地剧目列表，cursor 为数字 offset。
func pageFromLocalIndex(cursor, query string, limit int) shortflix.CatalogPage {
	all := buildLocalCatalogItems()
	q := strings.ToLower(strings.TrimSpace(query))
	if q != "" {
		filtered := make([]shortflix.CatalogItem, 0, len(all))
		for _, it := range all {
			if strings.Contains(strings.ToLower(it.Title), q) || strings.Contains(strings.ToLower(it.Slug), q) {
				filtered = append(filtered, it)
			}
		}
		all = filtered
	}
	offset := 0
	if cursor != "" {
		if n, err := strconv.Atoi(cursor); err == nil && n > 0 {
			offset = n
		}
	}
	if offset > len(all) {
		offset = len(all)
	}
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	items := all[offset:end]
	next := ""
	hasMore := end < len(all)
	if hasMore {
		next = strconv.Itoa(end)
	}
	return shortflix.CatalogPage{Items: items, NextCursor: next, HasMore: hasMore}
}

func buildLocalCatalogItems() []shortflix.CatalogItem {
	bySlug := map[string]shortflix.CatalogItem{}

	// 1) prefetch_manifest
	manifestPath := filepath.Join(WorkDir(), "prefetch_manifest.json")
	if raw, err := os.ReadFile(manifestPath); err == nil {
		var m struct {
			Results []struct {
				Slug    string `json:"slug"`
				Title   string `json:"title"`
				OK      bool   `json:"ok"`
				Workdir string `json:"workdir"`
			} `json:"results"`
		}
		if json.Unmarshal(raw, &m) == nil {
			for _, r := range m.Results {
				slug := strings.TrimSpace(r.Slug)
				title := strings.TrimSpace(r.Title)
				if slug == "" || title == "" {
					continue
				}
				item := shortflix.CatalogItem{
					ID:        slug,
					Title:     title,
					Slug:      slug,
					SourceURL: "https://www.shortflix.net/videos/" + slug + "/episode-1",
					Loaded:    true,
				}
				if r.OK {
					item.SubtitleStatus = shortflix.SubStatusSoftEN
				} else {
					item.SubtitleStatus = shortflix.SubStatusHardOnly
				}
				if cover := coverFromWorkdir(r.Workdir); cover != "" {
					item.Cover = cover
				}
				bySlug[strings.ToLower(slug)] = item
			}
		}
	}

	// 2) 扫描工作目录补齐 cover / 漏网条目
	entries, err := os.ReadDir(WorkDir())
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() || e.Name() == "cache" {
				continue
			}
			slug := extractBracketSlug(e.Name())
			title := extractDirTitle(e.Name())
			if slug == "" || title == "" {
				continue
			}
			key := strings.ToLower(slug)
			item, ok := bySlug[key]
			if !ok {
				item = shortflix.CatalogItem{
					ID:        slug,
					Title:     title,
					Slug:      slug,
					SourceURL: "https://www.shortflix.net/videos/" + slug + "/episode-1",
					Loaded:    true,
				}
			}
			if item.Cover == "" {
				if cover := coverFromWorkdir(e.Name()); cover != "" {
					item.Cover = cover
				}
			}
			bySlug[key] = item
		}
	}

	out := make([]shortflix.CatalogItem, 0, len(bySlug))
	for _, it := range bySlug {
		out = append(out, it)
	}
	// 稳定一点：按 title
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].Title < out[i].Title {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func coverFromWorkdir(relOrName string) string {
	relOrName = strings.TrimSpace(relOrName)
	if relOrName == "" {
		return ""
	}
	dir := relOrName
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(WorkDir(), relOrName)
	}
	// series.json 里 cover / thumbnailUrl
	p := filepath.Join(dir, "series.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	for _, k := range []string{"cover", "thumbnailUrl", "thumbnail_url", "poster"} {
		if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
