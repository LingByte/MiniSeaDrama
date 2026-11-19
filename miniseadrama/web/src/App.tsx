import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  Defaults,
  JobEvent,
  JobResult,
  JobSummary,
  ProgressState,
  SeriesInfo,
} from "./types";

const STORAGE_KEY = "minisea.form.v3";

interface FormState {
  url: string;
  cookie: string;
  ffmpeg: string;
  outputRoot: string;
  engine: string;
  workers: number;
  batchSize: number;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const DEFAULT_FORM: FormState = {
  url: "",
  cookie: "",
  ffmpeg: "",
  outputRoot: "",
  engine: "bcut",
  workers: 3,
  batchSize: 3,
  baseUrl: "https://team.lingecho.com/v1",
  model: "claude-opus-5.5特价",
  apiKey: "",
};

const PRESETS = [
  {
    label: "LingEcho 疯马（Claude Opus 5.5）",
    baseUrl: "https://team.lingecho.com/v1",
    model: "claude-opus-5.5特价",
  },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
];

const STAGES = [
  { key: "inspect", label: "识别剧集" },
  { key: "download", label: "下载素材" },
  { key: "transcribe", label: "字幕准备" },
  { key: "merge", label: "合并字幕" },
  { key: "script", label: "生成剧本" },
];

const STATUS_TEXT: Record<string, string> = {
  idle: "待开始",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function loadStoredForm(): FormState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_FORM, ...(JSON.parse(raw) as Partial<FormState>) };
    }
  } catch {
    // 本地缓存损坏时退回默认值
  }
  return DEFAULT_FORM;
}

