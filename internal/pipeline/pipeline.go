// Copyright (c) 2026 lingbyte. All rights reserved.

package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/LingByte/miniseadrama/internal/pipeline/asr"
	"github.com/LingByte/miniseadrama/internal/pipeline/ffmpeg"
	"github.com/LingByte/miniseadrama/internal/pipeline/script"
	"github.com/LingByte/miniseadrama/internal/pipeline/shortflix"
	"github.com/LingByte/miniseadrama/internal/pipeline/subtitle"
)

// StageLabels are user-facing stage names.
var StageLabels = map[string]string{
	"inspect":    "识别剧集",
	"download":   "下载素材",
	"transcribe": "字幕准备",
	"merge":      "合并全剧字幕",
	"script":     "生成剧本",
	"done":       "完成",
}

var stageWeights = map[string]float64{
	"inspect": 3, "download": 37, "transcribe": 38, "merge": 5, "script": 17,
}
var stageOrder = []string{"inspect", "download", "transcribe", "merge", "script"}

// ErrCancelled is returned when the user cancels a job.
var ErrCancelled = errors.New("任务已取消。")

// EmitFn reports pipeline events to the job manager.
type EmitFn func(eventType, message string, extra map[string]any)

// Controller provides cancel/pause hooks without importing jobs.
type Controller interface {
	Cancelled() bool
	WaitIfPaused()
}

// Pipeline orchestrates ShortFlix → ASR/subs → script.
type Pipeline struct {
	Params     map[string]any
	Emit       EmitFn
	Ctrl       Controller
	Downloader *shortflix.SeriesDownloader

	state map[string]any
	mu    sync.Mutex
}

// New creates a pipeline runner.
func New(params map[string]any, emit EmitFn, ctrl Controller) *Pipeline {
	if emit == nil {
		emit = func(string, string, map[string]any) {}
	}
	return &Pipeline{
		Params: params,
		Emit:   emit,
		Ctrl:   ctrl,
		state: map[string]any{
			"stage": "inspect", "stage_label": StageLabels["inspect"],
			"overall": 0, "total_episodes": 0, "downloaded": 0, "transcribed": 0,
			"current_episode": nil, "script_batch": 0, "script_batches": 0,
		},
	}
}

func (p *Pipeline) checkCancel() error {
	if p.Ctrl != nil && p.Ctrl.Cancelled() {
		return ErrCancelled
	}
	return nil
}

func (p *Pipeline) waitIfPaused() {
	if p.Ctrl != nil {
		p.Ctrl.WaitIfPaused()
	}
}

func (p *Pipeline) fraction(stage string, ratio float64) float64 {
	if stage == "done" {
		return 100
	}
	base := 0.0
	for _, key := range stageOrder {
		if key == stage {
			break
		}
		base += stageWeights[key]
	}
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	return float64(int((base+stageWeights[stage]*ratio)*10+0.5)) / 10
}

func (p *Pipeline) progress(stage string, ratio float64, message string, extra map[string]any) {
	p.mu.Lock()
	p.state["stage"] = stage
	p.state["stage_label"] = StageLabels[stage]
	p.state["overall"] = p.fraction(stage, ratio)
	for k, v := range extra {
		p.state[k] = v
	}
	snapshot := map[string]any{}
	for k, v := range p.state {
		snapshot[k] = v
	}
	p.mu.Unlock()
	merged := map[string]any{"progress": snapshot}
	for k, v := range extra {
		merged[k] = v
	}
	p.Emit("progress", message, merged)
}

