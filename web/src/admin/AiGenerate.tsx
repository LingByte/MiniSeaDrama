import { useEffect, useRef, useState } from 'react'
import { Button, Field, Modal, ModalHeader, inputCls, cn } from '../components/ui'
import { type Script } from '../lib/data'
import { metaToScriptFields, removeSavedAiJob, upsertSavedAiJob } from '../lib/aiJobs'
import {
  cancelJob,
  fetchAiConfig,
  fetchCatalog,
  fetchEpisodeSubtitle,
  fetchExistingArtifact,
  findExistingArtifacts,
  generateCover,
  getJob,
  inspectSeries,
  listJobs,
  pauseJob,
  resumeJob,
  retryEpisodeSubtitle,
  startJob,
  type AiServerConfig,
  type CatalogItem,
  type EpisodeSubStatus,
  type ExistingOutput,
  type GenJob,
  type GenMeta,
  type GenSeries,
  type SubtitleStatus,
} from '../lib/generate'
import { go, useStore } from '../lib/store'
import { Icon } from '../components/Icon'

interface Props {
  onApply: (payload: { file: File; cover?: string; fields: Partial<Script> }) => void
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function subtitleBadge(status?: SubtitleStatus): { label: string; cls: string } {
  switch (status) {
    case 'soft_en':
      return { label: '有英文字幕', cls: 'bg-emerald-50 text-emerald-700' }
    case 'hard_only':
      return { label: '无英文字幕轨', cls: 'bg-amber-50 text-amber-800' }
    default:
      return { label: '字幕未知', cls: 'bg-muted text-muted-foreground' }
  }
}

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
  const [series, setSeries] = useState<GenSeries | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [job, setJob] = useState<GenJob | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState(false) // 仅「提交创建任务」瞬间，不再锁死整页
  const [maxWorkers, setMaxWorkers] = useState(3)
  const [existing, setExisting] = useState<ExistingOutput | null>(null)
  const [finding, setFinding] = useState(false)
  const [loadingExisting, setLoadingExisting] = useState(false)
  const [coverState, setCoverState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const coverPayload = useRef<{ file: File; meta: GenMeta } | null>(null)
  const [pausing, setPausing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [aiConfig, setAiConfig] = useState<AiServerConfig | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false)
  const [catalogQ, setCatalogQ] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('') // 已提交给服务端的搜索词
  const [catalogCursor, setCatalogCursor] = useState('')
  const [catalogHasMore, setCatalogHasMore] = useState(false)
  const [catalogFilter, setCatalogFilter] = useState<'all' | 'loaded' | 'new' | 'hard_only' | 'soft_en'>('all')
  const [catalogSelected, setCatalogSelected] = useState<string[]>([]) // slug 多选
  const [batchStarting, setBatchStarting] = useState(false)
  const [subViewer, setSubViewer] = useState<{ episode: number; title: string; content: string; error?: string } | null>(null)
  const [subLoading, setSubLoading] = useState(false)
  const [retryingEp, setRetryingEp] = useState(0)
  const timer = useRef<number | null>(null)
  const ticker = useRef<number | null>(null)
  const catalogSearchTimer = useRef<number | null>(null)
  const startedAt = useRef(0)
  const applied = useRef(false)
  const logBox = useRef<HTMLUListElement | null>(null)
  const catalogListRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current)
    if (ticker.current) window.clearInterval(ticker.current)
    if (catalogSearchTimer.current) window.clearTimeout(catalogSearchTimer.current)
  }, [])

  useEffect(() => {
    let alive = true
    void fetchAiConfig()
      .then((cfg) => {
        if (alive) setAiConfig(cfg)
      })
      .catch(() => {
        if (alive) setAiConfig(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // 日志自动滚到最新一条
  useEffect(() => {
    const box = logBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs])

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = null
  }

  const stopTicker = () => {
    if (ticker.current) window.clearInterval(ticker.current)
    ticker.current = null
  }

  // 只轮询「当前关注」的任务进度；任务列表在 AiPage 外侧 AiJobTray
  useEffect(() => {
    if (!job?.id) {
      stop()
      return
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      stop()
      return
    }
    const id = job.id
    const tick = async () => {
      try {
        const next = await getJob(id)
        setJob(next)
        const message = next.message
        if (message && message !== next.progress?.stage_label) {
          setLogs((prev) => (prev[prev.length - 1] === message ? prev : [...prev.slice(-39), message]))
        }
        if (next.status === 'running' || next.status === 'queued') {
          setElapsed(Date.now() - startedAt.current)
        }
        if (next.status === 'completed' && !applied.current) {
          applied.current = true
          toast('生成完成：请到上方「后台生成任务」点「填入上架表单」', 'success')
        }
        if (next.status === 'failed') {
          toast(next.error || '生成失败', 'error')
        }
      } catch {
        /* ignore */
      }
    }
    void tick()
    stop()
    timer.current = window.setInterval(() => void tick(), 1500)
    return () => stop()
  }, [job?.id, job?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void listJobs()
      .then((remote) => setMaxWorkers(remote.max_workers || 3))
      .catch(() => undefined)
  }, [])

  /** 单独生封面（失败后可点「重新生成封面」再调） */
  async function runCoverGeneration(file: File, meta: GenMeta, opts?: { silentOk?: boolean }) {
    coverPayload.current = { file, meta }
    setCoverState('running')
    setLogs((prev) => [...prev.slice(-39), '正在生成海报封面（tt-image-2.5，约 1 分钟）…'])
    try {
      const cover = await generateCover(meta.coverPrompt, meta.title, meta.enTitle)
      onApply({ file, cover, fields: {} })
      setCoverState('done')
      setLogs((prev) => [...prev.slice(-39), '封面已生成并填入'])
      if (!opts?.silentOk) toast('封面已生成并填入第一步')
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : '封面生图失败'
      setCoverState('failed')
      setLogs((prev) => [...prev.slice(-39), '封面生成失败：' + message])
      toast(message + '，可点「重新生成封面」或手动上传', 'error')
      return false
    }
  }

  /** 先回填 Word 与信息，再单独生成封面（生图约 1 分钟，过程可见）——仅「已有产物」路径用 */
  async function applyWithCover(file: File, meta: GenMeta | null) {
    onApply({ file, fields: meta ? metaToScriptFields(meta) : {} })
    setCoverState('idle')
    if (!meta) {
      coverPayload.current = null
      toast('已载入 Word，请手动补全基本信息与封面', 'info')
      return
    }
    const ok = await runCoverGeneration(file, meta, { silentOk: true })
    if (ok) toast('已填入 Word / 封面 / 信息，请到上方任务完成后用「填入上架表单」走完整五步')
  }

  async function handleRetryCover() {
    const payload = coverPayload.current
    if (!payload || coverState === 'running') return
    await runCoverGeneration(payload.file, payload.meta)
  }

  async function loadCatalog(opts?: { force?: boolean; q?: string }) {
    if (catalogLoading) return
    const q = opts?.q ?? catalogQuery
    if (catalog.length && !opts?.force && q === catalogQuery) return
    setCatalogLoading(true)
    try {
      // force/刷新：跳过服务端 data/pipeline/cache/catalog 磁盘缓存
      const page = await fetchCatalog({ q, refresh: Boolean(opts?.force) })
      setCatalog(page.items)
      setCatalogCursor(page.next_cursor || '')
      setCatalogHasMore(page.has_more)
      setCatalogQuery(q)
      if (!page.items.length) toast('短剧库为空，可换个关键词或稍后重试', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载短剧库失败', 'error')
    } finally {
      setCatalogLoading(false)
    }
  }

  async function loadMoreCatalog() {
    if (catalogLoading || catalogLoadingMore || !catalogHasMore || !catalogCursor) return
    setCatalogLoadingMore(true)
    try {
      const page = await fetchCatalog({ cursor: catalogCursor, q: catalogQuery })
      setCatalog((prev) => {
        const seen = new Set(prev.map((item) => item.slug))
        const merged = [...prev]
        for (const item of page.items) {
          if (!seen.has(item.slug)) {
            seen.add(item.slug)
            merged.push(item)
          }
        }
        return merged
      })
      setCatalogCursor(page.next_cursor || '')
      setCatalogHasMore(page.has_more)
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载更多失败', 'error')
    } finally {
      setCatalogLoadingMore(false)
    }
  }

  function openCatalog() {
    setCatalogOpen(true)
    void loadCatalog()
  }

  function closeCatalog() {
    setCatalogOpen(false)
  }

  function toggleCatalogSelect(slug: string) {
    setCatalogSelected((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]))
  }

  function clearCatalogSelection() {
    setCatalogSelected([])
  }

  function onCatalogSearchChange(value: string) {
    setCatalogQ(value)
    if (catalogSearchTimer.current) window.clearTimeout(catalogSearchTimer.current)
    catalogSearchTimer.current = window.setTimeout(() => {
      void loadCatalog({ force: true, q: value.trim() })
    }, 400)
  }

  function onCatalogListScroll() {
    const el = catalogListRef.current
    if (!el || catalogLoadingMore || !catalogHasMore) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void loadMoreCatalog()
    }
  }

  /** 把一部剧填入表单并识别集数（不关抽屉时也可单独用） */
  async function fillCatalogItem(item: CatalogItem, opts?: { close?: boolean }) {
    if (busy || inspecting || batchStarting) return
    if (opts?.close !== false) setCatalogOpen(false)
    setUrl(item.source_url)
    setSeries(null)
    setExisting(null)
    setInspecting(true)
    try {
      const info = await inspectSeries(item.source_url)
      setSeries(info)
      toast(`已选《${info.title}》· ${info.episode_count} 集，核对后可开始生成`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '识别失败', 'error')
    } finally {
      setInspecting(false)
    }
  }

  async function handleBatchStartFromCatalog() {
    if (batchStarting || busy) return
    const picked = catalogSelected
      .map((slug) => catalog.find((item) => item.slug === slug))
      .filter((item): item is CatalogItem => Boolean(item))
    if (!picked.length) return toast('请先勾选要生成的剧', 'error')
    if (picked.length > 100) return toast('一次最多提交 100 部，请分批', 'error')
    const hardN = picked.filter((item) => item.subtitle_status === 'hard_only').length
    if (hardN > 0) {
      toast(`${hardN} 部无英文字幕轨，将走视频+ASR，耗时更长`, 'info')
    }
    setBatchStarting(true)
    let okN = 0
    let failN = 0
    let first: GenJob | null = null
    const now = Date.now()
    try {
      for (const item of picked) {
        try {
          const created = await startJob(item.source_url, { title: item.title })
          upsertSavedAiJob({
            id: created.id,
            url: item.source_url,
            title: item.title,
            startedAt: now,
          })
          okN++
          if (!first) first = created
        } catch {
          failN++
        }
      }
      if (first) {
        applied.current = false
        setJob(first)
        startedAt.current = now
        setElapsed(0)
        stopTicker()
        ticker.current = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 1000)
      }
      setCatalogSelected([])
      setCatalogOpen(false)
      if (okN && !failN) {
        toast(`已提交 ${okN} 部到后台队列（并发最多 ${maxWorkers}）`, 'success')
      } else if (okN) {
        toast(`已提交 ${okN} 部，失败 ${failN} 部`, 'info')
      } else {
        toast(`全部提交失败（${failN}）`, 'error')
      }
    } finally {
      setBatchStarting(false)
    }
  }

  async function handleInspect() {
    if (inspecting || busy) return
    if (!url.trim()) return toast('请填写 ShortFlix 剧目链接', 'error')
    setInspecting(true)
    setSeries(null)
    try {
      const info = await inspectSeries(url.trim())
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
    if (series.subtitle_status === 'hard_only') {
      // 仍允许开始：走 ASR；只提示一次
      toast('该剧无英文字幕轨，将下载视频并用 ASR 转写，耗时更长', 'info')
    }
    applied.current = false
    setLogs([])
    setBusy(true)
    startedAt.current = Date.now()
    setElapsed(0)
    stopTicker()
    ticker.current = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 1000)
    try {
      const created = await startJob(url.trim(), { title: series.title })
      upsertSavedAiJob({
        id: created.id,
        url: url.trim(),
        title: series.title,
        startedAt: startedAt.current,
      })
      setJob(created)
      toast(`已加入后台队列（并发最多 ${maxWorkers} 个）。进度在上方列表，完成后点「填入上架表单」`, 'success')
    } catch (e) {
      stopTicker()
      toast(e instanceof Error ? e.message : '启动失败', 'error')
    } finally {
      setBusy(false)
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

  async function handleCancel() {
    if (!job || cancelling) return
    setCancelOpen(true)
  }

  async function confirmCancel() {
    if (!job || cancelling) return
    setCancelOpen(false)
    setCancelling(true)
    try {
      await cancelJob(job.id)
      setJob({ ...job, status: 'cancelled', message: '任务已取消' })
      toast('已取消生成任务')
    } catch (e) {
      toast(e instanceof Error ? e.message : '取消失败', 'error')
    } finally {
      setCancelling(false)
    }
  }

  function handleClearJob() {
    if (job) removeSavedAiJob(job.id)
    setJob(null)
    setLogs([])
    setCoverState('idle')
    setElapsed(0)
    stopTicker()
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
  const episodeSubs: EpisodeSubStatus[] = Array.isArray(progress?.episode_subs) ? progress!.episode_subs! : []
  const catalogView = catalog.filter((item) => {
    if (catalogFilter === 'loaded' && !item.loaded) return false
    if (catalogFilter === 'new' && item.loaded) return false
    if (catalogFilter === 'hard_only' && item.subtitle_status !== 'hard_only') return false
    if (catalogFilter === 'soft_en' && item.subtitle_status !== 'soft_en') return false
    return true
  })
  const catalogSelectedItems = catalogSelected
    .map((slug) => catalog.find((item) => item.slug === slug))
    .filter((item): item is CatalogItem => Boolean(item))
  const catalogViewSelectedCount = catalogView.filter((item) => catalogSelected.includes(item.slug)).length

  function selectAllCatalogView() {
    setCatalogSelected((prev) => {
      const next = new Set(prev)
      for (const item of catalogView) next.add(item.slug)
      return [...next]
    })
  }

  const jobRunning = Boolean(job && (status === 'running' || status === 'queued'))

  async function openEpisodeSub(ep: EpisodeSubStatus) {
    if (!job) return
    const title =
      ep.status === 'ok'
        ? `第 ${ep.number} 集字幕`
        : ep.status === 'fail'
          ? `第 ${ep.number} 集字幕（失败）`
          : ep.status === 'running'
            ? `正在获取第 ${ep.number} 集字幕`
            : `第 ${ep.number} 集字幕（等待中）`
    if (ep.status === 'fail') {
      setSubViewer({ episode: ep.number, title, content: '', error: ep.error || '下载失败' })
      return
    }
    if (ep.status !== 'ok') {
      setSubViewer({ episode: ep.number, title, content: '', error: ep.status === 'running' ? '仍在下载中，稍后再看' : '尚未开始下载' })
      return
    }
    setSubLoading(true)
    try {
      const r = await fetchEpisodeSubtitle(job.id, ep.number)
      setSubViewer({ episode: ep.number, title, content: r.content || '' })
    } catch (e) {
      setSubViewer({
        episode: ep.number,
        title,
        content: '',
        error: e instanceof Error ? e.message : '读取字幕失败',
      })
    } finally {
      setSubLoading(false)
    }
  }

  async function handleRetryEpisode(episode: number) {
    if (!job || retryingEp) return
    setRetryingEp(episode)
    try {
      const r = await retryEpisodeSubtitle(job.id, episode)
      const next = await getJob(job.id)
      setJob(next)
      if (r.content) {
        setSubViewer({
          episode,
          title: `第 ${episode} 集字幕`,
          content: r.content,
        })
      }
      toast(`第 ${episode} 集字幕已重新获取`, 'success')
    } catch (e) {
      try {
        setJob(await getJob(job.id))
      } catch {
        /* ignore */
      }
      toast(e instanceof Error ? e.message : '重试失败', 'error')
    } finally {
      setRetryingEp(0)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">AI 快速生成（整剧 → Word + 封面 + 基本信息）</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            开始后进后台队列（最多同时 {maxWorkers} 个），可离开本页继续创建下一剧。无英文字幕轨的会走视频+ASR，更慢但可生成。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={openCatalog} disabled={busy}>
            <Icon name="grid" size={15} className="mr-1.5" />
            浏览短剧库
          </Button>
          <Button variant="ghost" onClick={handleFindExisting} disabled={finding || !url.trim()}>
            <Icon name={finding ? 'refresh' : 'history'} size={15} className="mr-1.5" />
            {finding ? '查找中…' : '已有产物'}
          </Button>
          <Button variant="secondary" onClick={handleInspect} disabled={busy || inspecting}>
            <Icon name={inspecting ? 'refresh' : 'search'} size={15} className="mr-1.5" />
            {inspecting ? '识别中…' : '识别集数'}
          </Button>
          {jobRunning && (
            <Button variant="secondary" onClick={handlePauseResume} disabled={pausing || cancelling}>
              <Icon name={job?.paused ? 'play' : 'pause'} size={15} className="mr-1.5" />
              {job?.paused ? '继续' : '暂停'}
            </Button>
          )}
          {jobRunning && (
            <Button variant="ghost" onClick={handleCancel} disabled={cancelling}>
              <Icon name={cancelling ? 'refresh' : 'x'} size={15} className="mr-1.5" />
              {cancelling ? '取消中…' : '取消任务'}
            </Button>
          )}
          {job && (status === 'cancelled' || status === 'failed' || status === 'completed') && (
            <Button variant="ghost" onClick={handleClearJob}>
              <Icon name="trash" size={15} className="mr-1.5" />
              清除当前
            </Button>
          )}
          {isDone && (
            <Button variant="secondary" onClick={() => go('/manage/ai')}>
              <Icon name="upload" size={15} className="mr-1.5" />
              去填入上架表单
            </Button>
          )}
          <Button onClick={handleStart} disabled={busy || inspecting || !series}>
            <Icon name={busy ? 'refresh' : 'sparkle'} size={15} className="mr-1.5" />
            {busy ? '提交中…' : '开始生成'}
          </Button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="ShortFlix 剧目链接" required>
            <div className="flex gap-2">
              <input
                className={cn(inputCls, 'min-w-0 flex-1')}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setSeries(null)
                  setExisting(null)
                }}
                placeholder="https://www.shortflix.net/videos/剧名/episode-1"
                disabled={inspecting}
              />
              <Button type="button" variant="secondary" className="shrink-0" onClick={openCatalog}>
                <Icon name="grid" size={15} />
              </Button>
            </div>
          </Field>
        </div>
        <Field label="模型 API Base">
          <input
            className={inputCls}
            value={aiConfig?.base_url || '加载中…'}
            disabled
            title={aiConfig?.base_url}
          />
        </Field>
        <Field label="模型名称">
          <input
            className={inputCls}
            value={
              aiConfig
                ? `${aiConfig.text_model}${aiConfig.image_model ? ` · 生图 ${aiConfig.image_model}` : ''}`
                : '加载中…'
            }
            disabled
            title={
              aiConfig
                ? `文本 ${aiConfig.text_model}${aiConfig.image_model ? ` / 生图 ${aiConfig.image_model}` : ''}`
                : undefined
            }
          />
        </Field>
      </div>

      {existing && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">工作目录里已有产物</p>
            <span className="text-xs text-muted-foreground">直接读取磁盘文件，不依赖任务是否完成</span>
          </div>
          <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            {existing.artifacts.map((item) => (
              <li key={item.key} className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-2 py-1.5">
                <span className="truncate">{item.label}</span>
                <span className="shrink-0 text-muted-foreground">
                  {new Date(item.updated_at * 1000).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="max-w-full truncate text-[11px] text-muted-foreground" title={existing.workdir}>
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
            'flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs',
            coverState === 'failed'
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-border bg-card text-muted-foreground',
          )}
        >
          <Icon
            name={coverState === 'running' ? 'refresh' : coverState === 'done' ? 'check' : 'info'}
            size={14}
          />
          <span className="min-w-0 flex-1">
            {coverState === 'running'
              ? '正在生成竖版 3:4 封面（tt-image-2.5，约 1 分钟，请勿关闭页面）…'
              : coverState === 'done'
                ? '封面已生成并填入第一步'
                : '封面生成失败，可重新生成或手动上传'}
          </span>
          {(coverState === 'failed' || coverState === 'done') && coverPayload.current && (
            <Button size="sm" variant="secondary" onClick={handleRetryCover} disabled={coverState === 'running'}>
              <Icon name="sparkle" size={14} className="mr-1.5" />
              {coverState === 'failed' ? '重新生成封面' : '再生成一张'}
            </Button>
          )}
        </div>
      )}

      {series && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              已识别《{series.title}》
              <span className="ml-2 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                共 {series.episode_count} 集
              </span>
              <span
                className={cn(
                  'ml-2 rounded-md px-2 py-0.5 text-xs font-medium',
                  subtitleBadge(series.subtitle_status).cls,
                )}
              >
                {subtitleBadge(series.subtitle_status).label}
              </span>
            </p>
            <span className="text-xs text-muted-foreground">若集数不对，请检查链接是否正确</span>
          </div>
          {series.subtitle_note ? (
            <p className="mt-2 text-xs text-muted-foreground">{series.subtitle_note}</p>
          ) : null}
          <div className="mt-3 grid max-h-40 grid-cols-4 gap-1.5 overflow-auto pr-1 sm:grid-cols-6 lg:grid-cols-8">
            {series.episodes.map((episode) => (
              <div
                key={episode.number}
                title={`${episode.title || `第 ${episode.number} 集`}${episode.duration ? ` · ${fmtDuration(episode.duration)}` : ''}`}
                className="rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-center text-[11px] leading-tight"
              >
                <span className="block font-medium text-foreground">第 {episode.number} 集</span>
                {episode.duration ? (
                  <span className="block text-muted-foreground">{fmtDuration(episode.duration)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {job && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn('text-sm font-medium', job.paused && 'text-amber-700')}>
              {job.paused ? '已暂停' : STATUS_TEXT[status] ?? status}
              {progress?.stage_label && !isDone ? ` · ${progress.stage_label}` : ''}
            </span>
            <span className="flex items-center gap-3 text-xs text-muted-foreground">
              {busy && (
                <span className={cn('inline-flex items-center gap-1', job.paused && 'text-amber-700')}>
                  <Icon name={job.paused ? 'pause' : 'clock'} size={13} />
                  {job.paused ? '暂停中' : fmtElapsed(elapsed)}
                </span>
              )}
              <span className="text-sm font-semibold text-foreground">{Math.round(overall)}%</span>
            </span>
          </div>

          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', isDone ? 'bg-emerald-600' : 'bg-primary')}
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
                      'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium',
                      done && 'bg-emerald-50 text-emerald-700',
                      current && 'bg-muted text-foreground',
                      !done && !current && 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'grid h-4 w-4 place-items-center rounded-full text-[9px]',
                        done && 'bg-emerald-600 text-white',
                        current && 'bg-primary text-primary-foreground',
                        !done && !current && 'bg-muted text-muted-foreground',
                      )}
                    >
                      {done ? <Icon name="check" size={9} stroke={3} /> : index + 1}
                    </span>
                    {item.label}
                  </span>
                  {index < STAGES.length - 1 && <span className="mx-0.5 h-px w-3 bg-border" />}
                </li>
              )
            })}
          </ol>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
            {job.message && <span className="text-foreground">{job.message}</span>}
          </div>

          {logs.length > 0 && (
            <ul ref={logBox} className="mt-2 max-h-32 space-y-1 overflow-auto rounded-lg border border-border bg-muted/50 p-2 text-xs text-muted-foreground">
              {logs.map((item, index) => (
                <li key={`${index}-${item}`} className="truncate" title={item}>
                  {item}
                </li>
              ))}
            </ul>
          )}

          {episodeSubs.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground">
                分集字幕（可点击查看；失败可重试）
              </p>
              <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-auto sm:grid-cols-3 md:grid-cols-4">
                {episodeSubs.map((ep) => {
                  const tone =
                    ep.status === 'ok'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : ep.status === 'fail'
                        ? 'border-rose-200 bg-rose-50 text-rose-800'
                        : ep.status === 'running'
                          ? 'border-amber-200 bg-amber-50 text-amber-900'
                          : 'border-border bg-muted/40 text-muted-foreground'
                  const label =
                    ep.status === 'ok'
                      ? `第 ${ep.number} 集 · 已就绪`
                      : ep.status === 'fail'
                        ? `第 ${ep.number} 集 · 失败`
                        : ep.status === 'running'
                          ? `正在获取第 ${ep.number} 集字幕`
                          : `第 ${ep.number} 集 · 等待`
                  return (
                    <div key={ep.number} className={cn('rounded-lg border px-2 py-1.5', tone)}>
                      <button
                        type="button"
                        className="w-full text-left text-[11px] font-medium leading-snug hover:underline"
                        onClick={() => void openEpisodeSub(ep)}
                        title={ep.error || label}
                      >
                        {label}
                      </button>
                      {ep.status === 'fail' && (
                        <button
                          type="button"
                          className="mt-1 text-[10px] font-medium text-rose-700 hover:underline disabled:opacity-50"
                          disabled={retryingEp === ep.number}
                          onClick={() => void handleRetryEpisode(ep.number)}
                        >
                          {retryingEp === ep.number ? '重试中…' : '重试获取'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <Modal open={cancelOpen} onClose={() => !cancelling && setCancelOpen(false)} width="max-w-sm">
        <ModalHeader title="取消生成任务" onClose={() => !cancelling && setCancelOpen(false)} />
        <div className="px-5 py-4 text-sm text-muted-foreground">
          确定取消当前生成任务？已下载的字幕/素材会留在工作目录，可之后用「已有产物」载入。
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" onClick={() => setCancelOpen(false)} disabled={cancelling}>
            再想想
          </Button>
          <Button variant="danger" onClick={confirmCancel} disabled={cancelling}>
            {cancelling ? '取消中…' : '确认取消'}
          </Button>
        </div>
      </Modal>

      <Modal open={!!subViewer || subLoading} onClose={() => !subLoading && setSubViewer(null)} width="max-w-2xl">
        <ModalHeader
          title={subLoading ? '读取字幕…' : subViewer?.title || '字幕'}
          sub={subViewer?.error ? subViewer.error : subViewer ? `E${String(subViewer.episode).padStart(3, '0')}` : ''}
          onClose={() => !subLoading && setSubViewer(null)}
        />
        <div className="max-h-[60vh] overflow-auto p-4">
          {subLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">正在加载中</p>
          ) : subViewer?.error && !subViewer.content ? (
            <div className="space-y-3">
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{subViewer.error}</p>
              {job && (
                <Button
                  size="sm"
                  loading={retryingEp === subViewer.episode}
                  onClick={() => void handleRetryEpisode(subViewer.episode)}
                >
                  重试获取第 {subViewer.episode} 集
                </Button>
              )}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-foreground">
              {subViewer?.content || '（空）'}
            </pre>
          )}
        </div>
      </Modal>

      {!job && !series && (
        <p className="text-xs text-muted-foreground">
          提示：点「浏览短剧库」可多选批量生成；或填链接后点「识别集数」再单部生成。
        </p>
      )}

      <Modal open={catalogOpen} onClose={closeCatalog} side>
        <ModalHeader
          title="浏览短剧库"
          sub={`已加载 ${catalog.length} 部 · 勾选后可批量生成`}
          onClose={closeCatalog}
        />
        <div className="flex h-[calc(100%-57px)] flex-col">
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex gap-2">
              <input
                className={cn(inputCls, 'h-9 min-w-0 flex-1 text-sm')}
                value={catalogQ}
                onChange={(e) => onCatalogSearchChange(e.target.value)}
                placeholder="搜索剧名（服务端）"
              />
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                onClick={() => void loadCatalog({ force: true, q: catalogQ.trim() })}
                disabled={catalogLoading}
              >
                <Icon name="refresh" size={13} className={cn('mr-1', catalogLoading && 'animate-spin')} />
                {catalogLoading ? '加载中' : '刷新'}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['all', '全部'],
                  ['new', '未载入'],
                  ['loaded', '已载入'],
                  ['soft_en', '有英文字幕轨'],
                  ['hard_only', '无英文字幕轨'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCatalogFilter(key)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                    catalogFilter === key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                disabled={!catalogView.length}
                onClick={selectAllCatalogView}
              >
                全选当前列表
              </button>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                disabled={!catalogSelected.length}
                onClick={clearCatalogSelection}
              >
                清空勾选
              </button>
              <span className="ml-auto">
                已选 {catalogSelectedItems.length}
                {catalogViewSelectedCount !== catalogSelectedItems.length
                  ? `（本页 ${catalogViewSelectedCount}）`
                  : ''}
              </span>
            </div>
          </div>
          <div
            ref={catalogListRef}
            onScroll={onCatalogListScroll}
            className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
          >
            {catalogLoading && !catalog.length && (
              <p className="py-10 text-center text-xs text-muted-foreground">正在拉取 ShortFlix 剧目…</p>
            )}
            {!catalogLoading && !catalog.length && (
              <p className="py-10 text-center text-xs text-muted-foreground">暂无剧目，可换关键词或点刷新</p>
            )}
            {catalogView.map((item) => {
              const selected = catalogSelected.includes(item.slug)
              const inForm = url.includes(item.slug)
              return (
                <div
                  key={item.slug}
                  className={cn(
                    'flex w-full gap-2.5 rounded-xl border p-2.5 transition',
                    selected ? 'border-primary bg-muted/40' : inForm ? 'border-primary/40 bg-muted/20' : 'border-border bg-background',
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={selected ? `取消选择 ${item.title}` : `选择 ${item.title}`}
                    disabled={batchStarting}
                    onClick={() => toggleCatalogSelect(item.slug)}
                    className={cn(
                      'mt-1 grid h-5 w-5 shrink-0 place-items-center rounded border transition',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-transparent hover:border-primary/60',
                    )}
                  >
                    <Icon name="check" size={12} />
                  </button>
                  <button
                    type="button"
                    disabled={busy || inspecting || batchStarting}
                    onClick={() => toggleCatalogSelect(item.slug)}
                    className="flex min-w-0 flex-1 gap-3 text-left disabled:opacity-60"
                  >
                    {item.cover ? (
                      <img
                        src={item.cover}
                        alt=""
                        className="h-[72px] w-[54px] shrink-0 rounded-lg object-cover bg-muted"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="grid h-[72px] w-[54px] shrink-0 place-items-center rounded-lg bg-muted text-[10px] text-muted-foreground">
                        无封面
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{item.title}</span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            item.loaded ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {item.loaded ? '已载入' : '未载入'}
                        </span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', subtitleBadge(item.subtitle_status).cls)}>
                          {subtitleBadge(item.subtitle_status).label}
                        </span>
                        {item.view_count ? (
                          <span className="text-[10px] text-muted-foreground">{item.view_count} 次观看</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    title="填入表单并识别集数"
                    disabled={busy || inspecting || batchStarting}
                    onClick={() => void fillCatalogItem(item)}
                    className="mt-0.5 shrink-0 self-start rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    填入
                  </button>
                </div>
              )
            })}
            {catalog.length > 0 && catalogView.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">当前筛选下没有剧目</p>
            )}
            {catalogHasMore && (
              <button
                type="button"
                onClick={() => void loadMoreCatalog()}
                disabled={catalogLoadingMore}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-3 text-xs text-muted-foreground transition hover:bg-muted/50"
              >
                <Icon name="refresh" size={13} className={cn(catalogLoadingMore && 'animate-spin')} />
                {catalogLoadingMore ? '加载中…' : '加载更多'}
              </button>
            )}
            {!catalogHasMore && catalog.length > 0 && (
              <p className="py-3 text-center text-[11px] text-muted-foreground">已加载全部可浏览结果</p>
            )}
          </div>
          <div className="shrink-0 border-t border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="min-w-0 flex-1"
                disabled={!catalogSelectedItems.length || batchStarting || busy}
                onClick={() => void handleBatchStartFromCatalog()}
              >
                <Icon name={batchStarting ? 'refresh' : 'sparkle'} size={15} className={cn('mr-1.5', batchStarting && 'animate-spin')} />
                {batchStarting
                  ? '提交中…'
                  : catalogSelectedItems.length
                    ? `批量生成 ${catalogSelectedItems.length} 部`
                    : '批量生成'}
              </Button>
              <Button
                variant="secondary"
                disabled={catalogSelectedItems.length !== 1 || inspecting || batchStarting || busy}
                onClick={() => {
                  const only = catalogSelectedItems[0]
                  if (only) void fillCatalogItem(only)
                }}
              >
                填入核对
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              勾选多部后点批量生成，会全部丢进后台队列（同时最多跑 {maxWorkers} 个）。单部可点右侧「填入」先核对集数。
            </p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
