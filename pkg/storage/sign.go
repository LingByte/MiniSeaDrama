// Copyright (c) 2026 lingbyte. All rights reserved.

package storage

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/pkg/common/stores"
)

// SignSecret HMAC-signs local/media URLs when the backend has no native presign.
var SignSecret []byte

// DisplayURLTTL is used when expanding cover keys for list/detail pages.
var DisplayURLTTL = 24 * time.Hour

// DownloadURLTTL is used when issuing one-shot script download links.
var DownloadURLTTL = 15 * time.Minute

// MediaPath is the HTTP path that serves HMAC-signed local objects.
const MediaPath = "/api/v1/media"

// SetSigning configures HMAC secret and URL TTLs (call from Init).
func SetSigning(secret []byte, displayTTL, downloadTTL time.Duration) {
	SignSecret = secret
	if displayTTL > 0 {
		DisplayURLTTL = displayTTL
	}
	if downloadTTL > 0 {
		DownloadURLTTL = downloadTTL
	}
}

// SignedURL returns an expiring access URL for key.
// Cloud backends use native presign; local falls back to HMAC media URLs.
func SignedURL(key string, expires time.Duration) (string, error) {
	key = strings.TrimPrefix(strings.TrimSpace(key), "/")
	if key == "" || Store == nil {
		return "", fmt.Errorf("storage key empty or not initialized")
	}
	if expires <= 0 {
		expires = DisplayURLTTL
	}
	if signer, ok := Store.(stores.PrivateURLSigner); ok {
		return signer.SignedURL(key, expires)
	}
	return localSignedMediaURL(key, expires)
}

// localSignedMediaURL builds /api/v1/media?key=&exp=&sig= for the local backend.
func localSignedMediaURL(key string, expires time.Duration) (string, error) {
	if len(SignSecret) == 0 {
		// Dev fallback: still return a media URL, but unsigned verification will reject.
		return "", fmt.Errorf("storage sign secret not configured")
	}
	exp := time.Now().Add(expires).Unix()
	sig := SignMedia(key, exp)
	q := url.Values{}
	q.Set("key", key)
	q.Set("exp", strconv.FormatInt(exp, 10))
	q.Set("sig", sig)
	return MediaPath + "?" + q.Encode(), nil
}

// SignMedia creates an HMAC signature for key + exp.
func SignMedia(key string, exp int64) string {
	mac := hmac.New(sha256.New, SignSecret)
	_, _ = mac.Write([]byte(fmt.Sprintf("%s\n%d", key, exp)))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyMedia checks exp/sig for a media request.
func VerifyMedia(key string, exp int64, sig string) bool {
	key = strings.TrimPrefix(strings.TrimSpace(key), "/")
	if key == "" || exp <= 0 || sig == "" || len(SignSecret) == 0 {
		return false
	}
	if time.Now().Unix() > exp {
		return false
	}
	want := SignMedia(key, exp)
	return hmac.Equal([]byte(want), []byte(strings.ToLower(sig))) || hmac.Equal([]byte(want), []byte(sig))
}

// IsStorageKey reports whether v looks like an object key (not URL / data URL).
func IsStorageKey(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	if strings.HasPrefix(v, "data:") {
		return false
	}
	if strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://") {
		return false
	}
	if strings.HasPrefix(v, "/") && strings.Contains(v, "?") {
		return false // already a media URL
	}
	if strings.HasPrefix(v, MediaPath) {
		return false
	}
	return true
}

// isOurObjectHost reports whether host is our CDN / public object base
// (e.g. soul.lingecho.com). Signed query strings on these hosts must not be persisted.
func isOurObjectHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	if host == "soul.lingecho.com" {
		return true
	}
	if PublicURLBase == "" {
		return false
	}
	if pu, err := url.Parse(PublicURLBase); err == nil && pu.Host != "" {
		return strings.EqualFold(pu.Host, host)
	}
	return false
}

// CanonicalCoverKey turns a signed CDN / media URL into a durable object key.
// Returns empty when the value is an external URL or cannot be parsed.
func CanonicalCoverKey(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "data:") {
		return ""
	}
	// Local HMAC media URL: /api/v1/media?key=covers/... (relative or absolute)
	if strings.Contains(raw, "key=") && strings.Contains(raw, MediaPath) {
		toParse := raw
		if strings.HasPrefix(raw, "/") {
			toParse = "http://local.invalid" + raw
		}
		if parsed, err := url.Parse(toParse); err == nil {
			key := strings.TrimSpace(parsed.Query().Get("key"))
			if unesc, err := url.QueryUnescape(key); err == nil {
				key = unesc
			}
			key = strings.TrimPrefix(key, "/")
			if key != "" {
				return key
			}
		}
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			return ""
		}
		if !isOurObjectHost(parsed.Hostname()) {
			return ""
		}
		path := strings.TrimPrefix(parsed.EscapedPath(), "/")
		path, _ = url.PathUnescape(path)
		path = strings.TrimPrefix(path, "/")
		return path
	}
	if IsStorageKey(raw) {
		return strings.TrimPrefix(raw, "/")
	}
	return ""
}

// ResolveAccessURL expands a stored cover value into a browser-usable URL.
// data: is rejected; our CDN/media URLs (even with expired ?e=&token=) are
// re-signed from the object key; foreign http(s) kept; bare keys get SignedURL.
func ResolveAccessURL(stored string, ttl time.Duration) string {
	stored = strings.TrimSpace(stored)
	if stored == "" || strings.HasPrefix(stored, "data:") {
		return ""
	}
	if key := CanonicalCoverKey(stored); key != "" {
		u, err := SignedURL(key, ttl)
		if err == nil {
			return u
		}
		// Fall through for foreign https that CanonicalCoverKey skipped,
		// or when signing fails on a bare key.
		if IsStorageKey(stored) || strings.HasPrefix(stored, MediaPath) {
			return ""
		}
		if strings.HasPrefix(stored, "http://") || strings.HasPrefix(stored, "https://") {
			// Our host but signing failed — still don't return the expired token URL.
			if parsed, err := url.Parse(stored); err == nil && isOurObjectHost(parsed.Hostname()) {
				return ""
			}
			return stored
		}
		return ""
	}
	if strings.HasPrefix(stored, "http://") || strings.HasPrefix(stored, "https://") {
		return stored
	}
	if strings.HasPrefix(stored, MediaPath) {
		return stored
	}
	return ""
}