// Run executes the full pipeline.
func (p *Pipeline) Run(ctx context.Context) (map[string]any, error) {
	if err := p.checkCancel(); err != nil {
		return nil, err
	}
	_ = EnsureDirs()
	cookie := ParseCookieHeader(fmt.Sprint(p.Params["cookie"]))
	urlStr := strings.TrimSpace(fmt.Sprint(p.Params["url"]))

	p.progress("inspect", 0.1, "正在识别剧目信息。", nil)
	series, err := shortflix.DiscoverSeries(urlStr, cookie)
	if err != nil {
		return nil, err
	}
	if err := p.checkCancel(); err != nil {
		return nil, err
	}
	epInfos := make([]map[string]any, 0, len(series.Episodes))
	for _, ep := range series.Episodes {
		epInfos = append(epInfos, map[string]any{
			"number": ep.Number, "title": ep.Title, "duration": ep.Duration,
		})
	}
	p.Emit("series", fmt.Sprintf("已识别《%s》，共 %d 集。", series.Title, len(series.Episodes)), map[string]any{
		"series": map[string]any{
			"title": series.Title, "slug": series.Slug, "source_url": series.SourceURL,
			"episode_count": len(series.Episodes), "episodes": epInfos,
		},
	})
	workdir := p.workdir(series)
	p.progress("inspect", 1, "剧目识别完成。", map[string]any{
		"total_episodes": len(series.Episodes),
		"workdir":        workdir,
	})
	if err := p.checkCancel(); err != nil {
		return nil, err
	}
	p.waitIfPaused()

	srtPaths, err := p.fetchEnglishSubtitles(series, workdir, cookie)
	if err != nil {
		p.Emit("log", fmt.Sprintf("%v 将改用视频语音识别补全字幕。", err), nil)
		srtPaths = map[int]string{}
	}

	var missing []int
	for _, ep := range series.Episodes {
		if _, ok := srtPaths[ep.Number]; !ok {
			missing = append(missing, ep.Number)
		}
	}
	var seriesDir string
	var ffmpegPath string
	if len(missing) > 0 {
		if err := p.checkCancel(); err != nil {
			return nil, err
		}
		p.waitIfPaused()
		audioDir := filepath.Join(workdir, "audio")
		var noAudio []int
		for _, n := range missing {
			st, err := os.Stat(filepath.Join(audioDir, fmt.Sprintf("E%03d.mp3", n)))
			if err != nil || st.Size() == 0 {
				noAudio = append(noAudio, n)
			}
		}
		if len(noAudio) > 0 {
			var ferr error
			ffmpegPath, ferr = ffmpeg.FindFFmpeg(fmt.Sprint(p.Params["ffmpeg"]))
			if ferr != nil {
				return nil, ferr
			}
			seriesDir, err = p.download(ctx, series, filepath.Join(workdir, "videos"), cookie, ffmpegPath, noAudio)
			if err != nil {
				return nil, err
			}
			if err := p.checkCancel(); err != nil {
				return nil, err
			}
		}
		more, err := p.transcribe(ctx, series, seriesDir, workdir, ffmpegPath)
		if err != nil {
			return nil, err
		}
		for k, v := range more {
			srtPaths[k] = v
		}
	}
	if err := p.checkCancel(); err != nil {
		return nil, err
	}
	p.waitIfPaused()

	mergeResult, err := p.merge(series, workdir, seriesDir, srtPaths, ffmpegPath)
	if err != nil {
		return nil, err
	}
	return p.finish(series, workdir, mergeResult)
}

func (p *Pipeline) workdir(series shortflix.Series) string {
	root := WorkDir()
	if v := strings.TrimSpace(fmt.Sprint(p.Params["output_root"])); v != "" && v != "<nil>" {
		root = v
	}
	folder := fmt.Sprintf("%s [%s]", SafeFilename(series.Title, "drama"), SafeFilename(series.Slug, "series"))
	dir := filepath.Join(root, folder)
	for _, name := range []string{"videos", "audio", "subtitles", "text", "series", "prompt", "output"} {
		_ = os.MkdirAll(filepath.Join(dir, name), 0o755)
	}
	return dir
}

