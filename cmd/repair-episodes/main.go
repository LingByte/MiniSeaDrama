// 修复「整剧糊成 1 集」的脏数据：按 Episode N / 第 N 集 拆分并写回 DB。
//
//	go run ./cmd/repair-episodes
//	go run ./cmd/repair-episodes -dry-run
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/LingByte/miniseadrama/internal/configs"
	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/internal/scriptdata"
)

func main() {
	dry := flag.Bool("dry-run", false, "只打印不写库")
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

	fixed, skipped := 0, 0
	for i := range rows {
		script := rows[i].ToScript()
		before := 0
		if eps, ok := script["episodes"].([]any); ok {
			before = len(eps)
		}
		if !scriptdata.NormalizeEpisodes(script) {
			skipped++
			continue
		}
		after := 0
		switch eps := script["episodes"].(type) {
		case []any:
			after = len(eps)
		case []map[string]any:
			after = len(eps)
		}
		title, _ := script["title"].(string)
		fmt.Printf("%s  %s  eps %d→%d  total=%v trial=%v\n",
			rows[i].ScriptID, title, before, after, script["totalEpisodes"], script["trialCount"])
		if *dry {
			fixed++
			continue
		}
		payload, err := json.Marshal(script)
		if err != nil {
			fmt.Fprintf(os.Stderr, "marshal %s: %v\n", rows[i].ScriptID, err)
			continue
		}
		if err := db.Model(&models.AdminScript{}).Where("script_id = ?", rows[i].ScriptID).
			Update("payload", string(payload)).Error; err != nil {
			fmt.Fprintf(os.Stderr, "update %s: %v\n", rows[i].ScriptID, err)
			continue
		}
		fixed++
	}
	fmt.Printf("done fixed=%d skipped=%d dry=%v\n", fixed, skipped, *dry)
}
