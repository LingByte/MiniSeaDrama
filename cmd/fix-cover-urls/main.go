// 把 admin_scripts / orders 里带 ?e=&token= 的封面 URL 规范成对象 key。
//
//	go run ./cmd/fix-cover-urls           # dry-run
//	go run ./cmd/fix-cover-urls --fix    # 写库
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/LingByte/miniseadrama/internal/configs"
	"github.com/LingByte/miniseadrama/internal/models"
	pkgstorage "github.com/LingByte/miniseadrama/pkg/storage"
)

func main() {
	fix := false
	for _, a := range os.Args[1:] {
		if a == "--fix" {
			fix = true
		}
	}

	_ = configs.LoadEnvFile(".env")
	cfg, err := configs.Load("configs/config.yaml")
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		os.Exit(1)
	}
	// 只需要 PublicURLBase 来识别本站 CDN；不必初始化完整 Store
	pkgstorage.PublicURLBase = strings.TrimSpace(cfg.Storage.PublicURLBase)
	if pkgstorage.PublicURLBase == "" {
		pkgstorage.PublicURLBase = "https://soul.lingecho.com"
	}

	db, err := configs.InitDB(cfg.Database)
	if err != nil {
		fmt.Fprintf(os.Stderr, "db: %v\n", err)
		os.Exit(1)
	}

	var rows []models.AdminScript
	if err := db.Find(&rows).Error; err != nil {
		fmt.Fprintf(os.Stderr, "list scripts: %v\n", err)
		os.Exit(1)
	}

	scriptN := 0
	for i := range rows {
		script := rows[i].ToScript()
		cover := strings.TrimSpace(fmt.Sprint(script["cover"]))
		if cover == "" || cover == "<nil>" {
			continue
		}
		key := pkgstorage.CanonicalCoverKey(cover)
		if key == "" || key == cover {
			continue
		}
		// 仅改写签名/绝对 CDN URL → key（外链 CanonicalCoverKey 为空）
		if !(strings.HasPrefix(cover, "http://") || strings.HasPrefix(cover, "https://") || strings.Contains(cover, pkgstorage.MediaPath)) {
			continue
		}
		title := strings.TrimSpace(fmt.Sprint(script["title"]))
		fmt.Printf("script %s 《%s》\n  %s\n  → %s\n", rows[i].ScriptID, title, trim(cover, 120), key)
		if !fix {
			continue
		}
		script["cover"] = key
		payload, _ := json.Marshal(script)
		if err := db.Model(&models.AdminScript{}).Where("script_id = ?", rows[i].ScriptID).
			Update("payload", string(payload)).Error; err != nil {
			fmt.Printf("  FAIL db: %v\n", err)
			continue
		}
		scriptN++
	}

	var orders []models.Order
	if err := db.Select("id", "cover").Find(&orders).Error; err != nil {
		fmt.Fprintf(os.Stderr, "list orders: %v\n", err)
		os.Exit(1)
	}
	orderN := 0
	for _, o := range orders {
		cover := strings.TrimSpace(o.Cover)
		if cover == "" {
			continue
		}
		key := pkgstorage.CanonicalCoverKey(cover)
		if key == "" || key == cover {
			continue
		}
		if !(strings.HasPrefix(cover, "http://") || strings.HasPrefix(cover, "https://") || strings.Contains(cover, pkgstorage.MediaPath)) {
			continue
		}
		fmt.Printf("order %s\n  %s\n  → %s\n", o.ID, trim(cover, 120), key)
		if !fix {
			continue
		}
		if err := db.Model(&models.Order{}).Where("id = ?", o.ID).Update("cover", key).Error; err != nil {
			fmt.Printf("  FAIL db: %v\n", err)
			continue
		}
		orderN++
	}

	if fix {
		fmt.Printf("done updated scripts=%d orders=%d\n", scriptN, orderN)
	} else {
		fmt.Println("(dry-run) re-run with --fix to write")
	}
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