func (p *Pipeline) fetchEnglishSubtitles(series shortflix.Series, workdir, cookie string) (map[int]string, error) {
	subsDir := filepath.Join(workdir, "subtitles")
	_ = os.MkdirAll(subsDir, 0o755)
	total := len(series.Episodes)
	paths := map[int]string{}
	var missing []int
	episodeSubs := initEpisodeSubs(series.Episodes)
	p.progress("download", 0, "正在获取官方英文字幕。", map[string]any{
		"downloaded": 0, "workdir": workdir, "episode_subs": episodeSubs,
	})
	for index, episode := range series.Episodes {
		if err := p.checkCancel(); err != nil {
			return nil, err
		}
		setEpisodeSubStatus(episodeSubs, episode.Number, "running", "")
		p.progress("download", float64(index)/float64(max(total, 1)),
			fmt.Sprintf("正在获取第 %d 集字幕。", episode.Number),
			map[string]any{
				"current_episode": episode.Number, "downloaded": index,
				"workdir": workdir, "episode_subs": cloneEpisodeSubs(episodeSubs),
			})
		saved, lastErr := downloadEpisodeEnglishSubtitle(episode, subsDir, cookie)
		if saved != "" {
			paths[episode.Number] = saved
			setEpisodeSubStatus(episodeSubs, episode.Number, "ok", "")
		} else {
			missing = append(missing, episode.Number)
			errMsg := lastErr
			if errMsg == "" {
				errMsg = "没有可用的英文字幕"
			}
			setEpisodeSubStatus(episodeSubs, episode.Number, "fail", errMsg)
			p.Emit("log", fmt.Sprintf("第 %d 集字幕下载失败：%s", episode.Number, errMsg), nil)
		}
		p.progress("download", float64(index+1)/float64(max(total, 1)),
			fmt.Sprintf("第 %d 集字幕处理完成。", episode.Number),
			map[string]any{
				"current_episode": episode.Number, "downloaded": index + 1,
				"workdir": workdir, "episode_subs": cloneEpisodeSubs(episodeSubs),
			})
	}
	if len(paths) == 0 {
		hardAll := true
		for _, ep := range series.Episodes {
			if len(ep.Versions) == 0 {
				hardAll = false
				break
			}
			for _, v := range ep.Versions {
				if !v.HardSub {
					hardAll = false
					break
				}
			}
		}
		if hardAll {
			return nil, fmt.Errorf("《%s》全部 %d 集都是硬字幕：网站没有提供可下载的字幕文件", series.Title, len(series.Episodes))
		}
		return nil, fmt.Errorf("整剧 %d 集都没有可下载的英文字幕轨", len(series.Episodes))
	}
	if len(missing) > 0 {
		preview := missing
		if len(preview) > 10 {
			preview = preview[:10]
		}
		p.Emit("log", fmt.Sprintf("有 %d 集没有英文字幕，已跳过：%v", len(missing), preview), nil)
	}
	p.progress("transcribe", 1, "已使用官方英文字幕，跳过 ASR。", map[string]any{
		"transcribed": len(paths), "workdir": workdir, "episode_subs": cloneEpisodeSubs(episodeSubs),
	})
	return paths, nil
}

func downloadEpisodeEnglishSubtitle(episode shortflix.Episode, subsDir, cookie string) (saved string, lastErr string) {
	// 预拉/上次残留的英文字幕直接复用，跳过网络下载（data/pipeline 预热场景）
	for _, suffix := range []string{".vtt", ".srt"} {
		existing := filepath.Join(subsDir, fmt.Sprintf("E%03d%s", episode.Number, suffix))
		if data, err := os.ReadFile(existing); err == nil && len(data) > 0 && subtitle.LooksEnglish(string(data)) {
			return existing, ""
		}
	}
	for _, sub := range englishSubtitleCandidates(episode) {
		suffix := ".srt"
		if strings.Contains(strings.ToUpper(sub.Format), "VTT") {
			suffix = ".vtt"
		}
		target := filepath.Join(subsDir, fmt.Sprintf("E%03d%s", episode.Number, suffix))
		var content string
		var attemptErr error
		for attempt := 1; attempt <= 4; attempt++ {
			attemptErr = shortflix.DownloadTextFile(sub.URL, target, cookie)
			if attemptErr != nil {
				_ = os.Remove(target)
				lastErr = attemptErr.Error()
				if attempt < 4 && (strings.Contains(lastErr, "502") || strings.Contains(lastErr, "503") || strings.Contains(lastErr, "504") || strings.Contains(lastErr, "429")) {
					time.Sleep(time.Duration(attempt) * time.Second)
					continue
				}
				break
			}
			data, _ := os.ReadFile(target)
			content = string(data)
			break
		}
		if content != "" && subtitle.LooksEnglish(content) {
			return target, ""
		}
		if content != "" {
			lastErr = "字幕内容不是英文或无效"
		}
		_ = os.Remove(target)
	}
	return "", lastErr
}

