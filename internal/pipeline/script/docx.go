// Copyright (c) 2026 lingbyte. All rights reserved.

package script

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/LingByte/miniseadrama/internal/scriptdata"
)

var (
	episodeLineRE = regexp.MustCompile(`(?i)^\*{0,2}\s*Episode\s+\d+\s*\*{0,2}$`)
	sceneHeaderRE = regexp.MustCompile(`(?i)^\d+\s*-\s*\d+\s+.+\[(?:INT|EXT)\.?\]\s*\[(?:DAY|NIGHT)\]`)
	endEpisodeRE  = regexp.MustCompile(`(?i)END OF EPISODE\s+\d+`)
	endSeriesRE   = regexp.MustCompile(`(?i)END OF SERIES`)
)

// CleanScriptText strips fences、水印、thinking / 交付说明等拼进正文的垃圾。
func CleanScriptText(text string) string {
	return scriptdata.CleanEpisodeText(text)
}

type para struct {
	text   string
	size   int
	bold   bool
	center bool
	before int
	after  int
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

func renderDocument(paragraphs []para) []byte {
	var body strings.Builder
	for _, p := range paragraphs {
		align := ""
		if p.center {
			align = `<w:jc w:val="center"/>`
		}
		spacing := fmt.Sprintf(`<w:spacing w:before="%d" w:after="%d"/>`, p.before*20, p.after*20)
		bold := ""
		if p.bold {
			bold = `<w:b/>`
		}
		size := p.size
		if size <= 0 {
			size = 11
		}
		body.WriteString(fmt.Sprintf(
			`<w:p><w:pPr>%s%s</w:pPr><w:r><w:rPr>%s<w:sz w:val="%d"/><w:szCs w:val="%d"/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="微软雅黑"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`,
			align, spacing, bold, size*2, size*2, xmlEscape(p.text),
		))
	}
	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:body>` + body.String() +
		`<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
		`</w:body></w:document>`
	return []byte(doc)
}

func writeDocx(path string, paragraphs []para) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	buf := new(bytes.Buffer)
	zw := zip.NewWriter(buf)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		"word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
		"word/document.xml": string(renderDocument(paragraphs)),
	}
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		if _, err := w.Write([]byte(content)); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// WriteScriptDocx writes 剧本.docx.
func WriteScriptDocx(path, titleEN string, episodes []string) error {
	var paras []para
	paras = append(paras, para{text: titleEN, size: 18, center: true, after: 18})
	lastEp := 0
	sawEndSeries := false
	for _, raw := range episodes {
		text := CleanScriptText(raw)
		if text == "" {
			continue
		}
		for _, line := range strings.Split(text, "\n") {
			stripped := strings.TrimSpace(line)
			if stripped == "" {
				continue
			}
			if episodeLineRE.MatchString(stripped) {
				fmt.Sscanf(stripped, "Episode %d", &lastEp)
				paras = append(paras, para{text: stripped, size: 13, before: 18, after: 8})
				continue
			}
			if endEpisodeRE.MatchString(stripped) {
				paras = append(paras, para{
					text: fmt.Sprintf("— END OF EPISODE %d —", lastEp),
					bold: true, center: true, before: 12, after: 6,
				})
				continue
			}
			if endSeriesRE.MatchString(stripped) {
				sawEndSeries = true
				paras = append(paras, para{text: "END OF SERIES", bold: true, center: true, before: 12})
				continue
			}
			before := 0
			if sceneHeaderRE.MatchString(stripped) {
				before = 10
			}
			paras = append(paras, para{text: stripped, before: before, after: 4})
		}
	}
	if !sawEndSeries {
		paras = append(paras, para{text: "END OF SERIES", bold: true, center: true, before: 12})
	}
	return writeDocx(path, paras)
}

