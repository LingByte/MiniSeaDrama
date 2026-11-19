import { useEffect, useRef, useState } from 'react'
import { Button, Field, inputCls, cn } from '../components/ui'
import { DEFAULT_GROUPS, type Script } from '../lib/data'
import {
  fetchArtifact,
  fetchExistingArtifact,
  findExistingArtifacts,
  generateCover,
  getJob,
  inspectSeries,
  loadMeta,
  pauseJob,
  resumeJob,
  startJob,
  type ExistingOutput,
  type GenJob,
  type GenMeta,
  type GenSeries,
} from '../lib/generate'
import { useStore } from '../lib/store'
import { Icon } from '../components/Icon'

interface Props {
  onApply: (payload: { file: File; cover?: string; fields: Partial<Script> }) => void
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** 任务信息存 sessionStorage：页面刷新 / 热更新后仍能恢复进度并在完成时回填 */
const JOB_KEY = 'haiman-ai-job-v1'
type SavedJob = { id: string; url: string; cookie: string; startedAt: number }

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 与 miniseadrama pipeline 的 STAGE_ORDER / STAGE_WEIGHTS 保持一致 */
const STAGES = [
  { key: 'inspect', label: '识别剧集', weight: 3 },
  { key: 'download', label: '下载素材', weight: 37 },
  { key: 'transcribe', label: '字幕准备', weight: 38 },
  { key: 'merge', label: '合并字幕', weight: 5 },
  { key: 'script', label: '生成剧本', weight: 17 },
]

/** 把生成结果映射成管理端表单字段，人工只需再填定价 */
function toFields(meta: GenMeta): Partial<Script> {
  const categories = meta.categories ?? { main: '', subs: [] }
  const joined = `${categories.main} ${(categories.subs ?? []).join(' ')}`
  const plot = DEFAULT_GROUPS.find((g) => g.id === 'plot')
  const quality = DEFAULT_GROUPS.find((g) => g.id === 'quality')
  let tags = (plot?.tags ?? []).filter((tag) => joined.includes(tag))
  if (!tags.length) tags = ['豪门', '反转']
  const grade = (meta.quality || '').trim().charAt(0).toUpperCase()
  const qualityTag = quality?.tags.find((tag) => tag.startsWith(grade)) || 'B 良好'
  const episodes = meta.episodes ?? []
  return {
    title: meta.title,
    enTitle: meta.enTitle,
    logline: meta.logline,
    synopsis: meta.synopsis,
    totalEpisodes: meta.totalEpisodes || episodes.length || 1,
    language: '英语',
    audience: meta.audience === '男频' ? '男频' : '女频',
    tags,
    markets: ['北美'],
    quality: qualityTag,
    episodes,
    trialCount: Math.min(3, episodes.length) || 1,
  }
}

function fmtDuration(seconds: number): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m} 分 ${String(s).padStart(2, '0')} 秒`
}

export function AiGenerate({ onApply }: Props) {
  const { toast } = useStore()
  const [url, setUrl] = useState('')
  const [cookie, setCookie] = useState('')
  const [series, setSeries] = useState<GenSeries | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [job, setJob] = useState<GenJob | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [existing, setExisting] = useState<ExistingOutput | null>(null)
  const [finding, setFinding] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [coverState, setCoverState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [pausing, setPausing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const timer = useRef<number | null>(null)
  const ticker = useRef<number | null>(null)
  const startedAt = useRef(0)
  const applied = useRef(false)
  const logBox = useRef<HTMLUListElement | null>(null)

  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current)
    if (ticker.current) window.clearInterval(ticker.current)
  }, [])

  // 日志自动滚到最新一条
  useEffect(() => {
    const box = logBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs])

  // 刷新 / 热更新后恢复任务：运行中继续轮询，已完成则直接回填 Word、封面与信息
  useEffect(() => {
    const raw = sessionStorage.getItem(JOB_KEY)
    if (!raw) return
    let saved: SavedJob
    try {
      saved = JSON.parse(raw) as SavedJob
    } catch {
      sessionStorage.removeItem(JOB_KEY)
      return
    }
    if (!saved?.id) return
    setUrl(saved.url || '')
    setCookie(saved.cookie || '')
    startedAt.current = saved.startedAt || Date.now()
    setElapsed(Date.now() - startedAt.current)
    setBusy(true)
    stopTicker()
    ticker.current = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 1000)
    void (async () => {
      try {
        const next = await getJob(saved.id)
        setJob(next)
        if (next.status === 'completed') {
          applied.current = true
          await finish(next)
        } else if (next.status === 'running' || next.status === 'queued') {
          poll(saved.id)
        } else {
          sessionStorage.removeItem(JOB_KEY)
          stopTicker()
          setBusy(false)
        }
      } catch {
        sessionStorage.removeItem(JOB_KEY)
        stopTicker()
        setBusy(false)
      }
    })()
  }, [])

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = null
  }

  const stopTicker = () => {
    if (ticker.current) window.clearInterval(ticker.current)
    ticker.current = null
  }

  /** 先回填 Word 与信息，再单独生成封面（生图约 1 分钟，过程可见） */
  async function applyWithCover(file: File, meta: GenMeta | null) {
    onApply({ file, fields: meta ? toFields(meta) : {} })
    setCoverState('idle')
    if (!meta) {
      toast('已载入 Word，请手动补全基本信息与封面', 'info')
      return
    }
    setCoverState('running')
    setLogs((prev) => [...prev.slice(-39), '正在生成海报封面（tt-image-2.5，约 1 分钟）…'])
    try {
      const cover = await generateCover(meta.coverPrompt, meta.title)
      onApply({ file, cover, fields: {} })
      setCoverState('done')
      setLogs((prev) => [...prev.slice(-39), '封面已生成并填入'])
      toast('剧本 Word、封面与基本信息已就绪，请核对后填写定价')
    } catch (e) {
      const message = e instanceof Error ? e.message : '封面生图失败'
      setCoverState('failed')
      setLogs((prev) => [...prev.slice(-39), '封面生成失败：' + message])
      toast('Word 与信息已填入，但' + message + '，请手动上传封面', 'error')
    }
  }

  async function finish(current: GenJob) {
    stop()
    stopTicker()
    try {
      const meta = await loadMeta(current)
      if (!meta) throw new Error(current.result?.script_error || '未返回剧本要点，请检查模型配置')
      const blob = await fetchArtifact(current.id, 'script_docx')
      const file = new File([blob], `${meta.enTitle || meta.title || '剧本'}.docx`, {
        type: DOCX_TYPE,
      })
      await applyWithCover(file, meta)
      sessionStorage.removeItem(JOB_KEY)
    } catch (e) {
      toast(e instanceof Error ? e.message : '生成结果读取失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  function poll(id: string) {
    stop()
    timer.current = window.setInterval(async () => {
      try {
        const next = await getJob(id)
        setJob(next)
        const message = next.message
        if (message && message !== next.progress?.stage_label) {
          setLogs((prev) => (prev[prev.length - 1] === message ? prev : [...prev.slice(-39), message]))
        }
        if (next.status === 'completed' && !applied.current) {
          applied.current = true
          await finish(next)
        }
        if (next.status === 'failed') {
          stop()
          stopTicker()
          setBusy(false)
          toast(next.error || '生成失败', 'error')
        }
        if (next.status === 'cancelled') {
          stop()
          stopTicker()
          setBusy(false)
        }
      } catch (e) {
        stop()
        stopTicker()
        setBusy(false)
        toast(e instanceof Error ? e.message : '进度查询失败', 'error')
      }
    }, 1000)
  }

  async function handleInspect() {
    if (inspecting || busy) return
    if (!url.trim()) return toast('请填写 ShortFlix 剧目链接', 'error')
    setInspecting(true)
    setSeries(null)
    try {
      const info = await inspectSeries({ url: url.trim(), cookie: cookie.trim() })
      setSeries(info)
      toast(`《${info.title}》共识别到 ${info.episode_count} 集，请核对`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '识别失败', 'error')
    } finally {
      setInspecting(false)
    }
  }

  async function handleStart() {
    if (busy) return
    if (!url.trim()) return toast('请填写 ShortFlix 剧目链接', 'error')
    if (!series) return toast('请先点击「识别集数」核对集数', 'error')
    applied.current = false
    setLogs([])
    setJob(null)
    setBusy(true)
    startedAt.current = Date.now()
    setElapsed(0)
    stopTicker()
    ticker.current = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 1000)
    try {
      const created = await startJob({
        url: url.trim(),
        cookie: cookie.trim(),
      })
      setJob(created)
      sessionStorage.setItem(
        JOB_KEY,
        JSON.stringify({ id: created.id, url: url.trim(), cookie: cookie.trim(), startedAt: startedAt.current }),
      )
      poll(created.id)
    } catch (e) {
      setBusy(false)
      stopTicker()
      toast(e instanceof Error ? e.message : '启动失败', 'error')
    }
  }

  async function handlePauseResume() {
    if (!job || pausing) return
    setPausing(true)
    try {
      if (job.paused) {
        await resumeJob(job.id)
        setJob({ ...job, paused: false })
        toast('已继续生成')
      } else {
        await pauseJob(job.id)
        setJob({ ...job, paused: true })
        toast('已请求暂停，当前步骤（集 / 批次）结束后停下')
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error')
    } finally {
      setPausing(false)
    }
  }

  /** 直接查工作目录里已有的产物，不依赖任务是否完成 */
  async function handleFindExisting() {
    if (finding) return
    if (!url.trim()) return toast('请填写 ShortFlix 剧目链接', 'error')
    setFinding(true)
    setExisting(null)
    try {
      const info = await findExistingArtifacts(url.trim())
      setExisting(info)
      toast(`找到 ${info.artifacts.length} 个已有产物，可核对后直接载入`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '查找已有产物失败', 'error')
    } finally {
      setFinding(false)
    }
  }

  async function handleLoadExisting() {
    if (!existing || loadingExisting) return
    if (!existing.artifacts.some((item) => item.key === 'script_docx')) {
      return toast('该目录里没有 剧本.docx', 'error')
    }
    setLoadingExisting(true)
    try {
      let meta: GenMeta | null = null
      if (existing.artifacts.some((item) => item.key === 'meta_json')) {
        try {
          const metaBlob = await fetchExistingArtifact(url.trim(), 'meta_json')
          meta = JSON.parse(await metaBlob.text()) as GenMeta
        } catch {
          meta = null
        }
      }
      const blob = await fetchExistingArtifact(url.trim(), 'script_docx')
      const file = new File([blob], `${meta?.enTitle || meta?.title || '剧本'}.docx`, { type: DOCX_TYPE })
      setLoadingExisting(false)
      setExisting(null)
      await applyWithCover(file, meta)
    } catch (e) {
      toast(e instanceof Error ? e.message : '载入已有产物失败', 'error')
    } finally {
      setLoadingExisting(false)
    }
  }

  const progress = job?.progress
  const overall = progress?.overall ?? 0
  const status = job?.status ?? ''
  const activeStage = progress?.stage ?? (job ? 'inspect' : '')
  const activeIndex = STAGES.findIndex((item) => item.key === activeStage)
  const totalEpisodes = progress?.total_episodes || series?.episode_count || 0
  const isDone = status === 'completed'

  return (
    <div className="mb-8 rounded-2xl border border-brand-100 bg-brand-50/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">AI 快速生成（整剧 → Word + 封面 + 基本信息）</h3>
          <p className="mt-1 text-xs text-ink-500">
            先识别集数核对无误，再开始生成；过程中可实时查看下载到第几集、字幕识别进度与剧本批次。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={handleFindExisting} disabled={finding || !url.trim()}>
            <Icon name={finding ? 'refresh' : 'history'} size={15} className="mr-1.5" />
            {finding ? '查找中…' : '已有产物'}
          </Button>
          <Button variant="secondary" onClick={handleInspect} disabled={busy || inspecting}>
            <Icon name={inspecting ? 'refresh' : 'search'} size={15} className="mr-1.5" />
            {inspecting ? '识别中…' : '识别集数'}
          </Button>
          {busy && job && (
            <Button variant="secondary" onClick={handlePauseResume} disabled={pausing}>
              <Icon name={job.paused ? 'play' : 'pause'} size={15} className="mr-1.5" />
              {job.paused ? '继续' : '暂停'}
            </Button>
          )}
          <Button onClick={handleStart} disabled={busy || inspecting || !series}>
            <Icon name={busy ? 'refresh' : 'sparkle'} size={15} className="mr-1.5" />
            {busy ? '生成中…' : '开始生成'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="ShortFlix 剧目链接" required>
            <input
              className={inputCls}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setSeries(null)
                setExisting(null)
              }}
              placeholder="https://www.shortflix.net/videos/剧名/episode-1"
              disabled={busy || inspecting}
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Cookie（锁定剧集时需要）" hint="从浏览器开发者工具复制 Cookie 头，仅本次使用">
            <textarea
              rows={2}
              className={cn(inputCls, 'h-auto py-2 text-xs leading-relaxed')}
              value={cookie}
              onChange={(e) => {
                setCookie(e.target.value)
                setSeries(null)
                setExisting(null)
              }}
              placeholder="__Secure-better-auth.session_token=...;"
              disabled={busy || inspecting}
            />
          </Field>
        </div>
        <Field label="模型 API Base">
          <input className={inputCls} value="由服务端 .env 配置" disabled />
        </Field>
        <Field label="模型名称">
          <input className={inputCls} value="由服务端 .env 配置（含 tt-image-2.5 生图）" disabled />
        </Field>
      </div>

      {existing && (
        <div className="mt-4 rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">工作目录里已有产物</p>
            <span className="text-xs text-ink-400">直接读取磁盘文件，不依赖任务是否完成</span>
          </div>
          <ul className="mt-2 grid gap-1 text-xs text-ink-600 sm:grid-cols-2">
            {existing.artifacts.map((item) => (
              <li key={item.key} className="flex items-center justify-between gap-2 rounded-lg bg-ink-50/60 px-2 py-1.5">
                <span className="truncate">{item.label}</span>
                <span className="shrink-0 text-ink-400">
                  {new Date(item.updated_at * 1000).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="max-w-full truncate text-[11px] text-ink-400" title={existing.workdir}>
              {existing.workdir}
            </span>
            <Button size="sm" onClick={handleLoadExisting} disabled={loadingExisting}>
              <Icon name={loadingExisting ? 'refresh' : 'download'} size={14} className="mr-1.5" />
              {loadingExisting ? '载入中…' : '载入 Word + 信息'}
            </Button>
          </div>
        </div>
      )}

      {coverState !== 'idle' && (
        <div
          className={cn(
            'mt-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs',
            coverState === 'failed'
              ? 'border-rose-200 bg-rose-50 text-rose-600'
              : 'border-brand-100 bg-white text-ink-600',
          )}
        >
          <Icon
            name={coverState === 'running' ? 'refresh' : coverState === 'done' ? 'check' : 'info'}
            size={14}
          />
          {coverState === 'running'
            ? '正在生成竖版 3:4 封面（tt-image-2.5，约 1 分钟，请勿关闭页面）…'
            : coverState === 'done'
              ? '封面已生成并填入第一步'
              : '封面生成失败，可点「已有产物」重新载入或手动上传'}
        </div>
      )}

      {series && (
        <div className="mt-4 rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              已识别《{series.title}》
              <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                共 {series.episode_count} 集
              </span>
            </p>
            <span className="text-xs text-ink-400">若集数不对，请检查链接与 Cookie</span>
          </div>
          <div className="mt-3 grid max-h-40 grid-cols-4 gap-1.5 overflow-auto pr-1 sm:grid-cols-6 lg:grid-cols-8">
            {series.episodes.map((episode) => (
              <div
                key={episode.number}
                title={`${episode.title || `第 ${episode.number} 集`}${episode.duration ? ` · ${fmtDuration(episode.duration)}` : ''}`}
                className="rounded-lg border border-line bg-ink-50/40 px-2 py-1.5 text-center text-[11px] leading-tight"
              >
                <span className="block font-semibold text-ink-700">第 {episode.number} 集</span>
                {episode.duration ? (
                  <span className="block text-ink-400">{fmtDuration(episode.duration)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {job && (
        <div className="mt-4 rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn('text-sm font-medium', job.paused && 'text-amber-600')}>
              {job.paused ? '已暂停' : STATUS_TEXT[status] ?? status}
              {progress?.stage_label && !isDone ? ` · ${progress.stage_label}` : ''}
            </span>
            <span className="flex items-center gap-3 text-xs text-ink-500">
              {busy && (
                <span className={cn('inline-flex items-center gap-1', job.paused && 'text-amber-600')}>
                  <Icon name={job.paused ? 'pause' : 'clock'} size={13} />
                  {job.paused ? '暂停中' : fmtElapsed(elapsed)}
                </span>
              )}
              <span className="text-sm font-semibold text-ink-800">{Math.round(overall)}%</span>
            </span>
          </div>

          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn('h-full rounded-full transition-all duration-500', isDone ? 'bg-emerald-500' : 'bg-brand-600')}
              style={{ width: `${Math.min(100, Math.max(0, overall))}%` }}
            />
          </div>

          <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 text-[11px]">
            {STAGES.map((item, index) => {
              const done = isDone || (activeIndex >= 0 && index < activeIndex)
              const current = !isDone && index === activeIndex
              return (
                <li key={item.key} className="flex items-center">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium',
                      done && 'bg-emerald-50 text-emerald-700',
                      current && 'bg-brand-50 text-brand-700',
                      !done && !current && 'text-ink-400',
                    )}
                  >
                    <span
                      className={cn(
                        'grid h-4 w-4 place-items-center rounded-full text-[9px]',
                        done && 'bg-emerald-500 text-white',
                        current && 'bg-brand-600 text-white',
                        !done && !current && 'bg-ink-100 text-ink-400',
                      )}
                    >
                      {done ? <Icon name="check" size={9} stroke={3} /> : index + 1}
                    </span>
                    {item.label}
                  </span>
                  {index < STAGES.length - 1 && <span className="mx-0.5 h-px w-3 bg-line" />}
                </li>
              )
            })}
          </ol>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
            {totalEpisodes > 0 && <span>全剧 {totalEpisodes} 集</span>}
            {progress?.current_episode ? <span>当前第 {progress.current_episode} 集</span> : null}
            {progress?.stage === 'download' && progress.downloaded != null && totalEpisodes > 0 && (
              <span>已下载 {progress.downloaded}/{totalEpisodes}</span>
            )}
            {progress?.stage === 'transcribe' && progress.transcribed != null && totalEpisodes > 0 && (
              <span>已识别 {progress.transcribed}/{totalEpisodes}</span>
            )}
            {progress?.script_batches ? (
              <span>剧本批次 {progress.script_batch ?? 0}/{progress.script_batches}</span>
            ) : null}
            {job.message && <span className="text-ink-600">{job.message}</span>}
          </div>

          {logs.length > 0 && (
            <ul ref={logBox} className="mt-2 max-h-32 space-y-1 overflow-auto rounded-lg bg-ink-50/60 p-2 text-xs text-ink-500">
              {logs.map((item, index) => (
                <li key={`${index}-${item}`} className="truncate" title={item}>
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!job && !series && (
        <p className="mt-3 text-xs text-ink-400">
          提示：点击「识别集数」会先抓取剧目页确认总集数与每集时长，确认无误后再开始生成。
        </p>
      )}
    </div>
  )
}
