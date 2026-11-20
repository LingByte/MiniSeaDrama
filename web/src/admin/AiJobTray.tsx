import { useEffect, useState } from 'react'
import { Button, Modal, ModalHeader, cn } from '../components/ui'
import { Icon } from '../components/Icon'
import {
  buildHandoffFromJob,
  buildHandoffFromWorkdir,
  loadSavedAiJobs,
  markAiJobFilled,
  persistSavedAiJobs,
  removeSavedAiJob,
  subscribeAiJobs,
  syncAiJobsWithScripts,
  type SavedAiJob,
} from '../lib/aiJobs'
import {
  cancelJob,
  getJob,
  listJobs,
  pauseJob,
  resumeJob,
  type EpisodeSubStatus,
  type GenJob,
} from '../lib/generate'
import { go, useStore } from '../lib/store'

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  lost: '已失效（服务重启）',
}

const STAGES = [
  { key: 'inspect', label: '识别剧集' },
  { key: 'download', label: '下载素材' },
  { key: 'transcribe', label: '字幕准备' },
  { key: 'merge', label: '合并字幕' },
  { key: 'script', label: '生成剧本' },
]

function isFullJob(j: GenJob | { status: string } | undefined): j is GenJob {
  return Boolean(j && 'id' in j)
}

/** 放在「AI 生成」页外侧：跟踪后台任务，点开可看详细进度 */
export function AiJobTray() {
  const { state, toast } = useStore()
  const [tracked, setTracked] = useState<SavedAiJob[]>(() => loadSavedAiJobs())
  const [jobMap, setJobMap] = useState<Record<string, GenJob | { status: 'lost' }>>({})
  const [maxWorkers, setMaxWorkers] = useState(3)
  const [fillingId, setFillingId] = useState('')
  const [synced, setSynced] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pausing, setPausing] = useState(false)

  useEffect(() => subscribeAiJobs(() => setTracked(loadSavedAiJobs())), [])

  // 剧本库里已有同名 → 自动标「已上架」，避免旧任务仍显示填入按钮
  useEffect(() => {
    syncAiJobsWithScripts(state.scripts)
  }, [state.scripts])

  useEffect(() => {
    if (!tracked.length) {
      setSynced(true)
      return
    }
    let alive = true
    const tick = async () => {
      try {
        const remote = await listJobs()
        if (!alive) return
        setMaxWorkers(remote.max_workers || 3)
        const byId = Object.fromEntries(remote.items.map((j) => [j.id, j]))
        const next: Record<string, GenJob | { status: 'lost' }> = {}
        await Promise.all(
          tracked.map(async (t) => {
            if (byId[t.id]) {
              next[t.id] = byId[t.id]
              return
            }
            try {
              next[t.id] = await getJob(t.id)
            } catch {
              next[t.id] = { status: 'lost' }
            }
          }),
        )
        if (!alive) return
        setJobMap(next)
        setSynced(true)
      } catch {
        if (!alive) return
        setJobMap((prev) => {
          const next = { ...prev }
          for (const t of tracked) {
            if (!next[t.id]) next[t.id] = { status: 'lost' }
          }
          return next
        })
        setSynced(true)
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [tracked])

  // 详情面板打开时单独高频拉当前任务，进度更跟手
  useEffect(() => {
    if (!detailId) return
    let alive = true
    const tick = async () => {
      try {
        const j = await getJob(detailId)
        if (!alive) return
        setJobMap((prev) => ({ ...prev, [detailId]: j }))
      } catch {
        if (!alive) return
        setJobMap((prev) => ({ ...prev, [detailId]: { status: 'lost' } }))
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [detailId])

  function refreshTracked() {
    setTracked(loadSavedAiJobs())
  }

  function removeOne(id: string) {
    removeSavedAiJob(id)
    setJobMap((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    if (detailId === id) setDetailId(null)
    refreshTracked()
  }

  function clearAll() {
    persistSavedAiJobs([])
    setJobMap({})
    setDetailId(null)
    refreshTracked()
    toast('已清空任务列表')
  }

  async function fillListing(t: SavedAiJob) {
    if (fillingId || t.listing === 'listed') return
    setFillingId(t.id)
    try {
      toast('正在打包 Word / 封面 / 基本信息 / 标签 / 定价…')
      const j = jobMap[t.id]
      if (isFullJob(j) && j.status === 'completed') {
        await buildHandoffFromJob(j)
      } else {
        await buildHandoffFromWorkdir(t.id, t.url)
      }
      markAiJobFilled(t.id)
      toast('已填好上架表单，请核对后发布')
      go('/manage/scripts/new')
    } catch (e) {
      toast(e instanceof Error ? e.message : '填入上架表单失败', 'error')
    } finally {
      setFillingId('')
    }
  }

  const detailSaved = detailId ? tracked.find((t) => t.id === detailId) : null
  const detailJob = detailId ? jobMap[detailId] : null
  const detailFull = isFullJob(detailJob) ? detailJob : null
  const detailProgress = detailFull?.progress
  const detailStatus = !synced ? '…' : detailJob?.status || 'lost'
  const detailOverall = Math.round(detailProgress?.overall ?? 0)
  const detailStage = detailProgress?.stage || ''
  const detailStageIndex = STAGES.findIndex((s) => s.key === detailStage)
  const detailSubs: EpisodeSubStatus[] = Array.isArray(detailProgress?.episode_subs)
    ? detailProgress!.episode_subs!
    : []
  const detailRunning = detailStatus === 'running' || detailStatus === 'queued'
  const detailDone = detailStatus === 'completed'

  if (!tracked.length) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        还没有后台任务。在下方提交生成后，进度会出现在这里；点任务可查看详细进度，完成后填入上架表单。
      </div>
    )
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">后台生成任务</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              并发上限 {maxWorkers} · 点击任务查看进度 · 完成后填入「上架新剧本」五步表单
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={clearAll}>
            清空列表
          </Button>
        </div>
        <ul className="space-y-2">
          {tracked.map((t) => {
            const j = jobMap[t.id]
            const st = !synced ? '…' : j?.status || 'lost'
            const pct = isFullJob(j) ? Math.round(j.progress?.overall ?? 0) : 0
            const stage = isFullJob(j) ? j.progress?.stage_label || j.message || '' : ''
            const done = st === 'completed'
            const running = st === 'running' || st === 'queued'
            const lost = st === 'lost'
            const listed = t.listing === 'listed'
            const filled = t.listing === 'filled'
            const open = detailId === t.id
            return (
              <li key={t.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailId(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDetailId(t.id)
                    }
                  }}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition',
                    listed && 'border-emerald-200 bg-emerald-50/40',
                    open && !listed && 'border-primary bg-muted/40',
                    !open && !listed && 'border-border bg-background hover:bg-muted/30',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{t.title || t.url}</p>
                      {listed && (
                        <span className="shrink-0 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                          已上架
                        </span>
                      )}
                      {!listed && filled && (
                        <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                          已填入 · 待上架
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {listed
                        ? '已上架到剧本库'
                        : filled
                          ? '已填入上架表单，请在编辑页核对后发布'
                          : `${STATUS_TEXT[st] || st}${running ? ` · ${pct}%` : ''}${stage ? ` · ${stage}` : ''}${lost ? ' · 若磁盘仍有产物可尝试填入' : ''}`}
                      <span className="ml-1 text-primary">查看进度</span>
                    </p>
                    {running && (
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {listed && t.scriptId && (
                      <Button size="sm" variant="secondary" onClick={() => go(`/manage/scripts/edit/${t.scriptId}`)}>
                        查看剧本
                      </Button>
                    )}
                    {(done || lost) && !listed && (
                      <Button size="sm" loading={fillingId === t.id} onClick={() => void fillListing(t)}>
                        <Icon name="upload" size={14} className="mr-1" />
                        {filled ? '再次填入' : lost ? '尝试填入' : '填入上架表单'}
                      </Button>
                    )}
                    {running && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await cancelJob(t.id)
                            setJobMap((prev) => ({
                              ...prev,
                              [t.id]: { ...(prev[t.id] as GenJob), id: t.id, status: 'cancelled' },
                            }))
                            toast('已取消任务')
                          } catch (e) {
                            toast(e instanceof Error ? e.message : '取消失败', 'error')
                          }
                        }}
                      >
                        取消
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => {
                        removeOne(t.id)
                        toast('已移除')
                      }}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <Modal open={!!detailId} onClose={() => setDetailId(null)} width="max-w-2xl">
        <ModalHeader
          title={detailSaved?.title || '任务进度'}
          sub={detailSaved?.url}
          onClose={() => setDetailId(null)}
        />
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn('text-sm font-medium', detailFull?.paused && 'text-amber-700')}>
              {detailFull?.paused ? '已暂停' : STATUS_TEXT[detailStatus] || detailStatus}
              {detailProgress?.stage_label ? ` · ${detailProgress.stage_label}` : ''}
            </span>
            <span className="text-sm font-semibold text-foreground">{detailOverall}%</span>
          </div>

          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', detailDone ? 'bg-emerald-600' : 'bg-primary')}
              style={{ width: `${Math.min(100, Math.max(0, detailOverall))}%` }}
            />
          </div>

          <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[11px]">
            {STAGES.map((item, index) => {
              const done = detailDone || (detailStageIndex >= 0 && index < detailStageIndex)
              const current = !detailDone && index === detailStageIndex
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

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {detailProgress?.total_episodes ? <span>全剧 {detailProgress.total_episodes} 集</span> : null}
            {detailProgress?.current_episode ? <span>当前第 {detailProgress.current_episode} 集</span> : null}
            {detailProgress?.downloaded != null && detailProgress.total_episodes ? (
              <span>
                已下载 {detailProgress.downloaded}/{detailProgress.total_episodes}
              </span>
            ) : null}
            {detailProgress?.transcribed != null && detailProgress.total_episodes ? (
              <span>
                已识别 {detailProgress.transcribed}/{detailProgress.total_episodes}
              </span>
            ) : null}
            {detailProgress?.script_batches ? (
              <span>
                剧本批次 {detailProgress.script_batch ?? 0}/{detailProgress.script_batches}
              </span>
            ) : null}
            {detailFull?.message ? <span className="text-foreground">{detailFull.message}</span> : null}
            {detailFull?.error ? <span className="text-rose-600">{detailFull.error}</span> : null}
          </div>

          {detailSubs.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">分集字幕状态</p>
              <div className="grid max-h-40 grid-cols-6 gap-1 overflow-auto sm:grid-cols-8 lg:grid-cols-10">
                {detailSubs.map((ep) => (
                  <div
                    key={ep.number}
                    title={ep.error || ep.status}
                    className={cn(
                      'rounded-md px-1 py-1.5 text-center text-[10px] font-medium',
                      ep.status === 'ok' && 'bg-emerald-50 text-emerald-700',
                      ep.status === 'fail' && 'bg-rose-50 text-rose-700',
                      ep.status === 'running' && 'bg-muted text-foreground',
                      ep.status !== 'ok' && ep.status !== 'fail' && ep.status !== 'running' && 'bg-muted/60 text-muted-foreground',
                    )}
                  >
                    E{String(ep.number).padStart(2, '0')}
                  </div>
                ))}
              </div>
            </div>
          )}

          {detailProgress?.workdir ? (
            <p className="truncate text-[11px] text-muted-foreground" title={detailProgress.workdir}>
              工作目录：{detailProgress.workdir}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          {detailRunning && detailFull && (
            <Button
              variant="secondary"
              disabled={pausing}
              onClick={async () => {
                if (!detailId) return
                setPausing(true)
                try {
                  if (detailFull.paused) {
                    await resumeJob(detailId)
                    toast('已继续')
                  } else {
                    await pauseJob(detailId)
                    toast('已请求暂停')
                  }
                  const j = await getJob(detailId)
                  setJobMap((prev) => ({ ...prev, [detailId]: j }))
                } catch (e) {
                  toast(e instanceof Error ? e.message : '操作失败', 'error')
                } finally {
                  setPausing(false)
                }
              }}
            >
              <Icon name={detailFull.paused ? 'play' : 'pause'} size={14} className="mr-1.5" />
              {detailFull.paused ? '继续' : '暂停'}
            </Button>
          )}
          {detailRunning && detailId && (
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  await cancelJob(detailId)
                  setJobMap((prev) => ({
                    ...prev,
                    [detailId]: { ...(prev[detailId] as GenJob), id: detailId, status: 'cancelled' },
                  }))
                  toast('已取消')
                } catch (e) {
                  toast(e instanceof Error ? e.message : '取消失败', 'error')
                }
              }}
            >
              取消任务
            </Button>
          )}
          {detailSaved?.listing === 'listed' && detailSaved.scriptId && (
            <Button variant="secondary" onClick={() => go(`/manage/scripts/edit/${detailSaved.scriptId}`)}>
              查看剧本
            </Button>
          )}
          {(detailDone || detailStatus === 'lost') && detailSaved && detailSaved.listing !== 'listed' && (
            <Button loading={fillingId === detailSaved.id} onClick={() => void fillListing(detailSaved)}>
              <Icon name="upload" size={14} className="mr-1.5" />
              {detailSaved.listing === 'filled' ? '再次填入' : '填入上架表单'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setDetailId(null)}>
            关闭
          </Button>
        </div>
      </Modal>
    </>
  )
}
