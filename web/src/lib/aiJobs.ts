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
const DISMISSED_KEY = 'haiman-ai-jobs-dismissed-v1'
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
    localStorage.setItem(JOBS_KEY, JSON.stringify(list.slice(0, 100)))
  } catch {
    /* ignore */
  }
  emit()
}

const TITLE_BY_URL_KEY = 'haiman-ai-title-by-url-v1'

function isHttpUrl(v: string) {
  return /^https?:\/\//i.test(v.trim())
}

function loadTitleByUrl(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TITLE_BY_URL_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as Record<string, string>
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function rememberTitleByUrl(url: string, title: string) {
  const u = url.trim()
  const t = title.trim()
  if (!u || !t || isHttpUrl(t)) return
  try {
    const map = loadTitleByUrl()
    if (map[u] === t) return
    map[u] = t
    const keys = Object.keys(map)
    if (keys.length > 300) {
      for (const k of keys.slice(0, keys.length - 300)) delete map[k]
    }
    localStorage.setItem(TITLE_BY_URL_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

/** 列表展示用：优先真人剧名，避免直接甩整段 ShortFlix 链接 */
export function jobDisplayTitle(job: { title?: string; url?: string; id?: string }) {
  const title = (job.title || '').trim()
  if (title && !isHttpUrl(title)) return title
  const url = (job.url || (isHttpUrl(title) ? title : '') || '').trim()
  if (url) {
    const remembered = loadTitleByUrl()[url]
    if (remembered) return remembered
    const m = url.match(/\/videos\/([^/?#]+)/i)
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }
  }
  return title || job.id || '未命名任务'
}

function loadDismissedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Set()
    const list = JSON.parse(raw) as string[]
    return new Set(Array.isArray(list) ? list.filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

function persistDismissedIds(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    /* ignore */
  }
}

/** 用户主动移除 / 清空后，避免轮询又从服务端灌回 */
export function dismissAiJobs(ids: string[]) {
  if (!ids.length) return
  const set = loadDismissedIds()
  for (const id of ids) if (id) set.add(id)
  persistDismissedIds(set)
}

function undismissAiJob(id: string) {
  const set = loadDismissedIds()
  if (!set.delete(id)) return
  persistDismissedIds(set)
}

export function upsertSavedAiJob(entry: SavedAiJob) {
  if (entry.url && entry.title) rememberTitleByUrl(entry.url, entry.title)
  undismissAiJob(entry.id)
  const prev = loadSavedAiJobs()
  persistSavedAiJobs([entry, ...prev.filter((j) => j.id !== entry.id)].slice(0, 100))
}

/** 把服务端任务列表并入本地跟踪（补回 localStorage 曾被裁掉的条目） */
export function mergeRemoteAiJobs(
  remote: Array<{
    id: string
    status?: string
    created_at?: number
    params?: { url?: string; series_title?: string; [k: string]: unknown }
    result?: { series?: { title?: string } } | null
  }>,
): SavedAiJob[] {
  const prev = loadSavedAiJobs()
  const dismissed = loadDismissedIds()
  const titleByUrl = loadTitleByUrl()
  for (const j of prev) {
    if (j.url && j.title && !isHttpUrl(j.title)) titleByUrl[j.url] = j.title
  }
  const byId = new Map(prev.map((j) => [j.id, { ...j }]))
  let changed = false
  for (const job of remote) {
    if (!job?.id) continue
    if (dismissed.has(job.id)) continue
    const url = String(job.params?.url || '').trim()
    let title = String(job.params?.series_title || job.result?.series?.title || '').trim()
    if (isHttpUrl(title)) title = ''
    if (!title && url && titleByUrl[url]) title = titleByUrl[url]
    const startedAt = job.created_at ? Math.round(job.created_at * 1000) : Date.now()
    const cur = byId.get(job.id)
    if (!cur) {
      // 只自动补回排队/运行中的，避免清空后又把历史任务灌回来
      const st = String(job.status || '')
      if (st !== 'running' && st !== 'queued') continue
      byId.set(job.id, { id: job.id, url, title, startedAt })
      changed = true
      continue
    }
    if (title && title !== cur.title) {
      cur.title = title
      changed = true
    } else if ((!cur.title || isHttpUrl(cur.title)) && titleByUrl[cur.url || url]) {
      cur.title = titleByUrl[cur.url || url]
      changed = true
    }
    if (url && !cur.url) {
      cur.url = url
      changed = true
    }
  }
  // 服务端顺序（新→旧）优先，本地独有的跟在后面
  const ordered: SavedAiJob[] = []
  const seen = new Set<string>()
  for (const job of remote) {
    const row = byId.get(job.id)
    if (!row || seen.has(job.id)) continue
    ordered.push(row)
    seen.add(job.id)
  }
  for (const row of prev) {
    if (seen.has(row.id)) continue
    ordered.push(byId.get(row.id) || row)
    seen.add(row.id)
  }
  const next = ordered.slice(0, 100)
  if (changed || next.length !== prev.length || next.some((j, i) => j.id !== prev[i]?.id)) {
    persistSavedAiJobs(next)
  }
  return next
}

export function removeSavedAiJob(id: string) {
  dismissAiJobs([id])
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
  // 禁止回落成统一的「豪门+反转」；没匹配时用更中性的默认，便于后台二审改
  if (!tags.length) tags = ['爽文', '逆袭']
  const grade = (meta.quality || '').trim().charAt(0).toUpperCase()
  const qualityTag = quality?.tags.find((tag) => tag.startsWith(grade)) || 'C 基础'
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