func initEpisodeSubs(episodes []shortflix.Episode) []map[string]any {
	out := make([]map[string]any, 0, len(episodes))
	for _, ep := range episodes {
		out = append(out, map[string]any{
			"number": ep.Number, "status": "pending", "error": "",
		})
	}
	return out
}

func setEpisodeSubStatus(list []map[string]any, number int, status, errMsg string) {
	for _, item := range list {
		if asInt(item["number"]) == number {
			item["status"] = status
			item["error"] = errMsg
			return
		}
	}
}

func cloneEpisodeSubs(list []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		cp := map[string]any{}
		for k, v := range item {
			cp[k] = v
		}
		out = append(out, cp)
	}
	return out
}

func englishSubtitleCandidates(ep shortflix.Episode) []shortflix.Subtitle {
	seen := map[string]struct{}{}
	type scored struct {
		score int
		sub   shortflix.Subtitle
	}
	var list []scored
	for _, ver := range ep.Versions {
		for _, sub := range ver.Subtitles {
			if _, ok := seen[sub.URL]; ok {
				continue
			}
			seen[sub.URL] = struct{}{}
			if subtitle.SubtitleTitleIsOtherLanguage(sub.Title) {
				continue
			}
			score := 1
			if subtitle.SubtitleTitleIsEnglish(sub.Title) {
				score = 2
			}
			list = append(list, scored{score, sub})
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].score > list[j].score })
	out := make([]shortflix.Subtitle, len(list))
	for i, s := range list {
		out[i] = s.sub
	}
	return out
}

func (p *Pipeline) download(ctx context.Context, series shortflix.Series, videosRoot, cookie, ffmpegPath string, episodeNumbers []int) (string, error) {
	p.progress("download", 0, "正在下载需要补字幕的剧集。", nil)
	var downloader *shortflix.SeriesDownloader
	downloader = shortflix.NewSeriesDownloader(ffmpegPath, func(event shortflix.ProgressEvent) {
		if p.Ctrl != nil && p.Ctrl.Cancelled() && downloader != nil {
			downloader.Cancel()
		}
		eventType := fmt.Sprint(event["type"])
		episode := event["episode"]
		completed := asInt(event["index"])
		total := asInt(event["total"])
		if total <= 0 {
			total = len(series.Episodes)
		}
		switch eventType {
		case "episode_progress":
			percent := asFloat(event["percent"])
			ratio := (float64(max(completed-1, 0)) + percent/100) / float64(max(total, 1))
			p.progress("download", ratio, fmt.Sprintf("正在下载第 %v 集（%.0f%%）。", episode, percent),
				map[string]any{"current_episode": episode, "downloaded": completed - 1})
		case "episode_completed", "episode_skipped":
			p.waitIfPaused()
			p.progress("download", float64(completed)/float64(max(total, 1)),
				fmt.Sprintf("第 %v 集下载完成。", episode),
				map[string]any{"current_episode": episode, "downloaded": completed})
		default:
			if msg := fmt.Sprint(event["message"]); msg != "" && msg != "<nil>" {
				p.Emit("log", msg, nil)
			}
		}
	})
	p.Downloader = downloader
	defer func() { p.Downloader = nil }()

	refresher := func() (shortflix.Series, error) {
		return shortflix.DiscoverSeries(series.SourceURL, cookie)
	}
	seriesDir, err := downloader.Download(ctx, series, videosRoot, episodeNumbers, "best", 2, refresher)
	if err != nil {
		var ce shortflix.CancelledError
		if errors.As(err, &ce) || errors.Is(err, context.Canceled) {
			return "", ErrCancelled
		}
		return "", err
	}
	p.progress("download", 1, "下载完成："+seriesDir, map[string]any{"downloaded": len(series.Episodes)})
	return seriesDir, nil
}

