// Copyright (c) 2026 lingbyte. All rights reserved.

package shortflix

// Subtitle track metadata.
type Subtitle struct {
	Title  string `json:"title"`
	Format string `json:"format"`
	URL    string `json:"url"`
}

// EpisodeVersion is one renditions of an episode.
type EpisodeVersion struct {
	Quality    string     `json:"quality"`
	Language   string     `json:"language"`
	VideoURL   string     `json:"video_url"`
	Subtitles  []Subtitle `json:"subtitles"`
	HardSub    bool       `json:"hard_sub"`
}

// Episode is one episode in a series.
type Episode struct {
	Number   int              `json:"number"`
	Title    string           `json:"title"`
	Duration int              `json:"duration"`
	Versions []EpisodeVersion `json:"versions"`
}

// Series is discovered ShortFlix drama metadata.
type Series struct {
	Title     string    `json:"title"`
	Slug      string    `json:"slug"`
	Cover     string    `json:"cover,omitempty"`
	SourceURL string    `json:"source_url"`
	Episodes  []Episode `json:"episodes"`
}

// 字幕轨状态（目录卡 / 识别接口共用）
const (
	SubStatusUnknown  = "unknown"   // 尚未探测
	SubStatusSoftEN   = "soft_en"   // 有可下载英文字幕轨
	SubStatusHardOnly = "hard_only" // 无英文字幕轨（硬字幕 / 需 ASR）
)

// CatalogItem is a ShortFlix library card (cover + title + link).
type CatalogItem struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Slug           string `json:"slug"`
	Cover          string `json:"cover"`
	Description    string `json:"description,omitempty"`
	ViewCount      int    `json:"view_count,omitempty"`
	SourceURL      string `json:"source_url"`
	Loaded         bool   `json:"loaded"`                    // 是否已在本系统载入（工作目录或剧本库）
	SubtitleStatus string `json:"subtitle_status,omitempty"` // unknown | soft_en | hard_only
}

// CatalogPage is one page from ShortFlix /api/search.
type CatalogPage struct {
	Items      []CatalogItem `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
	HasMore    bool          `json:"has_more"`
}