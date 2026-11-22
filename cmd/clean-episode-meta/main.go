// 清洗分集正文里混入的 AI thinking / 交付说明，并写回 DB。
//
//	go run ./cmd/clean-episode-meta
//	go run ./cmd/clean-episode-meta -dry-run
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

	touched, skipped, epsChanged := 0, 0, 0
	for i := range rows {
		script := rows[i].ToScript()
		beforeLens := episodeLens(script)
		changed := scriptdata.CleanScriptEpisodes(script)
		_ = scriptdata.RenumberScriptEpisodes(script)
		if scriptdata.NormalizeScriptSceneHeaders(script) {
			changed = true
		}
		if !changed {
			skipped++
			continue
		}
		afterLens := episodeLens(script)
		title, _ := script["title"].(string)
		delta := 0
		for j := range beforeLens {
			if j < len(afterLens) && afterLens[j] < beforeLens[j] {
				delta++
				epsChanged++
			}
		}
		fmt.Printf("%s  %s  cleaned_eps=%d\n", rows[i].ScriptID, title, delta)
		if *dry {
			touched++
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
		touched++
	}
	fmt.Printf("done touched=%d skipped=%d eps_changed=%d dry=%v\n", touched, skipped, epsChanged, *dry)
}

func episodeLens(script map[string]any) []int {
	var out []int
	switch eps := script["episodes"].(type) {
	case []map[string]any:
		for _, e := range eps {
			t, _ := e["text"].(string)
			out = append(out, len(t))
		}
	case []any:
		for _, raw := range eps {
			m, ok := raw.(map[string]any)
			if !ok {
				out = append(out, 0)
				continue
			}
			t, _ := m["text"].(string)
			out = append(out, len(t))
		}
	}
	return out
}
