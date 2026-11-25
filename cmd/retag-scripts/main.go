// AI 批量重打情节标签 + 质量评级，并按档位改价。
//
//	go run ./cmd/retag-scripts           # dry-run
//	go run ./cmd/retag-scripts --fix    # 写库
//	go run ./cmd/retag-scripts --fix -batch=20
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/LingByte/miniseadrama/internal/configs"
	"github.com/LingByte/miniseadrama/internal/models"
	"github.com/LingByte/miniseadrama/internal/pipeline/script"
	"github.com/LingByte/miniseadrama/internal/pricing"
)

func main() {
	fix := flag.Bool("fix", false, "写入数据库（默认只预览）")
	batchSize := flag.Int("batch", 25, "每批送给模型的剧本数")
	statusFilter := flag.String("status", "on", "只处理该 status；空=全部")
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

	baseURL := strings.TrimSpace(os.Getenv("AI_BASE_URL"))
	if baseURL == "" {
		baseURL = "https://team.lingecho.com/v1"
	}
	apiKey := strings.TrimSpace(os.Getenv("AI_API_KEY"))
	model := strings.TrimSpace(os.Getenv("AI_TEXT_MODEL"))
	if model == "" {
		model = "claude-opus-5.5特价"
	}
	client, err := script.NewLLMClient(script.LLMConfig{
		BaseURL: baseURL, APIKey: apiKey, Model: model,
		Temperature: 0.55, MaxTokens: 8192, Timeout: 180 * time.Second,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "llm: %v\n", err)
		os.Exit(1)
	}

	var rows []models.AdminScript
	if err := db.Find(&rows).Error; err != nil {
		fmt.Fprintf(os.Stderr, "list: %v\n", err)
		os.Exit(1)
	}

	type workItem struct {
		row    models.AdminScript
		script map[string]any
		input  script.ShelfRateInput
	}
	var work []workItem
	for i := range rows {
		s := rows[i].ToScript()
		st := strings.TrimSpace(fmt.Sprint(s["status"]))
		if *statusFilter != "" && st != *statusFilter {
			continue
		}
		work = append(work, workItem{
			row:    rows[i],
			script: s,
			input: script.ShelfRateInput{
				ID:       rows[i].ScriptID,
				Title:    str(s["title"]),
				EnTitle:  str(s["enTitle"]),
				Logline:  str(s["logline"]),
				Synopsis: str(s["synopsis"]),
				Audience: str(s["audience"]),
			},
		})
	}
	if len(work) == 0 {
		fmt.Println("no scripts matched")
		return
	}
	fmt.Printf("matched %d scripts; batch=%d fix=%v\n", len(work), *batchSize, *fix)

	gradeCount := map[string]int{}
	updated := 0
	bs := *batchSize
	if bs < 1 {
		bs = 25
	}
	for start := 0; start < len(work); start += bs {
		end := start + bs
		if end > len(work) {
			end = len(work)
		}
		chunk := work[start:end]
		inputs := make([]script.ShelfRateInput, len(chunk))
		byID := make(map[string]workItem, len(chunk))
		for i, w := range chunk {
			inputs[i] = w.input
			byID[w.input.ID] = w
		}
		fmt.Printf("\n--- LLM batch %d-%d ---\n", start+1, end)
		results, err := script.RateShelfBatch(client, inputs)
		if err != nil {
			fmt.Fprintf(os.Stderr, "rate batch: %v\n", err)
			os.Exit(1)
		}
		now := time.Now().UTC().Format(time.RFC3339)
		for _, r := range results {
			w, ok := byID[r.ID]
			if !ok {
				continue
			}
			quality := pricing.QualityFullLabel(r.Grade)
			price := pricing.SuggestPrice(quality)
			oldQ := str(w.script["quality"])
			oldTags := fmt.Sprint(w.script["tags"])
			oldPrice := w.script["price"]
			gradeCount[r.Grade]++

			fmt.Printf("%s 《%s》\n  %s %v %s\n  → %s %.1f %v (%s)\n",
				r.ID, w.input.Title, oldQ, oldPrice, oldTags, quality, price, r.Tags, r.Reason)

			if !*fix {
				continue
			}
			w.script["quality"] = quality
			w.script["tags"] = r.Tags
			w.script["price"] = price
			w.script["saleType"] = "wholesale"
			if r.Audience == "男频" || r.Audience == "女频" {
				w.script["audience"] = r.Audience
			}
			hist, _ := w.script["priceHistory"].([]any)
			hist = append(hist, map[string]any{
				"price": price,
				"at":    now,
				"note":  fmt.Sprintf("AI 批量重评 %s → %s", oldQ, quality),
			})
			w.script["priceHistory"] = hist
			payload, err := json.Marshal(w.script)
			if err != nil {
				fmt.Fprintf(os.Stderr, "marshal %s: %v\n", r.ID, err)
				continue
			}
			if err := db.Model(&models.AdminScript{}).Where("script_id = ?", r.ID).
				Update("payload", string(payload)).Error; err != nil {
				fmt.Fprintf(os.Stderr, "db %s: %v\n", r.ID, err)
				continue
			}
			updated++
		}
	}

	fmt.Println("\n=== grade distribution ===")
	for _, g := range []string{"S", "A", "B", "C", "D"} {
		fmt.Printf("  %s: %d\n", g, gradeCount[g])
	}
	if *fix {
		fmt.Printf("done updated=%d\n", updated)
	} else {
		fmt.Println("(dry-run) re-run with --fix to write")
	}
}

func str(v any) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "<nil>" {
		return ""
	}
	return s
}
