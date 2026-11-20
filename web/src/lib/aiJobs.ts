/** AI 生成任务跟踪 + 完成后交给「上架表单」的交接包 */

import { DEFAULT_GROUPS, suggestPrice, type Script } from './data'
import {
  fetchArtifact,
  fetchExistingArtifact,
  findExistingArtifacts,
  generateCover,
  getJob,
  loadMeta,
  type GenJob,
  type GenMeta,
} from './generate'

const JOBS_KEY = 'haiman-ai-jobs-v1'
const HANDOFF_KEY = 'haiman-ai-handoff-v1'
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** listing: filled=已点过填入表单；listed=已成功上架/保存到剧本库 */
export type SavedAiJob = {
  id: string
  url: string
  title?: string
  startedAt: number
  listing?: 'filled' | 'listed'
  filledAt?: number
  listedAt?: number
  scriptId?: string
}

export type AiHandoff = {
  jobId: string
  fields: Partial<Script>
  cover: string
  fileName: string
  fileSize: number
}

const fileCache = new Map<string, File>()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((fn) => fn())
}

export function subscribeAiJobs(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function loadSavedAiJobs(): SavedAiJob[] {
  try {
    const raw = localStorage.getItem(JOBS_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as SavedAiJob[]
    return Array.isArray(list) ? list.filter((j) => j?.id) : []
  } catch {
    return []
  }
}

export function persistSavedAiJobs(list: SavedAiJob[]) {
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(list.slice(0, 30)))
  } catch {
    /* ignore */
  }
  emit()
}

export function upsertSavedAiJob(entry: SavedAiJob) {
  const prev = loadSavedAiJobs()
  persistSavedAiJobs([entry, ...prev.filter((j) => j.id !== entry.id)].slice(0, 30))
}

export function removeSavedAiJob(id: string) {
  persistSavedAiJobs(loadSavedAiJobs().filter((j) => j.id !== id))
  fileCache.delete(id)
}

export function patchSavedAiJob(id: string, patch: Partial<SavedAiJob>) {
  const prev = loadSavedAiJobs()
  const next = prev.map((j) => (j.id === id ? { ...j, ...patch, id: j.id } : j))
  if (!next.some((j) => j.id === id)) return
  persistSavedAiJobs(next)
}

/** 已点「填入上架表单」、跳到编辑页 */
export function markAiJobFilled(jobId: string) {
  if (!jobId) return
  patchSavedAiJob(jobId, { listing: 'filled', filledAt: Date.now() })
}

/** 上架/保存成功后打标，任务列表不再显示「填入上架表单」主按钮 */
export function markAiJobListed(jobId: string, scriptId?: string) {
  if (!jobId) return
  patchSavedAiJob(jobId, {
    listing: 'listed',
    listedAt: Date.now(),
    ...(scriptId ? { scriptId } : {}),
  })
}

/** 用已有剧本库反推：同名剧已在库里则标为已上架（兼容旧任务） */
export function syncAiJobsWithScripts(scripts: { id: string; title?: string; enTitle?: string }[]) {
  if (!scripts.length) return
  const byTitle = new Map<string, string>()
  for (const s of scripts) {
    const t = (s.title || '').trim()
    const e = (s.enTitle || '').trim().toLowerCase()
    if (t) byTitle.set(t, s.id)
    if (e) byTitle.set(e, s.id)
  }
  const prev = loadSavedAiJobs()
  let changed = false
  const next = prev.map((j) => {
    if (j.listing === 'listed') return j
    const title = (j.title || '').trim()
    const sid = (title && byTitle.get(title)) || (title && byTitle.get(title.toLowerCase()))
    if (!sid) return j
    changed = true
    return { ...j, listing: 'listed' as const, listedAt: j.listedAt || Date.now(), scriptId: sid }
  })
  if (changed) persistSavedAiJobs(next)
}

