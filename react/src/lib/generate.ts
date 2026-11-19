/** 短剧生成工作流客户端：对接 miniseadrama FastAPI（经 Go 后端 /api/v1/ai 代理） */

import { authHeaders } from './api'

export interface GenEpisode {
  title: string
  text: string
}

export interface GenMeta {
  title: string
  enTitle: string
  logline: string
  synopsis: string
  totalEpisodes: number
  language: string
  audience: string
  quality: string
  categories: { main: string; subs: string[] }
  coverPrompt: string
  episodes: GenEpisode[]
}

export interface GenProgress {
  stage?: string
  stage_label?: string
  overall?: number
  total_episodes?: number
  current_episode?: number | null
  downloaded?: number
  transcribed?: number
  script_batch?: number
  script_batches?: number
}

/** /api/inspect 返回的剧目信息，用于开始前核对集数 */
export interface GenEpisodeInfo {
  number: number
  title: string
  duration: number
  qualities: string[]
}

export interface GenSeries {
  title: string
  slug: string
  source_url: string
  episode_count: number
  episodes: GenEpisodeInfo[]
}

export interface GenResult {
  series?: { title: string; episode_count: number }
  meta?: GenMeta | null
  script_error?: string | null
  artifacts?: { key: string; label: string; path: string }[]
}

export interface GenJob {
  id: string
  status: string
  paused?: boolean
  message?: string
  progress?: GenProgress
  result?: GenResult | null
  error?: string | null
}

/** 工作目录里已存在的产物（任务未完成时也能读取） */
export interface ExistingArtifact {
  key: string
  label: string
  size: number
  updated_at: number
}

export interface ExistingOutput {
  workdir: string
  artifacts: ExistingArtifact[]
}

const PREFIX = '/api/v1/ai'

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: string; msg?: string; error?: string; message?: string }
    return data.detail || data.msg || data.error || data.message || `请求失败（${res.status}）`
  } catch {
    return `请求失败（${res.status}）`
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(PREFIX + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    })
  } catch {
    throw new Error('无法连接生成服务，请先启动 miniseadrama（python run.py）')
  }
  if (res.status === 401) throw new Error('登录已失效，请重新登录后再使用生成功能')
  if (!res.ok) throw new Error(await readError(res))
  const payload = (await res.json()) as { code?: number; msg?: string }
  // Go 后端业务错误统一返回 HTTP 200 + {code,msg} 信封，这里还原成真实错误文案
  if (payload && typeof payload.code === 'number' && payload.code !== 200) {
    throw new Error(payload.msg || `请求失败（${payload.code}）`)
  }
  return payload as T
}

/** 开始前识别剧目集数，便于人工核对链接是否正确（Cookie 由后端自动登录获取） */
export async function inspectSeries(url: string): Promise<GenSeries> {
  const data = await json<Partial<GenSeries>>('/inspect', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
  if (!data || !Array.isArray(data.episodes)) {
    throw new Error('识别接口返回格式异常，请确认 Go 后端已重启到最新版本')
  }
  return {
    title: data.title || '',
    slug: data.slug || '',
    source_url: data.source_url || '',
    episode_count: data.episode_count || data.episodes.length,
    episodes: data.episodes,
  }
}

export function startJob(url: string): Promise<GenJob> {
  return json<GenJob>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export function getJob(id: string): Promise<GenJob> {
  return json<GenJob>(`/jobs/${id}`)
}

/** 暂停：在当前安全点（集/批次边界）停下 */
export function pauseJob(id: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(`/jobs/${id}/pause`, { method: 'POST', body: '{}' })
}

/** 继续已暂停的任务 */
export function resumeJob(id: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(`/jobs/${id}/resume`, { method: 'POST', body: '{}' })
}

export async function fetchArtifact(id: string, key: string): Promise<Blob> {
  const res = await fetch(`${PREFIX}/jobs/${id}/files/${key}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(await readError(res))
  const type = res.headers.get('Content-Type') || ''
  if (type.includes('application/json')) {
    throw new Error(await readError(res))
  }
  return res.blob()
}

/** 优先取接口内联的 meta，缺失时回读 meta_json 产物 */
export async function loadMeta(job: GenJob): Promise<GenMeta | null> {
  if (job.result?.meta) return job.result.meta
  const key = job.result?.artifacts?.some((item) => item.key === 'meta_json')
  if (!key) return null
  const blob = await fetchArtifact(job.id, 'meta_json')
  return JSON.parse(await blob.text()) as GenMeta
}

/** 查找该剧工作目录里已生成的产物（不依赖任务是否完成） */
export function findExistingArtifacts(url: string): Promise<ExistingOutput> {
  return json<ExistingOutput>(`/artifacts?url=${encodeURIComponent(url)}`)
}

/** 下载已存在的产物文件 */
export async function fetchExistingArtifact(url: string, key: string): Promise<Blob> {
  const res = await fetch(
    `${PREFIX}/artifacts/file?url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}`,
    { headers: authHeaders() },
  )
  if (res.status === 401) throw new Error('登录已失效，请重新登录后再使用生成功能')
  if (!res.ok) throw new Error(await readError(res))
  return res.blob()
}

/** 用设定里的封面要求调用服务端生图（tt-image-2.5，密钥在 .env），返回 dataURL */
export async function generateCover(prompt: string, title: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${PREFIX}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ prompt: (prompt || '').slice(0, 800), title }),
    })
  } catch {
    throw new Error('无法连接生图接口')
  }
  if (!res.ok) throw new Error(await readError(res))
  const payload = (await res.json()) as { code?: number; msg?: string; data?: { image?: string } }
  if (payload.code !== 200 || !payload.data?.image) {
    throw new Error(payload.msg || '生图接口未返回图片')
  }
  return payload.data.image
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取封面图片失败'))
    reader.readAsDataURL(blob)
  })
}