func (p *Pipeline) findVideo(seriesDir string, series shortflix.Series, number int) string {
	expected := filepath.Join(seriesDir, fmt.Sprintf("%s - E%03d.mp4", SafeFilename(series.Title, "drama"), number))
	if st, err := os.Stat(expected); err == nil && !st.IsDir() {
		return expected
	}
	matches, _ := filepath.Glob(filepath.Join(seriesDir, fmt.Sprintf("*E%03d*.mp4", number)))
	if len(matches) > 0 {
		return matches[0]
	}
	return ""
}

func (p *Pipeline) transcribe(ctx context.Context, series shortflix.Series, seriesDir, workdir, ffmpegPath string) (map[int]string, error) {
	engine := strings.ToLower(strings.TrimSpace(fmt.Sprint(p.Params["engine"])))
	if engine == "" || engine == "<nil>" {
		engine = asr.DefaultEngine
	}
	workers := asInt(p.Params["workers"])
	if workers < 1 {
		workers = 3
	}
	if workers > 6 {
		workers = 6
	}
	force := asBool(p.Params["redo_asr"])
	total := len(series.Episodes)
	srtDir := filepath.Join(workdir, "subtitles")
	audioDir := filepath.Join(workdir, "audio")
	textDir := filepath.Join(workdir, "text")
	_ = os.MkdirAll(srtDir, 0o755)
	_ = os.MkdirAll(audioDir, 0o755)
	_ = os.MkdirAll(textDir, 0o755)

	p.progress("transcribe", 0, "开始逐集提取语音并识别。", map[string]any{"transcribed": 0})
	results := map[int]string{}
	var failures []string
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, workers)
	done := 0

	work := func(ep shortflix.Episode) {
		defer wg.Done()
		sem <- struct{}{}
		defer func() { <-sem }()
		number := ep.Number
		if err := p.checkCancel(); err != nil {
			return
		}
		p.waitIfPaused()
		srtPath := filepath.Join(srtDir, fmt.Sprintf("E%03d.srt", number))
		vttPath := filepath.Join(srtDir, fmt.Sprintf("E%03d.vtt", number))
		var existing string
		if !force {
			if st, err := os.Stat(vttPath); err == nil && st.Size() > 0 {
				existing = vttPath
			} else if st, err := os.Stat(srtPath); err == nil && st.Size() > 0 {
				existing = srtPath
			}
		}
		if existing != "" {
			segs, _ := subtitle.ParseSubtitleFile(existing)
			cleaned := subtitle.DedupeSegments(segs)
			_ = os.WriteFile(filepath.Join(textDir, fmt.Sprintf("E%03d.txt", number)),
				[]byte(subtitle.SegmentsToParagraphs(cleaned)), 0o644)
			mu.Lock()
			results[number] = existing
			done++
			cur := done
			mu.Unlock()
			p.progress("transcribe", float64(cur)/float64(max(total, 1)),
				fmt.Sprintf("已处理 %d/%d 集。", cur, total),
				map[string]any{"transcribed": len(results), "current_episode": number})
			return
		}
		audioPath := filepath.Join(audioDir, fmt.Sprintf("E%03d.mp3", number))
		if st, err := os.Stat(audioPath); err != nil || st.Size() == 0 {
			if seriesDir == "" || ffmpegPath == "" {
				mu.Lock()
				failures = append(failures, fmt.Sprintf("第 %d 集缺少音频，且没有视频可提取。", number))
				done++
				mu.Unlock()
				return
			}
			video := p.findVideo(seriesDir, series, number)
			if video == "" {
				mu.Lock()
				failures = append(failures, fmt.Sprintf("第 %d 集视频文件不存在。", number))
				done++
				mu.Unlock()
				return
			}
			p.Emit("log", fmt.Sprintf("第 %d 集：提取音频。", number), nil)
			if err := ffmpeg.ExtractAudio(ctx, ffmpegPath, video, audioPath); err != nil {
				mu.Lock()
				failures = append(failures, fmt.Sprintf("第 %d 集：%v", number, err))
				done++
				mu.Unlock()
				return
			}
		}
		if err := p.checkCancel(); err != nil {
			return
		}
		order := []string{engine}
		for key := range asr.EngineInfo {
			if key != engine {
				order = append(order, key)
			}
		}
		var result asr.Data
		var errorsList []string
		ok := false
		for _, name := range order {
			candidate, err := asr.Transcribe(audioPath, name, true, 2, func(msg string) {
				p.Emit("log", fmt.Sprintf("第 %d 集：%s", number, msg), nil)
			})
			if err != nil {
				errorsList = append(errorsList, fmt.Sprintf("%s：%v", asr.EngineInfo[name], err))
				continue
			}
			if candidate.HasData() {
				result = candidate
				ok = true
				break
			}
			errorsList = append(errorsList, asr.EngineInfo[name]+"：没有识别出文字")
		}
		if !ok {
			tail := errorsList
			if len(tail) > 2 {
				tail = tail[len(tail)-2:]
			}
			mu.Lock()
			failures = append(failures, fmt.Sprintf("第 %d 集：%s", number, strings.Join(tail, "；")))
			done++
			mu.Unlock()
			return
		}
		var segs []subtitle.Segment
		for _, item := range result.Segments {
			segs = append(segs, subtitle.Segment{
				StartMs: int(item.StartTime), EndMs: int(item.EndTime), Text: item.Text,
			})
		}
		cleaned := subtitle.DedupeSegments(segs)
		_ = os.WriteFile(srtPath, []byte(subtitle.SegmentsToSRT(cleaned)), 0o644)
		_ = os.WriteFile(filepath.Join(textDir, fmt.Sprintf("E%03d.txt", number)),
			[]byte(subtitle.SegmentsToParagraphs(cleaned)), 0o644)
		mu.Lock()
		results[number] = srtPath
		done++
		cur := done
		nResults := len(results)
		mu.Unlock()
		p.progress("transcribe", float64(cur)/float64(max(total, 1)),
			fmt.Sprintf("已处理 %d/%d 集。", cur, total),
			map[string]any{"transcribed": nResults, "current_episode": number})
	}

	for _, ep := range series.Episodes {
		wg.Add(1)
		go work(ep)
	}
	wg.Wait()
	if err := p.checkCancel(); err != nil {
		return nil, err
	}
	if len(results) == 0 {
		preview := failures
		if len(preview) > 5 {
			preview = preview[:5]
		}
		return nil, fmt.Errorf("所有剧集都识别失败：%s", strings.Join(preview, "；"))
	}
	if len(failures) > 0 {
		preview := failures
		if len(preview) > 5 {
			preview = preview[:5]
		}
		p.Emit("log", fmt.Sprintf("有 %d 集识别失败，已跳过：%s", len(failures), strings.Join(preview, "；")), nil)
	}
	return results, nil
}

