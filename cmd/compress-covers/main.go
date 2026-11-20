// 压缩线上剧本封面并覆盖上传到七牛，同时更新 DB cover key 为 .jpg。
//
//	go run ./cmd/compress-covers
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/configs"
	"github.com/LingByte/miniseadrama/internal/models"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"
)

func main() {
	_ = configs.LoadEnvFile(".env")
	cfg, err := configs.Load("configs/config.yaml")
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		os.Exit(1)
	}
	displayTTL, _ := time.ParseDuration(cfg.Storage.DisplayURLTTL)
	downloadTTL, _ := time.ParseDuration(cfg.Storage.DownloadURLTTL)
	signSecret := []byte(strings.TrimSpace(cfg.Storage.SignSecret))
	if len(signSecret) == 0 {
		signSecret = []byte(cfg.JWT.Secret)
	}
	if err := pkgstorage.Init(
		cfg.Storage.Driver, cfg.Storage.Root, cfg.Storage.Region,
		cfg.Storage.Endpoint, cfg.Storage.AccessKey, cfg.Storage.SecretKey,
		cfg.Storage.PublicURLBase, cfg.Storage.MaxFileSize,
		pkgstorage.InitOptions{
			SignSecret: signSecret, DisplayTTL: displayTTL, DownloadTTL: downloadTTL, Private: cfg.Storage.Private,
		},
	); err != nil {
		fmt.Fprintf(os.Stderr, "storage: %v\n", err)
		os.Exit(1)
	}

	db, err := configs.InitDB(cfg.Database)
	if err != nil {
		fmt.Fprintf(os.Stderr, "db: %v\n", err)
		os.Exit(1)
	}
	var rows []models.AdminScript
	if err := db.Find(&rows).Error; err != nil {
		fmt.Fprintf(os.Stderr, "list: %v\n", err)
		os.Exit(1)
	}

	okN, failN := 0, 0
	for i := range rows {
		script := rows[i].ToScript()
		title := strings.TrimSpace(fmt.Sprint(script["title"]))
		cover := strings.TrimSpace(fmt.Sprint(script["cover"]))
		cover = normalizeKey(cover)
		if cover == "" || !pkgstorage.IsStorageKey(cover) {
			fmt.Printf("skip 《%s》 cover=%q\n", title, cover)
			continue
		}

		// 优先用本地大图 png 源重压（避免对已压缩 jpg 再压）
		raw, srcPath, err := readCoverSource(cover)
		if err != nil {
			fmt.Printf("FAIL 《%s》 read %s: %v\n", title, cover, err)
			failN++
			continue
		}
		before := len(raw)
		compressed, err := pkgstorage.CompressCover(raw)
		if err != nil {
			fmt.Printf("FAIL 《%s》 compress: %v\n", title, err)
			failN++
			continue
		}
		newKey := pkgstorage.CoverObjectKey(cover)
		_ = pkgstorage.Delete(newKey) // 允许覆盖同名 jpg
		if err := pkgstorage.PutBytes(newKey, compressed); err != nil {
			fmt.Printf("FAIL 《%s》 upload %s: %v\n", title, newKey, err)
			failN++
			continue
		}
		// 本地同步一份便于开发
		localPath := filepath.Join("uploads", filepath.FromSlash(newKey))
		_ = os.MkdirAll(filepath.Dir(localPath), 0o755)
		_ = os.WriteFile(localPath, compressed, 0o644)

		script["cover"] = newKey
		payload, _ := json.Marshal(script)
		if err := db.Model(&models.AdminScript{}).Where("script_id = ?", rows[i].ScriptID).
			Update("payload", string(payload)).Error; err != nil {
			fmt.Printf("FAIL 《%s》 db: %v\n", title, err)
			failN++
			continue
		}
		if cover != newKey {
			_ = pkgstorage.Delete(cover) // 删旧 png
		}
		_ = srcPath
		ratio := 100.0
		if before > 0 {
			ratio = float64(len(compressed)) * 100 / float64(before)
		}
		fmt.Printf("OK  《%s》 %s → %s  %dKB → %dKB (%.0f%%)\n",
			title, cover, newKey, before/1024, len(compressed)/1024, ratio)
		okN++
	}
	fmt.Printf("done ok=%d fail=%d\n", okN, failN)
}

func normalizeKey(cover string) string {
	cover = strings.TrimSpace(cover)
	if strings.Contains(cover, "key=") {
		if i := strings.Index(cover, "key="); i >= 0 {
			rest := cover[i+4:]
			if j := strings.IndexAny(rest, "&"); j >= 0 {
				rest = rest[:j]
			}
			rest = strings.ReplaceAll(rest, "%2F", "/")
			rest = strings.ReplaceAll(rest, "%2f", "/")
			return strings.TrimPrefix(rest, "/")
		}
	}
	if strings.HasPrefix(cover, "https://soul.lingecho.com/") {
		p := strings.TrimPrefix(cover, "https://soul.lingecho.com/")
		if q := strings.Index(p, "?"); q >= 0 {
			p = p[:q]
		}
		return p
	}
	return strings.TrimPrefix(cover, "/")
}

func readCoverSource(key string) ([]byte, string, error) {
	base := strings.TrimSuffix(key, filepath.Ext(key))
	candidates := []string{
		filepath.Join("uploads", filepath.FromSlash(base+".png")),
		filepath.Join("uploads", filepath.FromSlash(key)),
		filepath.Join("uploads", filepath.FromSlash(base+".jpg")),
		filepath.Join("uploads", filepath.FromSlash(base+".jpeg")),
		filepath.Join("uploads", filepath.FromSlash(base+".webp")),
	}
	var best []byte
	var bestPath string
	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if err != nil || len(data) == 0 {
			continue
		}
		// 选最大的本地文件当源（通常是未压缩 png）
		if len(data) > len(best) {
			best = data
			bestPath = p
		}
	}
	if len(best) > 0 {
		return best, bestPath, nil
	}
	r, _, err := pkgstorage.Read(key)
	if err != nil {
		// 再试 png key
		pngKey := base + ".png"
		r, _, err = pkgstorage.Read(pngKey)
		if err != nil {
			return nil, "", err
		}
		key = pngKey
	}
	defer r.Close()
	buf, err := io.ReadAll(io.LimitReader(r, 30<<20))
	if err != nil {
		return nil, "", err
	}
	if len(buf) == 0 {
		return nil, "", fmt.Errorf("empty object")
	}
	return buf, key, nil
}
