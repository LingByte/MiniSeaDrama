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
      "name": "Full English Name (e.g. Ethan Parker)",
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
5. episodes 数组必须覆盖字幕稿中出现的每一集 Episode N（1,2,3,…）。严禁只给前几集写大纲，严禁跳号、严禁重复 number。
6. 每个 episode 的 event/emotion/hook 尽量短（各 ≤40 字），scenes 最多 2 条短句。
7. 必须依据字幕里的实际台词/情节提炼，禁止输出占位或拒答文案（如「待定剧名」「Untitled Series」「原稿缺失」「无法生成」「无内容」「空白」「Content Missing」）。
8. characters.name 必须是稳定英文全名（名+姓），全剧唯一，禁止同一人多个姓氏。`

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

func BuildPlanMessages(skill, transcript string, totalEpisodesHint int) []Message {
	system := strings.TrimSpace(strings.Join([]string{
		"你是海漫短剧策划助手。",
		jsonHardRule,
		"按下列 schema 输出全剧策划 JSON（episodes 数组覆盖全部集数）：",
		planSchema,
		skillSnippet(skill),
	}, "\n\n"))
	user := "根据下列字幕稿生成策划 JSON。务必覆盖字幕中出现的每一集。\n\n" + transcript
	if totalEpisodesHint > 1 {
		user = fmt.Sprintf(
			"【硬性要求】字幕稿中检测到约 %d 集的剧集标记，episodes 数组必须覆盖 Episode 1 到 Episode %d 的全部编号。\n"+
				"严禁跳过集号，严禁只给前几集写大纲。如果后面集的字幕被截断，请依据前序剧情和该集编号自行补充大纲一句话。\n\n"+
				"根据下列字幕稿生成策划 JSON。\n\n%s",
			totalEpisodesHint, totalEpisodesHint, transcript,
		)
	}
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
		"主角全名一旦确定，后续所有集必须沿用，禁止 Parker/Brooks 这类姓氏漂移。",
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

// EpisodePromptContext 单集写作上下文（人名锁定 + 结构化衔接）。
type EpisodePromptContext struct {
	NameLock     []string
	Continuity   string // ContinuityCard.Format()，短状态卡而非整集正文
	NextOutline  string
}

func BuildEpisodeMessages(skill string, plan map[string]any, episodes []map[string]any, ctx EpisodePromptContext) []Message {
	nums := make([]string, 0, len(episodes))
	for _, ep := range episodes {
		nums = append(nums, fmt.Sprint(ep["number"]))
	}
	onlyOne := len(episodes) == 1
	stage := "【逐集正文】只输出英文剧本正文（非 JSON）。"
	if onlyOne {
		n := nums[0]
		stage += fmt.Sprintf("本次只写 Episode %s 一集：第一行必须是 Episode %s，最后一行必须是 END OF EPISODE %s。", n, n, n) +
			"严禁输出下一集、上一集或其它集数；写完 END OF EPISODE 立即停止。"
	} else {
		stage += "每集以 Episode N 开头，以 END OF EPISODE N 结尾。" +
			"写完本批最后一集的 END OF EPISODE 立即停止，不要追加任何说明。"
	}
	stage += "\n连贯规则：" +
		"1) 用【衔接卡】接戏：优先延续 last_location / present 人物与 open beat；" +
		"若本集大纲要求换时换地，开场用一句 CAPTION 或新场次头标明（如 LATER / NEXT DAY），不要无说明硬切；" +
		"2) 人物姓名必须严格使用【人物名锁定】列表，禁止改姓、改拼写；" +
		"3) 台词与动作必须写完整，禁止半截句后直接 END OF EPISODE；" +
		"4) 场次头用 集号-场号 LOCATION [INT.|EXT.] [DAY|NIGHT]；" +
		"5) 【下一集大纲】只用于本集结尾留钩，禁止提前写出下一集正文情节。"
	stage += "严禁输出：思考过程、<thinking>、交付说明、文件夹/Word 文件名、写作计划、自检清单、中文说明、Status/Writing Episodes 等元信息。"
	// 占位大纲（策划阶段被截断导致 LLM 漏写的集）：明确告诉 LLM 自由发挥
	isPlaceholder := false
	for _, ep := range episodes {
		if v, _ := ep["_filled"].(bool); v {
			isPlaceholder = true
			break
		}
	}
	if isPlaceholder {
		stage += "\n\n【重要】本集的策划大纲是占位（因字幕被截断未覆盖到本集）。" +
			"请你根据【衔接卡】里的上一集结尾信息 + 同剧类型与人物性格，自由设计本集剧情走向。" +
			"大纲里的 event/hook 只是占位文字，忽略它，凭你对前序剧情的理解来推进故事。"
	}
	system := strings.TrimSpace(skillSnippet(skill) + "\n\n" + stage)

	nameLock := ctx.NameLock
	if len(nameLock) == 0 {
		nameLock = lockedCharacterNames(plan)
	}
	slim := map[string]any{
		"title_cn":  plan["title_cn"],
		"title_en":  plan["title_en"],
		"logline":   plan["logline"],
		"name_lock": nameLock,
		"episode":   episodes[0],
	}
	if !onlyOne {
		slim["batch"] = episodes
		delete(slim, "episode")
	}
	raw, _ := json.Marshal(slim)
	target := "Episode " + strings.Join(nums, ", Episode ")
	cont := strings.TrimSpace(ctx.Continuity)
	if cont == "" {
		cont = "(无，本集为开篇)"
	}
	next := strings.TrimSpace(ctx.NextOutline)
	if next == "" {
		next = "(未提供)"
	}
	user := fmt.Sprintf(
		"策划摘要：%s\n\n【人物名锁定】%s\n\n【衔接卡】\n%s\n\n【下一集大纲｜仅作钩子参考】%s\n\n本次只写：%s",
		string(raw),
		strings.Join(nameLock, ", "),
		cont,
		next,
		target,
	)
	return []Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
}