func (p *Pipeline) merge(series shortflix.Series, workdir, seriesDir string, srtPaths map[int]string, ffmpegPath string) (map[string]any, error) {
	p.progress("merge", 0.1, "正在合并全剧字幕。", nil)
	mergedDir := filepath.Join(workdir, "series")
	promptDir := filepath.Join(workdir, "prompt")
	_ = os.MkdirAll(mergedDir, 0o755)
	_ = os.MkdirAll(promptDir, 0o755)

	var allSegments []subtitle.Segment
	var transcriptParts []string
	var episodeMeta []map[string]any
	offset := 0

	for _, episode := range series.Episodes {
		p.waitIfPaused()
		srtPath := srtPaths[episode.Number]
		if srtPath == "" {
			continue
		}
		if err := p.checkCancel(); err != nil {
			return nil, err
		}
		segs, err := subtitle.ParseSubtitleFile(srtPath)
		if err != nil {
			continue
		}
		segs = subtitle.DedupeSegments(segs)
		paragraphs := subtitle.SegmentsToParagraphs(segs)
		transcriptParts = append(transcriptParts, fmt.Sprintf("Episode %d\n\n%s", episode.Number, paragraphs))
		allSegments = append(allSegments, subtitle.OffsetSegments(segs, offset)...)
		durationMS := episode.Duration * 1000
		if durationMS <= 0 && seriesDir != "" && ffmpegPath != "" {
			if video := p.findVideo(seriesDir, series, episode.Number); video != "" {
				durationMS = ffmpeg.ProbeDuration(ffmpegPath, video)
			}
		}
		if durationMS <= 0 && len(segs) > 0 {
			durationMS = segs[len(segs)-1].EndMs
		}
		end := durationMS
		if len(segs) > 0 && segs[len(segs)-1].EndMs > end {
			end = segs[len(segs)-1].EndMs
		}
		offset += end
		paraCount := 0
		for _, part := range strings.Split(paragraphs, "\n\n") {
			if strings.TrimSpace(part) != "" {
				paraCount++
			}
		}
		episodeMeta = append(episodeMeta, map[string]any{
			"number": episode.Number, "duration_ms": durationMS, "srt": srtPath,
			"paragraphs": paraCount, "chars": len(paragraphs),
		})
	}
	if len(transcriptParts) == 0 {
		return nil, fmt.Errorf("没有可合并的字幕")
	}
	transcript := strings.TrimSpace(strings.Join(transcriptParts, "\n\n")) + "\n"
	if n := subtitle.DialogueRuneCount(transcript); n < 200 {
		return nil, fmt.Errorf("字幕合并后几乎没有台词（约 %d 字）。常见原因：VTT 时间戳为 MM:SS.mmm 未被解析，或官方字幕为空。请重新跑字幕/识别后再生成剧本", n)
	}
	srtPath := filepath.Join(mergedDir, "全剧字幕.srt")
	_ = os.WriteFile(srtPath, []byte(subtitle.SegmentsToSRT(allSegments)), 0o644)
	transcriptPath := filepath.Join(mergedDir, "全剧台词.txt")
	_ = os.WriteFile(transcriptPath, []byte(transcript), 0o644)
	episodesJSON := filepath.Join(mergedDir, "episodes.json")
	rawMeta, _ := json.MarshalIndent(episodeMeta, "", "  ")
	_ = os.WriteFile(episodesJSON, rawMeta, 0o644)

	skillText, _ := os.ReadFile(SkillPath())
	_ = os.WriteFile(filepath.Join(promptDir, "skill.md"), skillText, 0o644)
	_ = os.WriteFile(filepath.Join(promptDir, "全剧字幕.md"), []byte(transcript), 0o644)
	promptPath := filepath.Join(promptDir, "一键投喂.md")
	_ = os.WriteFile(promptPath, []byte(strings.TrimSpace(string(skillText))+"\n\n---\n\n# 原作全剧字幕稿\n\n"+transcript+"\n"), 0o644)

	p.progress("merge", 1, "全剧字幕已合并。", nil)
	return map[string]any{
		"transcript":      transcript,
		"transcript_path": transcriptPath,
		"srt_path":        srtPath,
		"episodes_json":   episodesJSON,
		"prompt_path":     promptPath,
		"artifacts": []map[string]any{
			{"key": "transcript", "label": "全剧台词.txt", "path": transcriptPath},
			{"key": "series_srt", "label": "全剧字幕.srt", "path": srtPath},
			{"key": "prompt", "label": "一键投喂.md", "path": promptPath},
		},
	}, nil
}

