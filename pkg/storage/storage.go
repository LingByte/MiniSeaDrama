// Copyright (c) 2026 lingbyte. All rights reserved.

// Package storage wraps ling-base/stores object storage as a package-level singleton.
//
// Usage:
//
//	pkgstorage.Init(...)
//	pkgstorage.Write("covers/id/a.png", reader)
//	url := pkgstorage.SignedURL("covers/id/a.png", ttl)
//
// Drivers: local（开发）| qiniu/kodo（生产七牛）
package storage

import (
	"bytes"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/pkg/common/stores"
	"github.com/LingByte/miniseadrama/pkg/common/stores/kodo"
	"github.com/LingByte/miniseadrama/pkg/common/stores/local"
)

// Package-level singleton.
var (
	Store         stores.Store
	MaxFileSize   int64
	PublicURLBase string
	DriverName    string
)

// InitOptions carries optional signing / TTL settings.
type InitOptions struct {
	SignSecret  []byte
	DisplayTTL  time.Duration
	DownloadTTL time.Duration
	Private     bool // qiniu private bucket
}

// Init initializes the object storage singleton from configuration.
func Init(driver, root, region, endpoint, accessKey, secretKey, publicURLBase string, maxFileSize int64, opts ...InitOptions) error {
	_ = endpoint
	private := false
	if len(opts) > 0 {
		private = opts[0].Private
	}
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "local", "":
		DriverName = "local"
		Store = local.New(local.Config{
			Root:       root,
			NewDirPerm: 0755,
		})
	case "qiniu", "kodo":
		DriverName = "qiniu"
		if strings.TrimSpace(root) == "" || strings.TrimSpace(accessKey) == "" || strings.TrimSpace(secretKey) == "" {
			return fmt.Errorf("qiniu 需要配置 bucket(APP_STORAGE_ROOT/QINIU_BUCKET)、AccessKey、SecretKey")
		}
		domain := strings.TrimSpace(publicURLBase)
		if domain == "" {
			return fmt.Errorf("qiniu 需要配置域名 APP_STORAGE_PUBLIC_URL_BASE / QINIU_DOMAIN")
		}
		Store = kodo.New(kodo.Config{
			AccessKey:  accessKey,
			SecretKey:  secretKey,
			BucketName: root,
			Domain:     domain,
			Private:    private,
			Region:     region,
		})
	default:
		return fmt.Errorf("unsupported storage driver: %s (supported: local, qiniu)", driver)
	}

	MaxFileSize = maxFileSize
	PublicURLBase = publicURLBase
	if len(opts) > 0 {
		o := opts[0]
		secret := o.SignSecret
		if len(secret) == 0 && secretKey != "" {
			secret = []byte(secretKey)
		}
		SetSigning(secret, o.DisplayTTL, o.DownloadTTL)
	}
	return nil
}

func Write(key string, r io.Reader) error {
	if Store == nil {
		return fmt.Errorf("storage not initialized, call Init() first")
	}
	return Store.Write(key, r)
}

func Read(key string) (io.ReadCloser, int64, error) {
	if Store == nil {
		return nil, 0, fmt.Errorf("storage not initialized, call Init() first")
	}
	return Store.Read(key)
}

func Delete(key string) error {
	if Store == nil {
		return fmt.Errorf("storage not initialized, call Init() first")
	}
	return Store.Delete(key)
}

func Exists(key string) (bool, error) {
	if Store == nil {
		return false, fmt.Errorf("storage not initialized, call Init() first")
	}
	return Store.Exists(key)
}

func PublicURL(key string) string {
	if Store == nil {
		return ""
	}
	// 七牛私有桶走 SignedURL/PublicURL（带签）；不要再拼 PublicURLBase 覆盖签名
	if DriverName == "qiniu" {
		return Store.PublicURL(key)
	}
	if PublicURLBase != "" {
		return strings.TrimRight(PublicURLBase, "/") + "/" + strings.TrimLeft(key, "/")
	}
	return Store.PublicURL(key)
}

func CheckFileSize(size int64) error {
	if MaxFileSize > 0 && size > MaxFileSize {
		return fmt.Errorf("file size %d exceeds limit %d", size, MaxFileSize)
	}
	return nil
}

func PutBytes(key string, data []byte) error {
	return Write(key, bytes.NewReader(data))
}

func ObjectKey(parts ...string) string {
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.Trim(strings.ReplaceAll(p, "..", ""), "/")
		if p != "" {
			clean = append(clean, p)
		}
	}
	return path.Join(clean...)
}

func Close() error {
	return nil
}
