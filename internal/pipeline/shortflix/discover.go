// Copyright (c) 2026 lingbyte. All rights reserved.

package shortflix

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36"

var nextChunkRE = regexp.MustCompile(`self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)`)

// ShortFlixError is a user-facing discover/download error.
type ShortFlixError struct{ Msg string }

func (e ShortFlixError) Error() string { return e.Msg }

// AuthenticationRequired means login cookie is needed.
type AuthenticationRequired struct{ Msg string }

func (e AuthenticationRequired) Error() string { return e.Msg }

// ValidateShortFlixURL normalizes a series URL.
func ValidateShortFlixURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", ShortFlixError{"请粘贴 ShortFlix 剧目或剧集链接。"}
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil {
		return "", ShortFlixError{"目前只支持 shortflix.net 的公开剧目或剧集链接。"}
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", ShortFlixError{"目前只支持 shortflix.net 的公开剧目或剧集链接。"}
	}
	if host != "shortflix.net" && host != "www.shortflix.net" {
		return "", ShortFlixError{"目前只支持 shortflix.net 的公开剧目或剧集链接。"}
	}
	if !strings.Contains(u.Path, "/videos/") {
		return "", ShortFlixError{"这不是剧目链接。请先进入某部剧，再复制包含 /videos/ 的地址。"}
	}
	u.Scheme = "https"
	u.Host = "www.shortflix.net"
	u.Fragment = ""
	u.RawQuery = ""
	return u.String(), nil
}

func canonicalEpisodeURL(raw string) (string, error) {
	normalized, err := ValidateShortFlixURL(raw)
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(normalized)
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	idx := indexOf(parts, "videos")
	if idx < 0 || idx+1 >= len(parts) {
		return "", ShortFlixError{"无法从链接中识别剧目名称。"}
	}
	slug := parts[idx+1]
	return fmt.Sprintf("https://www.shortflix.net/videos/%s/episode-1", slug), nil
}

func indexOf(slice []string, target string) int {
	for i, v := range slice {
		if v == target {
			return i
		}
	}
	return -1
}

func fetchText(urlStr, cookie string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	req, _ := http.NewRequest(http.MethodGet, urlStr, nil)
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", ShortFlixError{fmt.Sprintf("无法连接 ShortFlix：%v", err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", ShortFlixError{fmt.Sprintf("网站返回 HTTP %d，请稍后重试。", resp.StatusCode)}
	}
	body, _ := io.ReadAll(resp.Body)
	return string(body), nil
}

func decodeNextPayload(html string) (string, error) {
	var chunks []string
	for _, m := range nextChunkRE.FindAllStringSubmatch(html, -1) {
		if len(m) < 2 {
			continue
		}
		var piece string
		if err := json.Unmarshal([]byte(m[1]), &piece); err == nil {
			chunks = append(chunks, piece)
		}
	}
	if len(chunks) == 0 {
		return "", ShortFlixError{"页面结构已变化：没有找到 ShortFlix 剧集数据。"}
	}
	return strings.Join(chunks, ""), nil
}

func findSeriesObject(payload string) (map[string]any, error) {
	marker := `"video":`
	cursor := 0
	var candidates []map[string]any
	for {
		idx := strings.Index(payload[cursor:], marker)
		if idx < 0 {
			break
		}
		cursor += idx + len(marker)
		decoder := json.NewDecoder(strings.NewReader(payload[cursor:]))
		var candidate map[string]any
		if err := decoder.Decode(&candidate); err != nil {
			continue
		}
		if eps, ok := candidate["episodes"].([]any); ok && candidate["slug"] != nil && len(eps) > 0 {
			candidates = append(candidates, candidate)
		}
	}
	if len(candidates) == 0 {
		return nil, ShortFlixError{"页面结构已变化：没有找到完整的剧目信息。"}
	}
	best := candidates[0]
	bestCount := len(best["episodes"].([]any))
	for _, c := range candidates[1:] {
		if n := len(c["episodes"].([]any)); n > bestCount {
			best, bestCount = c, n
		}
	}
	return best, nil
}

