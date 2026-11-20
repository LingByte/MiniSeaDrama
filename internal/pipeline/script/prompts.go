// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"encoding/json"
	"fmt"
	"strings"
)

const planSchema = `{
  "title_cn": "中文剧名",
  "title_en": "English Title",
  "logline": "一句话卖点，≤40字",
  "plot_summary": ["段1", "段2", "段3"],
  "categories": {"main": "主类别", "subs": ["标签"], "shelf": "货架定位"},
  "cover": {"visual": "", "palette": "", "composition": "", "title": "", "tagline": ""},
  "episodes": [
    {"number": 1, "event": "本集事件一句话", "emotion": "情绪词", "scenes": ["场1", "场2"], "hook": "结尾钩子"}
  ]
}`

const characterSchema = `{
  "characters": [
    {
      "name": "角色名",
      "role": "protagonist|antagonist|support",
      "one_track": "单一动机",
      "contrast": "反差点",
      "signature": "标志性台词风格",
      "look": "外形一句",
      "card": ["人设要点1", "人设要点2"]
    }
  ]
}`

const jsonHardRule = `硬性规则：
1. 只输出一个合法 JSON 对象，从 { 开始到 } 结束。
2. 禁止 Markdown 代码围栏（禁止 ` + "```" + `）。
3. 禁止在 JSON 前后写任何说明、标题、注释。
4. 字符串内换行必须写成 \n，不要直接换行。
5. 字段必须齐全；episodes 必须覆盖用户给出的每一集 number，不得省略。
6. 每个 episode 的 event/emotion/hook 尽量短（各 ≤40 字），scenes 最多 2 条短句。
7. 必须依据字幕里的实际台词/情节提炼，禁止输出占位或拒答文案（如「待定剧名」「Untitled Series」「原稿缺失」「无法生成」「无内容」「空白」「Content Missing」）。`

func skillSnippet(skill string) string {
	s := strings.TrimSpace(skill)
	if s == "" {
		return ""
	}
	// 策划/人物卡阶段只取技能摘要，避免整份 skill 把模型带偏成散文。
	const limit = 3500
	if len(s) > limit {
		s = s[:limit] + "\n…(skill truncated)"
	}
	return "【写作规范摘要】\n" + s
}

func BuildPlanMessages(skill, transcript string) []Message {
	system := strings.TrimSpace(strings.Join([]string{
		"你是海漫短剧策划助手。",
		jsonHardRule,
		"按下列 schema 输出全剧策划 JSON（episodes 数组覆盖全部集数）：",
		planSchema,
		skillSnippet(skill),
	}, "\n\n"))
	user := "根据下列字幕稿生成策划 JSON。务必覆盖字幕中出现的每一集。\n\n【原作字幕稿】\n" + transcript
	return []Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
}

func BuildCharacterMessages(skill string, plan map[string]any) []Message {
	system := strings.TrimSpace(strings.Join([]string{
		"你是海漫短剧人物设定助手。",
		jsonHardRule,
		"按下列 schema 输出人物卡 JSON：",
		characterSchema,
		skillSnippet(skill),
	}, "\n\n"))
	raw, _ := json.Marshal(plan)
	if len(raw) > 120_000 {
		raw = raw[:120_000]
	}
	user := fmt.Sprintf("根据策划生成人物台词设定卡 JSON。\n\n【策划】\n%s", string(raw))
	return []Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
}

func BuildEpisodeMessages(skill string, plan map[string]any, episodes []map[string]any, previousTail string) []Message {
	stage := "【逐集正文】输出英文剧本正文（非 JSON）。每集以 Episode N 开头，以 END OF EPISODE N 结尾。"
	system := strings.TrimSpace(skillSnippet(skill) + "\n\n" + stage)
	var targets []string
	for _, ep := range episodes {
		targets = append(targets, fmt.Sprintf("Episode %v", ep["number"]))
	}
	// 正文阶段不需要完整 plan，压缩体积
	slim := map[string]any{
		"title_cn": plan["title_cn"],
		"title_en": plan["title_en"],
		"logline":  plan["logline"],
		"batch":    episodes,
	}
	raw, _ := json.Marshal(slim)
	user := fmt.Sprintf("策划摘要：%s\n上一批结尾：%s\n本次集数：%s", string(raw), previousTail, strings.Join(targets, ", "))
	return []Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
}