// WriteSettingDocx writes 设定.docx.
func WriteSettingDocx(path string, plan, rating map[string]any) error {
	var paras []para
	titleCN := strings.TrimSpace(fmt.Sprint(plan["title_cn"]))
	titleEN := strings.TrimSpace(fmt.Sprint(plan["title_en"]))
	head := titleEN
	if titleCN != "" {
		head = "《" + titleCN + "》"
	}
	paras = append(paras,
		para{text: head, size: 20, bold: true, center: true, after: 4},
		para{text: titleEN, size: 15, center: true, after: 12},
	)
	cats, _ := plan["categories"].(map[string]any)
	if cats == nil {
		cats = map[string]any{}
	}
	subs := joinAny(cats["subs"])
	subs = strings.ReplaceAll(subs, "\n", "、")
	paras = append(paras, para{text: "一、情节类别", size: 14, bold: true, before: 16, after: 6})
	for _, line := range []string{
		fmt.Sprintf("主类别：%v", cats["main"]),
		"副标签：" + subs,
		fmt.Sprintf("货架定位：%v", cats["shelf"]),
	} {
		paras = append(paras, para{text: line, after: 4})
	}
	paras = append(paras, para{text: "二、品质评级", size: 14, bold: true, before: 16, after: 6})
	if rating != nil {
		paras = append(paras, para{
			text: fmt.Sprintf("品质评级：%v（%v / 100）", rating["grade"], rating["score"]),
			bold: true, after: 4,
		})
		paras = append(paras, para{text: fmt.Sprintf("封顶：%v", rating["caps"]), after: 4})
	} else {
		paras = append(paras, para{text: "本次未生成评级。", after: 4})
	}
	cover, _ := plan["cover"].(map[string]any)
	if cover == nil {
		cover = map[string]any{}
	}
	paras = append(paras, para{text: "三、封面设计", size: 14, bold: true, before: 16, after: 6})
	for _, line := range []string{
		fmt.Sprintf("画面：%v", cover["visual"]),
		fmt.Sprintf("色调：%v", cover["palette"]),
		fmt.Sprintf("构图：%v", cover["composition"]),
		fmt.Sprintf("标题：%v", cover["title"]),
		fmt.Sprintf("标语：%v", cover["tagline"]),
	} {
		paras = append(paras, para{text: line, after: 4})
	}
	paras = append(paras, para{text: "四、剧情梗概", size: 14, bold: true, before: 16, after: 6})
	for _, line := range strings.Split(joinAny(plan["plot_summary"]), "\n") {
		if strings.TrimSpace(line) != "" {
			paras = append(paras, para{text: line, after: 4})
		}
	}
	paras = append(paras, para{text: "五、人物设定", size: 14, bold: true, before: 16, after: 6})
	chars, _ := plan["characters"].([]any)
	for _, raw := range chars {
		c, _ := raw.(map[string]any)
		if c == nil {
			continue
		}
		paras = append(paras, para{
			text: fmt.Sprintf("%v（%v）", c["name"], c["role"]),
			bold: true, before: 8, after: 3,
		})
		if card := joinAny(c["card"]); card != "" {
			for _, line := range strings.Split(card, "\n") {
				if strings.TrimSpace(line) != "" {
					paras = append(paras, para{text: line, after: 4})
				}
			}
		} else {
			for _, line := range []string{
				fmt.Sprintf("一根筋：%v", c["one_track"]),
				fmt.Sprintf("反差：%v", c["contrast"]),
				fmt.Sprintf("招牌：%v", c["signature"]),
				fmt.Sprintf("外形锁定：%v", c["look"]),
			} {
				paras = append(paras, para{text: line, after: 4})
			}
		}
	}
	return writeDocx(path, paras)
}

func joinAny(v any) string {
	switch t := v.(type) {
	case []any:
		var parts []string
		for _, item := range t {
			parts = append(parts, fmt.Sprint(item))
		}
		return strings.Join(parts, "\n")
	case []string:
		return strings.Join(t, "\n")
	default:
		return fmt.Sprint(v)
	}
}
