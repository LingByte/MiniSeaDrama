// Copyright (c) 2026 lingbyte. All rights reserved.

package jobs

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var terminal = map[string]bool{"completed": true, "failed": true, "cancelled": true}

// Emit is the job event callback signature used by the pipeline.
type Emit func(eventType, message string, extra map[string]any)

// Job is an in-memory generation task.
type Job struct {
	ID            string
	Params        map[string]any
	DisplayParams map[string]any
	Status        string
	Message       string
	CreatedAt     float64
	UpdatedAt     float64
	Progress      map[string]any
	Events        []map[string]any
	Result        map[string]any
	Error         string
	Paused        bool
	CancelCh      chan struct{}
	cancelOnce    sync.Once
	pauseMu       sync.Mutex
	pauseSet      bool
	resumeCh      chan struct{}
	seq           int
	mu            sync.Mutex
}

func (j *Job) addEvent(eventType, message string, extra map[string]any) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.seq++
	now := float64(time.Now().UnixNano()) / 1e9
	ev := map[string]any{
		"seq":     j.seq,
		"at":      now,
		"type":    eventType,
		"message": message,
	}
	for k, v := range extra {
		if k == "progress" {
			if m, ok := v.(map[string]any); ok {
				j.Progress = m
				ev["progress"] = m
			}
			continue
		}
		if k == "series" {
			if m, ok := v.(map[string]any); ok {
				j.DisplayParams["series_title"] = m["title"]
				ev["series"] = m
			}
			continue
		}
		ev[k] = v
	}
	j.Events = append(j.Events, ev)
	if len(j.Events) > 3000 {
		j.Events = j.Events[len(j.Events)-3000:]
	}
	if message != "" {
		j.Message = message
	}
	j.UpdatedAt = now
}

// Emit implements the pipeline emit callback.
func (j *Job) Emit(eventType, message string, extra map[string]any) {
	j.addEvent(eventType, message, extra)
}

func (j *Job) IsCancelled() bool {
	select {
	case <-j.CancelCh:
		return true
	default:
		return false
	}
}

func (j *Job) WaitIfPaused() {
	for {
		j.pauseMu.Lock()
		paused := j.pauseSet
		ch := j.resumeCh
		j.pauseMu.Unlock()
		if !paused {
			return
		}
		j.Emit("log", "任务已暂停，等待继续。", nil)
		select {
		case <-ch:
			j.Emit("log", "已继续执行。", nil)
		case <-j.CancelCh:
			return
		}
	}
}

func (j *Job) ToDict(includeEvents bool) map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.pauseMu.Lock()
	paused := j.pauseSet
	j.pauseMu.Unlock()
	payload := map[string]any{
		"id":         j.ID,
		"status":     j.Status,
		"paused":     paused,
		"message":    j.Message,
		"created_at": j.CreatedAt,
		"updated_at": j.UpdatedAt,
		"params":     j.DisplayParams,
		"progress":   j.Progress,
		"result":     j.Result,
		"error":      nilString(j.Error),
		"event_seq":  j.seq,
	}
	if includeEvents {
		payload["events"] = append([]map[string]any(nil), j.Events...)
	}
	return payload
}

// Workdir returns the pipeline working directory from result or progress.
func (j *Job) Workdir() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Result != nil {
		if w, ok := j.Result["workdir"].(string); ok && strings.TrimSpace(w) != "" {
			return w
		}
	}
	if j.Progress != nil {
		if w, ok := j.Progress["workdir"].(string); ok && strings.TrimSpace(w) != "" {
			return w
		}
	}
	return ""
}

// ParamString reads a string param (full params, including secrets like cookie).
func (j *Job) ParamString(key string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Params == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(j.Params[key]))
}

// PatchEpisodeSub updates progress.episode_subs for one episode.
func (j *Job) PatchEpisodeSub(episode int, status, errMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Progress == nil {
		j.Progress = map[string]any{}
	}
	var list []map[string]any
	switch raw := j.Progress["episode_subs"].(type) {
	case []map[string]any:
		list = raw
	case []any:
		for _, item := range raw {
			if m, ok := item.(map[string]any); ok {
				list = append(list, m)
			}
		}
	}
	found := false
	for _, item := range list {
		n := 0
		switch v := item["number"].(type) {
		case int:
			n = v
		case float64:
			n = int(v)
		}
		if n == episode {
			item["status"] = status
			item["error"] = errMsg
			found = true
			break
		}
	}
	if !found {
		list = append(list, map[string]any{"number": episode, "status": status, "error": errMsg})
	}
	j.Progress["episode_subs"] = list
	j.UpdatedAt = float64(time.Now().UnixNano()) / 1e9
}

func nilString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Manager owns the in-memory job queue.
type Manager struct {
	jobs       map[string]*Job
	order      []string
	queue      []string
	mu         sync.Mutex
	active     int // 当前在跑的 worker 数
	maxWorkers int // 并发上限（默认 2，可用 PIPELINE_MAX_WORKERS 覆盖）
}

// Default is the process-wide job manager.
var Default = NewManager()

// DefaultManager is an alias used by HTTP handlers.
var DefaultManager = Default

func NewManager() *Manager {
	n := 3
	if v := strings.TrimSpace(os.Getenv("PIPELINE_MAX_WORKERS")); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			n = parsed
			if n > 8 {
				n = 8
			}
		}
	}
	return &Manager{jobs: map[string]*Job{}, maxWorkers: n}
}