func qualityScore(q string) int {
	re := regexp.MustCompile(`(\d+)`)
	m := re.FindStringSubmatch(q)
	if len(m) < 2 {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func parseSubtitles(raw any) []Subtitle {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	var out []Subtitle
	seen := map[string]struct{}{}
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		urlStr := strings.TrimSpace(fmt.Sprint(m["fileUrl"]))
		if strings.HasPrefix(urlStr, "//") {
			urlStr = "https:" + urlStr
		} else if strings.HasPrefix(urlStr, "/") {
			urlStr = "https://www.shortflix.net" + urlStr
		}
		if urlStr == "" {
			continue
		}
		if _, dup := seen[urlStr]; dup {
			continue
		}
		seen[urlStr] = struct{}{}
		format := strings.ToUpper(fmt.Sprint(m["format"]))
		if format == "" {
			format = "VTT"
		}
		out = append(out, Subtitle{
			Title:  fmt.Sprint(m["title"]),
			Format: format,
			URL:    urlStr,
		})
	}
	return out
}

// ParseSeriesHTML extracts series JSON embedded in a page.
func ParseSeriesHTML(pageHTML, sourceURL string) (Series, error) {
	payload, err := decodeNextPayload(pageHTML)
	if err != nil {
		return Series{}, err
	}
	rawSeries, err := findSeriesObject(payload)
	if err != nil {
		return Series{}, err
	}
	var episodes []Episode
	for _, rawEp := range rawSeries["episodes"].([]any) {
		epMap, ok := rawEp.(map[string]any)
		if !ok {
			continue
		}
		num, _ := strconv.Atoi(fmt.Sprint(epMap["episodeNumber"]))
		if num == 0 {
			continue
		}
		var versions []EpisodeVersion
		if rawVers, ok := epMap["versions"].([]any); ok {
			for _, rv := range rawVers {
				vm, ok := rv.(map[string]any)
				if !ok {
					continue
				}
				videoURL := strings.TrimSpace(fmt.Sprint(vm["videoUrl"]))
				if !strings.HasPrefix(videoURL, "http://") && !strings.HasPrefix(videoURL, "https://") {
					continue
				}
				subs := parseSubtitles(vm["subtitlesList"])
				if len(subs) == 0 {
					subs = parseSubtitles(vm["subtitles"])
				}
				versions = append(versions, EpisodeVersion{
					Quality:   fmt.Sprint(vm["quality"]),
					Language:  fmt.Sprint(vm["lang"]),
					VideoURL:  videoURL,
					Subtitles: subs,
					HardSub:   vm["hardSub"] == true,
				})
			}
		}
		sort.Slice(versions, func(i, j int) bool {
			return qualityScore(versions[i].Quality) > qualityScore(versions[j].Quality)
		})
		episodes = append(episodes, Episode{
			Number:   num,
			Title:    fmt.Sprint(epMap["title"]),
			Duration: atoi(fmt.Sprint(epMap["duration"])),
			Versions: versions,
		})
	}
	sort.Slice(episodes, func(i, j int) bool { return episodes[i].Number < episodes[j].Number })
	if len(episodes) == 0 {
		return Series{}, ShortFlixError{"该页面没有返回可下载的剧集。"}
	}
	title := fmt.Sprint(rawSeries["title"])
	if title == "" {
		title = fmt.Sprint(rawSeries["slug"])
	}
	cover := strings.TrimSpace(fmt.Sprint(rawSeries["thumbnailUrl"]))
	if cover == "" {
		cover = strings.TrimSpace(fmt.Sprint(rawSeries["coverUrl"]))
	}
	return Series{
		Title:     title,
		Slug:      fmt.Sprint(rawSeries["slug"]),
		Cover:     cover,
		SourceURL: sourceURL,
		Episodes:  episodes,
	}, nil
}

// DiscoverCatalogPage 调用 ShortFlix /api/search 分页拉取剧目（封面 + 标题）。
// cursor 空表示首页；q 为搜索词（可空）。
func DiscoverCatalogPage(cookie, cursor, query string, limit int) (CatalogPage, error) {
	if limit <= 0 || limit > 50 {
		limit = 48
	}
	u, _ := url.Parse("https://www.shortflix.net/api/search")
	q := u.Query()
	q.Set("limit", strconv.Itoa(limit))
	q.Set("language", "zh_TW")
	q.Set("lang", "zh_TW")
	if strings.TrimSpace(query) != "" {
		q.Set("q", strings.TrimSpace(query))
	}
	if strings.TrimSpace(cursor) != "" {
		q.Set("cursor", strings.TrimSpace(cursor))
	}
	u.RawQuery = q.Encode()

	raw, err := fetchJSON(u.String(), cookie, 45*time.Second)
	if err != nil {
		// API 失败时退回刮首页（仅首页一批）
		if strings.TrimSpace(cursor) == "" && strings.TrimSpace(query) == "" {
			if items := scrapeCatalogFallback(cookie); len(items) > 0 {
				return CatalogPage{Items: items, HasMore: false}, nil
			}
		}
		return CatalogPage{}, err
	}
	page, err := parseCatalogSearchJSON(raw)
	if err != nil {
		// 限流 / WAF / HTML 时常见；首页再试刮取
		if strings.TrimSpace(cursor) == "" && strings.TrimSpace(query) == "" {
			if items := scrapeCatalogFallback(cookie); len(items) > 0 {
				return CatalogPage{Items: items, HasMore: false}, nil
			}
		}
		snip := strings.TrimSpace(raw)
		if len(snip) > 160 {
			snip = snip[:160] + "…"
		}
		return CatalogPage{}, ShortFlixError{fmt.Sprintf("ShortFlix 剧目列表返回格式异常：%v（%s）", err, snip)}
	}
	return page, nil
}

// parseCatalogSearchJSON 宽松解析 /api/search，兼容字段类型抖动与 data 包裹。
func parseCatalogSearchJSON(raw string) (CatalogPage, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return CatalogPage{}, fmt.Errorf("空响应")
	}
	// 偶发 JSON hijacking 前缀
	if strings.HasPrefix(raw, ")]}'") {
		if i := strings.Index(raw, "{"); i >= 0 {
			raw = raw[i:]
		}
	}
	if raw[0] != '{' && raw[0] != '[' {
		return CatalogPage{}, fmt.Errorf("非 JSON")
	}
	var root any
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		return CatalogPage{}, err
	}
	obj, ok := root.(map[string]any)
	if !ok {
		return CatalogPage{}, fmt.Errorf("顶层不是对象")
	}
	if data, ok := obj["data"].(map[string]any); ok {
		obj = data
	}
	rawItems, _ := obj["items"].([]any)
	if rawItems == nil {
		// 有的网关改名 results
		rawItems, _ = obj["results"].([]any)
	}
	items := make([]CatalogItem, 0, len(rawItems))
	seen := map[string]struct{}{}
	for _, row := range rawItems {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		slug := strings.TrimSpace(anyString(m["slug"]))
		title := strings.TrimSpace(anyString(m["title"]))
		cover := strings.TrimSpace(anyString(m["thumbnailUrl"]))
		if cover == "" {
			cover = strings.TrimSpace(anyString(m["cover"]))
		}
		if slug == "" || title == "" || cover == "" {
			continue
		}
		if _, dup := seen[slug]; dup {
			continue
		}
		seen[slug] = struct{}{}
		items = append(items, CatalogItem{
			ID:          strings.TrimSpace(anyString(m["id"])),
			Title:       title,
			Slug:        slug,
			Cover:       cover,
			Description: strings.TrimSpace(anyString(m["description"])),
			ViewCount:   anyInt(m["viewCount"]),
			SourceURL:   fmt.Sprintf("https://www.shortflix.net/videos/%s/episode-1", slug),
		})
	}
	next := strings.TrimSpace(anyString(obj["nextCursor"]))
	if next == "" {
		next = strings.TrimSpace(anyString(obj["next_cursor"]))
	}
	hasMore := anyBool(obj["hasMore"]) || anyBool(obj["has_more"])
	return CatalogPage{
		Items:      items,
		NextCursor: next,
		HasMore:    hasMore && next != "",
	}, nil
}

func anyInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(t))
		return n
	case int:
		return t
	case int64:
		return int(t)
	default:
		return 0
	}
}

func anyBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "1" || s == "true" || s == "yes"
	case float64:
		return t != 0
	default:
		return false
	}
}

// DiscoverCatalog 兼容旧调用：拉第一页。
func DiscoverCatalog(cookie string) ([]CatalogItem, error) {
	page, err := DiscoverCatalogPage(cookie, "", "", 48)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func scrapeCatalogFallback(cookie string) []CatalogItem {
	bySlug := map[string]CatalogItem{}
	for _, page := range []string{
		"https://www.shortflix.net/zh/home",
		"https://www.shortflix.net/zh/library",
		"https://www.shortflix.net/explore",
	} {
		html, err := fetchText(page, cookie, 45*time.Second)
		if err != nil {
			continue
		}
		for _, item := range parseCatalogHTML(html) {
			bySlug[item.Slug] = item
		}
	}
	out := make([]CatalogItem, 0, len(bySlug))
	for _, item := range bySlug {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ViewCount != out[j].ViewCount {
			return out[i].ViewCount > out[j].ViewCount
		}
		return out[i].Title < out[j].Title
	})
	return out
}

func fetchJSON(urlStr, cookie string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	req, _ := http.NewRequest(http.MethodGet, urlStr, nil)
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.8")
	req.Header.Set("Referer", "https://www.shortflix.net/zh/library")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", ShortFlixError{fmt.Sprintf("无法连接 ShortFlix：%v", err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 400 {
		return "", ShortFlixError{fmt.Sprintf("短剧库接口返回 HTTP %d", resp.StatusCode)}
	}
	return string(body), nil
}