func (p *Pipeline) finish(series shortflix.Series, workdir string, mergeResult map[string]any) (map[string]any, error) {
	artifacts, _ := mergeResult["artifacts"].([]map[string]any)
	var scriptResult map[string]any
	var scriptError string
	llmCfg, _ := p.Params["llm"].(map[string]any)
	if llmCfg == nil {
		llmCfg = map[string]any{}
	}
	apiKey := strings.TrimSpace(fmt.Sprint(llmCfg["api_key"]))
	if apiKey != "" && apiKey != "<nil>" {
		p.progress("script", 0.02, "正在生成剧本。", nil)
		temp := asFloat(llmCfg["temperature"])
		if temp == 0 {
			temp = 0.8
		}
		maxTokens := asInt(llmCfg["max_tokens"])
		if maxTokens <= 0 {
			maxTokens = 8192
		}
		timeoutSec := asInt(llmCfg["timeout"])
		if timeoutSec <= 0 {
			timeoutSec = 900
		}
		client, err := script.NewLLMClient(script.LLMConfig{
			BaseURL:     strOr(llmCfg["base_url"], "https://team.lingecho.com/v1"),
			APIKey:      apiKey,
			Model:       strOr(llmCfg["model"], "claude-opus-5.5特价"),
			Temperature: temp,
			MaxTokens:   maxTokens,
			Timeout:     time.Duration(timeoutSec) * time.Second,
		})
		if err != nil {
			scriptError = err.Error()
			p.Emit("log", "剧本生成失败，已保留字幕与提示词包："+scriptError, nil)
		} else {
			skillBytes, _ := os.ReadFile(SkillPath())
			batchSize := asInt(p.Params["batch_size"])
			if batchSize <= 0 {
				batchSize = 1
			}
			gen := &script.Generator{
				Client: client, Skill: string(skillBytes), BatchSize: batchSize,
				Wait: p.waitIfPaused,
				Emit: func(eventType, message string, extra map[string]any) {
					if eventType == "script_progress" {
						batches := asInt(extra["batches"])
						batch := asInt(extra["batch"])
						ratio := 0.0
						if batches > 0 {
							ratio = float64(batch) / float64(batches)
						}
						p.progress("script", ratio, message, map[string]any{
							"script_batch": batch, "script_batches": batches, "current_episode": extra["episode"],
						})
						return
					}
					p.Emit(eventType, message, extra)
				},
			}
			result, err := gen.Generate(workdir, fmt.Sprint(mergeResult["transcript"]))
			if err != nil {
				scriptError = err.Error()
				p.Emit("log", "剧本生成失败，已保留字幕与提示词包："+scriptError, nil)
			} else {
				scriptResult = result
				artifacts = append(artifacts,
					map[string]any{"key": "script_docx", "label": "剧本.docx", "path": result["script_docx"]},
					map[string]any{"key": "setting_docx", "label": "设定.docx", "path": result["setting_docx"]},
					map[string]any{"key": "plan_json", "label": "策划方案 plan.json", "path": result["plan_json"]},
					map[string]any{"key": "meta_json", "label": "设定要点.json", "path": result["meta_json"]},
				)
			}
		}
	} else {
		p.Emit("log", "未填写模型 API Key，本次只产出提示词包与合并字幕。", nil)
	}
	p.progress("done", 1, "全流程完成。", nil)
	var meta any
	if scriptResult != nil {
		meta = scriptResult["meta"]
	}
	return map[string]any{
		"workdir": workdir,
		"series": map[string]any{
			"title": series.Title, "slug": series.Slug, "source_url": series.SourceURL,
			"episode_count": len(series.Episodes),
		},
		"transcript_txt": mergeResult["transcript_path"],
		"series_srt":     mergeResult["srt_path"],
		"prompt_bundle":  mergeResult["prompt_path"],
		"episodes_json":  mergeResult["episodes_json"],
		"script":         scriptResult,
		"script_error":   nilIfEmpty(scriptError),
		"meta":           meta,
		"artifacts":      artifacts,
	}, nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func strOr(v any, fallback string) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "" || s == "<nil>" {
		return fallback
	}
	return s
}

func asInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case float64:
		return int(t)
	case string:
		var n int
		fmt.Sscanf(t, "%d", &n)
		return n
	default:
		var n int
		fmt.Sscanf(fmt.Sprint(v), "%d", &n)
		return n
	}
}

func asFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case string:
		var n float64
		fmt.Sscanf(t, "%f", &n)
		return n
	default:
		var n float64
		fmt.Sscanf(fmt.Sprint(v), "%f", &n)
		return n
	}
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	default:
		s := strings.ToLower(fmt.Sprint(v))
		return s == "true" || s == "1"
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