/** meta → 上架表单全部可自动字段（含定价建议） */
export function metaToScriptFields(meta: GenMeta): Partial<Script> {
  const categories = meta.categories ?? { main: '', subs: [] }
  const joined = `${categories.main} ${(categories.subs ?? []).join(' ')}`
  const plot = DEFAULT_GROUPS.find((g) => g.id === 'plot')
  const quality = DEFAULT_GROUPS.find((g) => g.id === 'quality')
  let tags = (plot?.tags ?? []).filter((tag) => joined.includes(tag))
  if (!tags.length) tags = ['豪门', '反转']
  const grade = (meta.quality || '').trim().charAt(0).toUpperCase()
  const qualityTag = quality?.tags.find((tag) => tag.startsWith(grade)) || 'B 良好'
  const episodes = meta.episodes ?? []
  const price = suggestPrice(qualityTag)
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
    saleType: 'wholesale',
    price,
    episodes,
    trialCount: Math.min(3, episodes.length) || 1,
    status: 'draft',
    priceHistory: [{ price, at: new Date().toISOString(), note: 'AI 生成建议定价' }],
  }
}

export function peekHandoffFile(jobId: string): File | undefined {
  return fileCache.get(jobId)
}

export function readHandoff(): (AiHandoff & { file?: File }) | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as AiHandoff
    if (!data?.jobId) return null
    return { ...data, file: fileCache.get(data.jobId) }
  } catch {
    return null
  }
}

export function clearHandoff() {
  try {
    sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    /* ignore */
  }
}

async function packHandoff(opts: {
  jobId: string
  meta: GenMeta
  docx: Blob
  cover?: string
}): Promise<AiHandoff> {
  const fileName = `${opts.meta.enTitle || opts.meta.title || '剧本'}.docx`
  const file = new File([opts.docx], fileName, { type: DOCX_TYPE })
  fileCache.set(opts.jobId, file)
  let cover = opts.cover || ''
  if (!cover) {
    cover = await generateCover(opts.meta.coverPrompt, opts.meta.title, opts.meta.enTitle)
  }
  const fields = metaToScriptFields(opts.meta)
  const handoff: AiHandoff = {
    jobId: opts.jobId,
    fields: { ...fields, cover, fileName, fileSize: file.size },
    cover,
    fileName,
    fileSize: file.size,
  }
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff))
  return handoff
}

/** 从已完成任务打包：Word + 封面 + 基本信息/标签/定价，交给上架页 */
export async function buildHandoffFromJob(
  jobOrId: string | GenJob,
  opts?: { cover?: string },
): Promise<AiHandoff> {
  const job = typeof jobOrId === 'string' ? await getJob(jobOrId) : jobOrId
  if (job.status !== 'completed') {
    throw new Error('任务尚未完成')
  }
  const meta = await loadMeta(job)
  if (!meta) throw new Error(job.result?.script_error || '未返回剧本要点')
  const blob = await fetchArtifact(job.id, 'script_docx')
  return packHandoff({ jobId: job.id, meta, docx: blob, cover: opts?.cover })
}

/** 服务端任务已丢（重启等）时：用工作目录产物 + 剧目链接补救 */
export async function buildHandoffFromWorkdir(jobId: string, url: string, opts?: { cover?: string }): Promise<AiHandoff> {
  if (!url.trim()) throw new Error('缺少剧目链接，无法读取工作目录产物')
  const existing = await findExistingArtifacts(url.trim())
  if (!existing.artifacts.some((a) => a.key === 'script_docx')) {
    throw new Error('工作目录里没有剧本 Word，请重新生成')
  }
  let meta: GenMeta | null = null
  if (existing.artifacts.some((a) => a.key === 'meta_json')) {
    try {
      const blob = await fetchExistingArtifact(url.trim(), 'meta_json')
      meta = JSON.parse(await blob.text()) as GenMeta
    } catch {
      meta = null
    }
  }
  if (!meta) throw new Error('工作目录缺少 meta.json，请重新生成')
  const docx = await fetchExistingArtifact(url.trim(), 'script_docx')
  return packHandoff({ jobId, meta, docx, cover: opts?.cover })
}
