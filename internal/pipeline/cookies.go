// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"encoding/json"
	"regexp"
	"strings"
)

var cookieNameRE = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+\-.^_` + "`" + `|~]+$`)

const shortflixDomainSuffix = ".shortflix.net"

func validCookiePair(name, value string) bool {
	return name != "" && value != "" &&
		cookieNameRE.MatchString(name) &&
		!strings.ContainsAny(value, "\r\n;")
}

// ParseCookieHeader accepts a raw Cookie header, Netscape cookies.txt, or extension JSON.
func ParseCookieHeader(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if strings.HasPrefix(text, "[") || strings.HasPrefix(text, "{") {
		if parsed := cookieFromJSON(text); parsed != "" {
			return parsed
		}
	}
	if strings.Contains(text, "\t") {
		if parsed := cookieFromNetscape(text); parsed != "" {
			return parsed
		}
	}
	if strings.HasPrefix(strings.ToLower(text), "cookie:") {
		text = strings.TrimSpace(text[strings.Index(text, ":")+1:])
	}
	var pairs []string
	for _, chunk := range strings.Split(text, ";") {
		name, value, _ := strings.Cut(strings.TrimSpace(chunk), "=")
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if validCookiePair(name, value) {
			pairs = append(pairs, name+"="+value)
		}
	}
	return strings.Join(pairs, "; ")
}

func cookieFromJSON(text string) string {
	var payload any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return ""
	}
	var items []any
	switch v := payload.(type) {
	case []any:
		items = v
	case map[string]any:
		if c, ok := v["cookies"].([]any); ok {
			items = c
		}
	default:
		return ""
	}
	var pairs []string
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		domain := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(asString(m["domain"])), "."))
		if domain != "" && domain != "shortflix.net" && !strings.HasSuffix(domain, shortflixDomainSuffix) {
			continue
		}
		name := asString(m["name"])
		value := asString(m["value"])
		if validCookiePair(name, value) {
			pairs = append(pairs, name+"="+value)
		}
	}
	return strings.Join(pairs, "; ")
}

func cookieFromNetscape(text string) string {
	var pairs []string
	matched := false
	for _, line := range strings.Split(text, "\n") {
		stripped := strings.TrimSpace(line)
		if stripped == "" || strings.HasPrefix(stripped, "#") {
			continue
		}
		fields := strings.Split(stripped, "\t")
		if len(fields) < 7 {
			continue
		}
		domain := strings.ToLower(strings.TrimPrefix(fields[0], "."))
		if domain != "shortflix.net" && !strings.HasSuffix(domain, shortflixDomainSuffix) {
			continue
		}
		matched = true
		name, value := fields[5], fields[6]
		if validCookiePair(name, value) {
			pairs = append(pairs, name+"="+value)
		}
	}
	if matched {
		return strings.Join(pairs, "; ")
	}
	return ""
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	default:
		return ""
	}
}