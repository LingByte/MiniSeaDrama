// 删除分集过少的脏剧本（默认 ≤5 集）及其订单。
//
//	go run ./cmd/purge-short-scripts
//	go run ./cmd/purge-short-scripts -max=5 -dry-run
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/LingByte/miniseadrama/internal/configs"
	"github.com/LingByte/miniseadrama/internal/models"
)

func main() {
	maxEps := flag.Int("max", 5, "删除 episodes 数量 ≤ max 的剧本")
	dry := flag.Bool("dry-run", false, "只打印不删除")
	flag.Parse()

	_ = configs.LoadEnvFile(".env")
	cfg, err := configs.Load("configs/config.yaml")
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
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

	deleted := 0
	for i := range rows {
		script := rows[i].ToScript()
		raw, _ := script["episodes"]
		n := 0
		switch eps := raw.(type) {
		case []any:
			n = len(eps)
		case []map[string]any:
			n = len(eps)
		}
		if n > *maxEps {
			continue
		}
		title, _ := script["title"].(string)
		fmt.Printf("DEL %s  eps=%d  %s\n", rows[i].ScriptID, n, title)
		if *dry {
			deleted++
			continue
		}
		_ = db.Where("script_id = ?", rows[i].ScriptID).Delete(&models.Order{}).Error
		if err := db.Delete(&rows[i]).Error; err != nil {
			fmt.Fprintf(os.Stderr, "delete %s: %v\n", rows[i].ScriptID, err)
			continue
		}
		deleted++
	}

	var left int64
	_ = db.Model(&models.AdminScript{}).Count(&left)
	fmt.Printf("done deleted=%d remaining=%d dry=%v max=%d\n", deleted, left, *dry, *maxEps)
}