func newID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func displayParams(params map[string]any) map[string]any {
	display := map[string]any{}
	for k, v := range params {
		if k == "cookie" {
			continue
		}
		display[k] = v
	}
	llm, _ := display["llm"].(map[string]any)
	if llm == nil {
		llm = map[string]any{}
	} else {
		copied := map[string]any{}
		for k, v := range llm {
			copied[k] = v
		}
		llm = copied
	}
	if key, _ := llm["api_key"].(string); key != "" {
		llm["api_key"] = "***"
		llm["configured"] = true
	} else {
		llm["configured"] = false
	}
	display["llm"] = llm
	display["has_cookie"] = params["cookie"] != nil && params["cookie"] != ""
	return display
}

// Create enqueues a new job.
func (m *Manager) Create(params map[string]any) *Job {
	now := float64(time.Now().UnixNano()) / 1e9
	job := &Job{
		ID:            newID(),
		Params:        params,
		DisplayParams: displayParams(params),
		Status:        "queued",
		Message:       "排队中",
		CreatedAt:     now,
		UpdatedAt:     now,
		Progress:      map[string]any{},
		CancelCh:      make(chan struct{}),
		resumeCh:      make(chan struct{}),
	}
	m.mu.Lock()
	m.jobs[job.ID] = job
	m.order = append(m.order, job.ID)
	m.queue = append(m.queue, job.ID)
	m.ensureWorkerLocked()
	m.mu.Unlock()
	job.addEvent("queued", "任务已加入队列。", nil)
	return job
}

func (m *Manager) ensureWorkerLocked() {
	if m.maxWorkers < 1 {
		m.maxWorkers = 3
	}
	for m.active < m.maxWorkers && len(m.queue) > 0 {
		m.active++
		go m.workerLoop()
	}
}

func (m *Manager) workerLoop() {
	defer func() {
		m.mu.Lock()
		m.active--
		if m.active < 0 {
			m.active = 0
		}
		// 队列还有任务则补一个 worker
		m.ensureWorkerLocked()
		m.mu.Unlock()
	}()
	for {
		m.mu.Lock()
		var job *Job
		for len(m.queue) > 0 {
			id := m.queue[0]
			m.queue = m.queue[1:]
			candidate := m.jobs[id]
			if candidate != nil && candidate.Status == "queued" {
				job = candidate
				break
			}
		}
		if job == nil {
			m.mu.Unlock()
			return
		}
		job.Status = "running"
		job.addEvent("status", "任务开始。", nil)
		m.mu.Unlock()
		m.run(job)
	}
}

// MaxWorkers 返回当前并发上限。
func (m *Manager) MaxWorkers() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.maxWorkers < 1 {
		return 3
	}
	return m.maxWorkers
}

// Runner is set by the pipeline package to avoid an import cycle.
var Runner func(job *Job) (map[string]any, error)

func (m *Manager) run(job *Job) {
	if Runner == nil {
		job.mu.Lock()
		job.Status = "failed"
		job.Error = "pipeline runner not registered"
		job.mu.Unlock()
		job.addEvent("error", "pipeline runner not registered", nil)
		return
	}
	result, err := Runner(job)
	if err != nil {
		if job.IsCancelled() || strings.Contains(err.Error(), "任务已取消") {
			job.mu.Lock()
			job.Status = "cancelled"
			job.mu.Unlock()
			job.addEvent("cancelled", "任务已取消。", nil)
			return
		}
		job.mu.Lock()
		job.Status = "failed"
		job.Error = err.Error()
		job.mu.Unlock()
		job.addEvent("error", "任务失败："+err.Error(), nil)
		return
	}
	job.mu.Lock()
	job.Status = "completed"
	job.Result = result
	job.mu.Unlock()
	arts, _ := result["artifacts"].([]map[string]any)
	job.addEvent("done", "全流程完成。", map[string]any{
		"result":    result,
		"artifacts": arts,
	})
}

func (m *Manager) Get(id string) *Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

func (m *Manager) List() []map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]map[string]any, 0, len(m.order))
	for i := len(m.order) - 1; i >= 0; i-- {
		if j := m.jobs[m.order[i]]; j != nil {
			out = append(out, j.ToDict(false))
		}
	}
	return out
}

func (m *Manager) EventsSince(job *Job, seq int) []map[string]any {
	job.mu.Lock()
	defer job.mu.Unlock()
	var out []map[string]any
	for _, ev := range job.Events {
		if s, ok := ev["seq"].(int); ok && s > seq {
			out = append(out, ev)
		}
	}
	return out
}

func (m *Manager) Pause(id string) bool {
	job := m.Get(id)
	if job == nil || job.Status != "running" {
		return false
	}
	job.pauseMu.Lock()
	if !job.pauseSet {
		job.pauseSet = true
		job.resumeCh = make(chan struct{})
	}
	job.pauseMu.Unlock()
	job.addEvent("paused", "已暂停：当前步骤结束后停下。", nil)
	return true
}

func (m *Manager) Resume(id string) bool {
	job := m.Get(id)
	if job == nil {
		return false
	}
	job.pauseMu.Lock()
	if job.pauseSet {
		job.pauseSet = false
		close(job.resumeCh)
	}
	job.pauseMu.Unlock()
	job.addEvent("resumed", "已继续。", nil)
	return true
}

func (m *Manager) Cancel(id string) bool {
	job := m.Get(id)
	if job == nil {
		return false
	}
	job.cancelOnce.Do(func() { close(job.CancelCh) })
	if job.Status == "queued" {
		job.mu.Lock()
		job.Status = "cancelled"
		job.mu.Unlock()
		job.addEvent("cancelled", "任务已取消。", nil)
	}
	return true
}

func (m *Manager) IsTerminal(status string) bool {
	return terminal[status]
}