func parseCatalogHTML(pageHTML string) []CatalogItem {
	payload, err := decodeNextPayload(pageHTML)
	if err != nil {
		return nil
	}
	var items []CatalogItem
	seen := map[string]struct{}{}
	marker := `"thumbnailUrl"`
	cursor := 0
	for {
		idx := strings.Index(payload[cursor:], marker)
		if idx < 0 {
			break
		}
		abs := cursor + idx
		start := findObjectStart(payload, abs)
		cursor = abs + len(marker)
		if start < 0 {
			continue
		}
		decoder := json.NewDecoder(strings.NewReader(payload[start:]))
		var obj map[string]any
		if err := decoder.Decode(&obj); err != nil {
			continue
		}
		slug := anyString(obj["slug"])
		title := anyString(obj["title"])
		cover := anyString(obj["thumbnailUrl"])
		if slug == "" || title == "" || cover == "" {
			continue
		}
		if _, dup := seen[slug]; dup {
			continue
		}
		seen[slug] = struct{}{}
		items = append(items, CatalogItem{
			ID:          anyString(obj["id"]),
			Title:       title,
			Slug:        slug,
			Cover:       cover,
			Description: anyString(obj["description"]),
			ViewCount:   atoi(anyString(obj["viewCount"])),
			SourceURL:   fmt.Sprintf("https://www.shortflix.net/videos/%s/episode-1", slug),
		})
	}
	return items
}

func findObjectStart(s string, from int) int {
	depth := 0
	for i := from; i >= 0; i-- {
		switch s[i] {
		case '}':
			depth++
		case '{':
			if depth == 0 {
				return i
			}
			depth--
		}
	}
	return -1
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func anyString(v any) string {
	if v == nil {
		return ""
	}
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "" || s == "<nil>" {
		return ""
	}
	return s
}

// DiscoverSeries loads full series metadata (may fetch per-episode pages).
func DiscoverSeries(rawURL, cookie string) (Series, error) {
	sourceURL, err := canonicalEpisodeURL(rawURL)
	if err != nil {
		return Series{}, err
	}
	html, err := fetchText(sourceURL, cookie, 30*time.Second)
	if err != nil {
		return Series{}, err
	}
	initial, err := ParseSeriesHTML(html, sourceURL)
	if err != nil {
		return Series{}, err
	}
	merged := map[int]Episode{}
	for _, ep := range initial.Episodes {
		merged[ep.Number] = ep
	}
	var missing []int
	for _, ep := range initial.Episodes {
		if len(ep.Versions) == 0 {
			missing = append(missing, ep.Number)
		}
	}
	if len(missing) > 0 && cookie == "" {
		avail := len(initial.Episodes) - len(missing)
		return Series{}, AuthenticationRequired{
			Msg: fmt.Sprintf("网站只向未登录访问返回 %d 集，另有 %d 集需要登录。", avail, len(missing)),
		}
	}
	if len(missing) > 0 {
		var wg sync.WaitGroup
		var mu sync.Mutex
		for _, number := range missing {
			wg.Add(1)
			go func(n int) {
				defer wg.Done()
				pageURL := fmt.Sprintf("https://www.shortflix.net/videos/%s/episode-%d", initial.Slug, n)
				text, err := fetchText(pageURL, cookie, 30*time.Second)
				if err != nil {
					return
				}
				series, err := ParseSeriesHTML(text, pageURL)
				if err != nil {
					return
				}
				mu.Lock()
				defer mu.Unlock()
				for _, ep := range series.Episodes {
					cur, ok := merged[ep.Number]
					if len(ep.Versions) > 0 && (!ok || len(cur.Versions) == 0) {
						merged[ep.Number] = ep
					}
				}
			}(number)
		}
		wg.Wait()
	}
	var available []Episode
	for num := range merged {
		ep := merged[num]
		if len(ep.Versions) > 0 {
			available = append(available, ep)
		}
	}
	sort.Slice(available, func(i, j int) bool { return available[i].Number < available[j].Number })
	if len(available) == 0 {
		return Series{}, ShortFlixError{"该剧没有返回任何可下载的视频版本。"}
	}
	var unresolved []int
	for num, ep := range merged {
		if len(ep.Versions) == 0 {
			unresolved = append(unresolved, num)
		}
	}
	if len(unresolved) > 0 {
		sort.Ints(unresolved)
		preview := unresolved
		if len(preview) > 12 {
			preview = preview[:12]
		}
		return Series{}, ShortFlixError{
			Msg: fmt.Sprintf("登录会话没有解锁全部剧集，仍缺少 %d 集。", len(unresolved)),
		}
	}
	return Series{
		Title:     initial.Title,
		Slug:      initial.Slug,
		Cover:     initial.Cover,
		SourceURL: sourceURL,
		Episodes:  available,
	}, nil
}

// DownloadTextFile saves a remote subtitle/text file.
func DownloadTextFile(urlStr, dest, cookie string) error {
	req, _ := http.NewRequest(http.MethodGet, urlStr, nil)
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Referer", "https://www.shortflix.net/")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		preview := strings.TrimSpace(string(data))
		if len(preview) > 120 {
			preview = preview[:120] + "…"
		}
		if preview == "" {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, preview)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".part"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}