export default function App() {
  const [form, setForm] = useState<FormState>(loadStoredForm);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [logs, setLogs] = useState<JobEvent[]>([]);
  const [result, setResult] = useState<JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [copied, setCopied] = useState(false);

  const streamRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const busy = status === "queued" || status === "running";
  const canStart = form.url.trim().length > 0;

  const loadJobs = useCallback(async () => {
    try {
      const data = await api<{ items: JobSummary[] }>("/api/jobs");
      setJobs(data.items);
    } catch {
      // 历史记录失败不影响主流程
    }
  }, []);

  useEffect(() => {
    const persisted: Partial<FormState> = { ...form };
    delete persisted.apiKey;
    delete persisted.cookie;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }, [form]);

  useEffect(() => {
    api<Defaults>("/api/health")
      .then((data) => {
        setDefaults(data);
        setForm((prev) => ({
          ...prev,
          ffmpeg: prev.ffmpeg || data.ffmpeg_path || "",
          outputRoot: prev.outputRoot || data.output_root,
          engine: prev.engine || data.default_engine,
        }));
      })
      .catch((exc) => setError(errorText(exc)));
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    const box = logBoxRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
    };
  }, []);

  function closeStream() {
    streamRef.current?.close();
    streamRef.current = null;
  }

  function handleEvent(event: JobEvent, source: EventSource) {
    if (event.type === "progress" && event.progress) {
      setProgress(event.progress);
    }
    if (event.type === "series" && event.series) {
      setSeries(event.series);
    }
    if (event.type === "log" || event.type === "queued" || event.type === "status") {
      setLogs((prev) => [...prev.slice(-299), event]);
    }
    if (event.type === "done") {
      setStatus("completed");
      if (event.result) {
        setResult(event.result);
      }
      source.close();
      streamRef.current = null;
      loadJobs();
    }
    if (event.type === "error") {
      setStatus("failed");
      setError(event.message);
      source.close();
      streamRef.current = null;
      loadJobs();
    }
    if (event.type === "cancelled") {
      setStatus("cancelled");
      source.close();
      streamRef.current = null;
      loadJobs();
    }
  }

  function subscribe(id: string) {
    closeStream();
    const source = new EventSource(`/api/jobs/${id}/events?after=0`);
    streamRef.current = source;
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as JobEvent;
        handleEvent(event, source);
      } catch {
        // 忽略心跳和非 JSON 数据
      }
    };
  }

  function update(patch: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function handleInspect() {
    if (!canStart || inspecting) {
      return;
    }
    setInspecting(true);
    setError(null);
    setSeries(null);
    try {
      const data = await api<SeriesInfo>("/api/inspect", {
        method: "POST",
        body: JSON.stringify({
          url: form.url.trim(),
          cookie: form.cookie,
        }),
      });
      setSeries(data);
    } catch (exc) {
      setError(errorText(exc));
    } finally {
      setInspecting(false);
    }
  }

  async function handleStart() {
    if (!canStart || busy) {
      return;
    }
    setError(null);
    setResult(null);
    setLogs([]);
    setProgress(null);
    setSeries(null);
    setStatus("queued");
    try {
      const job = await api<JobSummary>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          url: form.url.trim(),
          cookie: form.cookie,
          engine: form.engine,
          workers: form.workers,
          batch_size: form.batchSize,
          ffmpeg: form.ffmpeg,
          output_root: form.outputRoot,
          llm: {
            base_url: form.baseUrl,
            api_key: form.apiKey,
            model: form.model,
            temperature: 0.8,
            max_tokens: 8192,
          },
        }),
      });
      setJobId(job.id);
      setStatus(job.status);
      subscribe(job.id);
      loadJobs();
    } catch (exc) {
      setStatus("idle");
      setError(errorText(exc));
    }
  }

  async function handleCancel() {
    if (!jobId) {
      return;
    }
    try {
      await api(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    } catch (exc) {
      setError(errorText(exc));
    }
  }

  async function openJob(id: string) {
    closeStream();
    try {
      const detail = await api<JobSummary>(`/api/jobs/${id}`);
      setJobId(id);
      setStatus(detail.status);
      setProgress(detail.progress);
      setResult(detail.result);
      setSeries(null);
      setLogs([]);
      setError(detail.error);
      if (detail.status === "queued" || detail.status === "running") {
        subscribe(id);
      }
    } catch (exc) {
      setError(errorText(exc));
    }
  }

  async function copyPath(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动选择路径。");
    }
  }

  const stageIndex = useMemo(() => {
    if (!progress) {
      return -1;
    }
    return STAGES.findIndex((item) => item.key === progress.stage);
  }, [progress]);

  const overall = status === "completed" ? 100 : progress?.overall ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">MS</div>
          <div>
            <h1>MiniSeaDrama</h1>
            <p>短剧下载 · 英文字幕提取 · 全剧字幕合并 · 剧本生成</p>
          </div>
        </div>
        <div className={`status-pill status-${status}`}>
          <span className="dot" />
          {STATUS_TEXT[status] ?? status}
        </div>
      </header>

      {error && (
        <div className="banner error">
          <strong>出错了</strong>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      {defaults && !defaults.skill_present && (
        <div className="banner warn">
          <strong>缺少 Skill 文件</strong>
          <span>skills 目录下没有找到至简海漫 Skills V1.4 文档。</span>
        </div>
      )}

      <main className="layout">
        <section className="panel">
          <div className="card">
            <div className="card-head">
              <h2>一、剧目与下载</h2>
              <span className="muted">ShortFlix 整剧</span>
            </div>

            <label className="field">
              <span>剧目链接</span>
              <input
                value={form.url}
                onChange={(event) => update({ url: event.target.value })}
                placeholder="https://www.shortflix.net/videos/..."
              />
            </label>

            <label className="field">
              <span>
                Ｃookie <em>登录态，仅本次运行使用</em>
              </span>
              <textarea
                value={form.cookie}
                onChange={(event) => update({ cookie: event.target.value })}
                rows={3}
                placeholder="粘贴 Cookie 字符串、Netscape cookies.txt 或扩展导出的 JSON"
              />
            </label>

            <details className="cookie-help">
              <summary>怎么拿到 Cookie？</summary>
              <ol>
                <li>在 Chrome / Edge 登录 ShortFlix，打开任意剧集页。</li>
                <li>按 F12 打开开发者工具，切到 Network，刷新页面。</li>
                <li>点第一个 document 请求，在 Request Headers 里找到 cookie。</li>
                <li>整行复制粘贴到上面。HttpOnly Cookie 读不到 document.cookie，必须走 Network 面板。</li>
              </ol>
            </details>

            <label className="field">
              <span>输出目录</span>
              <input
                value={form.outputRoot}
                onChange={(event) => update({ outputRoot: event.target.value })}
                placeholder="默认 data/works"
              />
            </label>

            <div className="actions">
              <button
                type="button"
                className="btn ghost"
                onClick={handleInspect}
                disabled={inspecting || !canStart}
              >
                {inspecting ? "识别中…" : "识别剧集"}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={handleStart}
                disabled={busy || !canStart}
              >
                {busy ? "运行中…" : "开始全流程"}
              </button>
              {busy && (
                <button type="button" className="btn danger" onClick={handleCancel}>
                  取消
                </button>
              )}
            </div>

            <p className="hint">
              优先下载站内独立英文字幕；某几集没有字幕文件（硬字幕剧）时，
              自动下载这几集视频并用内置语音识别补齐英文台词。未登录通常只能访问前几集，完整剧集需要 Cookie。
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>二、剧本模型</h2>
              <span className="muted">OpenAI 兼容接口</span>
            </div>

            <div className="preset-row">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="chip"
                  onClick={() =>
                    update({ baseUrl: preset.baseUrl, model: preset.model })
                  }
                >
                  {preset.label}
                </button>
              ))}
              <span className="chip muted-chip">自定义直接改下方字段</span>
            </div>

            <label className="field">
              <span>接口地址</span>
              <input
                value={form.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
                placeholder="https://api.deepseek.com/v1"
              />
            </label>

            <div className="grid-2">
              <label className="field">
                <span>模型名称</span>
                <input
                  value={form.model}
                  onChange={(event) => update({ model: event.target.value })}
                  placeholder="deepseek-chat"
                />
              </label>
              <label className="field">
                <span>每批写几集</span>
                <select
                  value={form.batchSize}
                  onChange={(event) => update({ batchSize: Number(event.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6].map((value) => (
                    <option key={value} value={value}>
                      {value} 集
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              <span>
                API Key <em>不落盘，只存在当前浏览器与任务内存</em>
              </span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => update({ apiKey: event.target.value })}
                placeholder="留空则只产出提示词包"
              />
            </label>
          </div>

          <div className="card history">
            <div className="card-head">
              <h2>历史任务</h2>
              <button type="button" className="link" onClick={loadJobs}>
                刷新
              </button>
            </div>
            {jobs.length === 0 && <p className="muted">还没有任务。</p>}
            {jobs.slice(0, 8).map((job) => (
              <button
                key={job.id}
                type="button"
                className={`history-item ${job.id === jobId ? "active" : ""}`}
                onClick={() => openJob(job.id)}
              >
                <span className={`badge badge-${job.status}`}>
                  {STATUS_TEXT[job.status] ?? job.status}
                </span>
                <span className="history-title">
                  {String(
                    (job.params.series_title as string) ||
                      (job.params.url as string) ||
                      job.id
                  )}
                </span>
                <span className="history-time">
                  {new Date(job.created_at * 1000).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          {series && (
            <div className="card">
              <div className="card-head">
                <h2>{series.title}</h2>
                <span className="muted">{series.episode_count} 集</span>
              </div>
              <div className="episode-strip">
                {series.episodes.map((episode) => (
                  <span key={episode.number} className="episode-chip">
                    E{String(episode.number).padStart(3, "0")}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h2>流程进度</h2>
              <span className="muted">{progress?.stage_label ?? STATUS_TEXT[status]}</span>
            </div>

            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${overall}%` }} />
            </div>
            <div className="progress-meta">
              <strong>{overall.toFixed(0)}%</strong>
              <span>{progress?.stage_label ?? (busy ? "准备中…" : "等待开始")}</span>
            </div>

            <div className="stages">
              {STAGES.map((stage, index) => {
                const done =
                  status === "completed" ||
                  progress?.stage === "done" ||
                  (stageIndex >= 0 && index < stageIndex);
                const active = stageIndex >= 0 && index === stageIndex && status !== "completed";
                return (
                  <div
                    key={stage.key}
                    className={`stage ${done ? "done" : ""} ${active ? "active" : ""}`}
                  >
                    <span className="stage-index">{done ? "✓" : index + 1}</span>
                    <span>{stage.label}</span>
                  </div>
                );
              })}
            </div>

            <div className="stats">
              <div>
                <span>总集数</span>
                <strong>{progress?.total_episodes || series?.episode_count || "—"}</strong>
              </div>
              <div>
                <span>已下载</span>
                <strong>{progress?.downloaded ?? 0}</strong>
              </div>
              <div>
                <span>已识别</span>
                <strong>{progress?.transcribed ?? 0}</strong>
              </div>
              <div>
                <span>当前集</span>
                <strong>
                  {progress?.current_episode
                    ? `E${String(progress.current_episode).padStart(3, "0")}`
                    : "—"}
                </strong>
              </div>
            </div>

            <div className="log-head">
              <span>运行日志</span>
              <span className="muted">{logs.length} 条</span>
            </div>
            <div className="log-box" ref={logBoxRef}>
              {logs.length === 0 && <p className="muted">等待任务开始。</p>}
              {logs.map((event) => (
                <div key={`${event.seq}-${event.type}`} className={`log-line log-${event.type}`}>
                  <time>
                    {new Date(event.at * 1000).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          </div>

          {result && (
            <div className="card">
              <div className="card-head">
                <h2>交付文件</h2>
                <span className="muted">工作目录</span>
              </div>
              <div className="path-box">
                <code>{result.workdir}</code>
                <button type="button" className="link" onClick={() => copyPath(result.workdir)}>
                  {copied ? "已复制" : "复制"}
                </button>
              </div>

              {result.script && (
                <div className="script-summary">
                  <div>
                    <span>中文剧名</span>
                    <strong>{result.script.title_cn || "—"}</strong>
                  </div>
                  <div>
                    <span>英文剧名</span>
                    <strong>{result.script.title_en || "—"}</strong>
                  </div>
                  <div>
                    <span>集数</span>
                    <strong>{result.script.episode_count || "—"}</strong>
                  </div>
                  <div>
                    <span>品质评级</span>
                    <strong>
                      {result.script.rating
                        ? `${result.script.rating.grade} ${result.script.rating.score ?? ""}`
                        : "—"}
                    </strong>
                  </div>
                </div>
              )}

              <div className="artifacts">
                {result.artifacts.map((artifact) => (
                  <a
                    key={artifact.key}
                    className="artifact"
                    href={`/api/jobs/${jobId}/files/${artifact.key}`}
                    download
                  >
                    <span className="artifact-name">{artifact.label}</span>
                    <span className="artifact-path">{artifact.path}</span>
                  </a>
                ))}
              </div>

              {!result.script && (
                <p className="hint">
                  本次没有生成剧本，可以把「一键投喂.md」直接交给智能体，或回到上方填写 API Key 后重跑。
                </p>
              )}
              {result.script_error && (
                <p className="hint error-text">剧本生成失败：{result.script_error}</p>
              )}
            </div>
          )}

          <div className="card tips">
            <div className="card-head">
              <h2>工作流说明</h2>
            </div>
            <ol>
              <li>已下载好的剧，把「素材来源」切到本地目录，扫描后会自动挑出每集的英文字幕轨。</li>
              <li>在线剧目粘贴链接与 Cookie，先点「识别剧集」确认集数与权限。</li>
              <li>默认「自动」：有独立英文字幕轨就只下字幕；硬字幕剧才下载视频跑 ASR。</li>
              <li>字幕做滚动去重、按句合并后拼成全剧 SRT 与台词稿，再生成一键投喂包和两个 Word。</li>
            </ol>
          </div>
        </section>
      </main>
    </div>
  );
}
