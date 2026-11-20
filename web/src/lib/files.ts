import type { Script } from './data'
import { apiUrl, authHeaders } from './api'

/** 上传封面到对象存储，返回 storage key（入库）与临时访问 URL（展示） */
export async function uploadCoverFile(file: File): Promise<{ key: string; url: string }> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('dir', 'covers')
  const res = await fetch(apiUrl('/files/upload', 'POST'), {
    method: 'POST',
    headers: { ...authHeaders() },
    body: fd,
  })
  const data = (await res.json().catch(() => null)) as
    | { code?: number; msg?: string; data?: { key?: string; publicUrl?: string } }
    | null
  const ok = res.ok && data && (data.code === 200 || data.code === 0 || data.code === 201 || data.code === undefined)
  const key = data?.data?.key
  const url = data?.data?.publicUrl || ''
  if (!ok || !key) {
    throw new Error(data?.msg || `封面上传失败（${res.status}）`)
  }
  return { key, url: url || key }
}

/** 把管理员选中的 Word 文件真实上传到服务器（保存剧本成功后调用） */
export async function saveScriptFile(id: string, file: File): Promise<{ script: Script; fileName: string; fileSize: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', ...authHeaders() }
  const res = await fetch(apiUrl(`/admin/scripts/${encodeURIComponent(id)}/file?filename=${encodeURIComponent(file.name)}`, 'POST'), {
    method: 'POST',
    headers,
    body: file,
  })
  const data = (await res.json().catch(() => null)) as
    | { code?: number; msg?: string; error?: string; data?: unknown }
    | null
  // Go 后端成功码是 200（部分老接口 0），不能当成失败；其余 code 才抛错
  const businessError =
    data && typeof data.code === 'number' && data.code !== 200 && data.code !== 0
  if (!res.ok || businessError) {
    throw new Error(data?.msg || data?.error || `上传失败（${res.status}）`)
  }
  return (data && 'data' in data ? data.data : data) as { script: Script; fileName: string; fileSize: number }
}

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 下载服务器上的真实 Word 文件。
 * 不再生成任何「演示文本版」：没登录 / 没购买 / 管理员没上传文件都给出明确提示。
 */
export async function downloadScript(s: Script, toast: (msg: string, tone?: 'success' | 'info' | 'error') => void) {
  let res: Response
  try {
    res = await fetch(apiUrl(`/scripts/${encodeURIComponent(s.id)}/file`), { headers: authHeaders(), cache: 'no-store' })
  } catch {
    return toast('无法连接服务器，下载失败', 'error')
  }
  if (res.status === 401) return toast('请先登录后再下载', 'error')
  if (res.status === 403) return toast('购买后才能下载完整剧本', 'error')
  if (res.status === 404) return toast('该剧本尚未上传 Word 文件，请联系客服获取', 'error')
  if (!res.ok) return toast(`下载失败（${res.status}）`, 'error')

  const type = res.headers.get('Content-Type') || ''
  // 新协议：签发过期下载链接 { url, expiresAt, fileName }
  if (type.includes('application/json')) {
    const j = (await res.json().catch(() => null)) as {
      code?: number
      msg?: string
      error?: string
      data?: { url?: string; fileName?: string; expiresAt?: string }
    } | null
    if (j && typeof j.code === 'number' && j.code !== 200 && j.code !== 0) {
      return toast(j.msg || j.error || '该剧本暂时无法下载', 'error')
    }
    const payload = (j && 'data' in (j as object) ? j.data : j) as { url?: string; fileName?: string } | null
    if (!payload?.url) return toast(j?.msg || '未拿到下载链接', 'error')
    const a = document.createElement('a')
    a.href = payload.url
    a.download = payload.fileName || `${s.title}.docx`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    return toast(`开始下载 ${payload.fileName || s.title}`)
  }
  // 兼容旧直出文件流
  const cd = res.headers.get('Content-Disposition') || ''
  let filename = ''
  const m = cd.match(/filename\*=UTF-8''(.+)$/)
  if (m) {
    try {
      filename = decodeURIComponent(m[1])
    } catch {
      /* ignore */
    }
  }
  saveBlob(filename || `${s.title}.docx`, await res.blob())
  toast(`开始下载 ${filename || s.title}`)
}
