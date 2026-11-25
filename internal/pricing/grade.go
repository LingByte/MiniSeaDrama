// Copyright (c) 2026 lingbyte. All rights reserved.

package pricing

import "strings"

// GradeSuggestPrice 评级建议价（与前端 GRADE_SUGGEST_PRICE 对齐）。
var GradeSuggestPrice = map[string]float64{
	"S": 1099,
	"A": 599,
	"B": 199,
	"C": 99,
	"D": 19.9,
}

// PlotTags 情节标签白名单（与前端 DEFAULT_GROUPS.plot 对齐）。
var PlotTags = []string{
	"契约婚姻", "先婚后爱", "打脸", "豪门", "命定伴侣", "血脉觉醒", "追妻火葬场", "重生",
	"大女主", "爽文", "宫廷权谋", "女帝", "史诗", "双胞胎", "反转", "高智商", "隐藏身份",
	"逆袭", "男频爆款", "娱乐圈", "反击", "古堡", "时空书信", "哥特", "穿书", "反派攻略", "轻喜剧",
}

// QualityFullLabel 把 S/A/B/C/D 扩成前台标签。
func QualityFullLabel(grade string) string {
	g := strings.ToUpper(strings.TrimSpace(grade))
	if g == "" {
		return "B 良好"
	}
	switch string([]rune(g)[0]) {
	case "S":
		return "S 顶级精品"
	case "A":
		return "A 优质"
	case "B":
		return "B 良好"
	case "C":
		return "C 基础"
	case "D":
		return "D 特价"
	default:
		return "B 良好"
	}
}

// GradeOf 取质量标签首字母大写。
func GradeOf(quality string) string {
	q := strings.TrimSpace(quality)
	if q == "" {
		return ""
	}
	return strings.ToUpper(string([]rune(q)[0]))
}

// SuggestPrice 按评级给建议价，未知回落 B。
func SuggestPrice(quality string) float64 {
	g := GradeOf(quality)
	if p, ok := GradeSuggestPrice[g]; ok {
		return p
	}
	return GradeSuggestPrice["B"]
}

// NormalizePlotTags 只保留白名单内标签，去重，最多 max 个。
func NormalizePlotTags(in []string, max int) []string {
	if max <= 0 {
		max = 4
	}
	allow := make(map[string]struct{}, len(PlotTags))
	for _, t := range PlotTags {
		allow[t] = struct{}{}
	}
	seen := map[string]struct{}{}
	var out []string
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if _, ok := allow[t]; !ok {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
		if len(out) >= max {
			break
		}
	}
	return out
}
