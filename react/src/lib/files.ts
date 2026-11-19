import type { Script } from './data'
import { apiUrl, authHeaders } from './api'

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
  if (res.ok) {
    // Go 后端业务错误也返回 200：JSON 响应说明不是文件，按错误提示
    const type = res.headers.get('Content-Type') || ''
    if (type.includes('application/json')) {
      const j = (await res.json().catch(() => null)) as { msg?: string; error?: string } | null
      return toast(j?.msg || j?.error || '该剧本暂时无法下载', 'error')
    }
    const cd = res.headers.get('Content-Disposition') || ''
    let filename = ''
    const m = cd.match(/filename\*=UTF-8''(.+)$/)
    if (m) {
      try { filename = decodeURIComponent(m[1]) } catch { /* ignore */ }
    }
    saveBlob(filename || `${s.title}.docx`, await res.blob())
    return toast(`开始下载 ${filename || s.title}`)
  }
  if (res.status === 401) return toast('请先登录后再下载', 'error')
  if (res.status === 403) return toast('购买后才能下载完整剧本', 'error')
  if (res.status === 404) return toast('该剧本尚未上传 Word 文件，请联系客服获取', 'error')
  toast(`下载失败（${res.status}）`, 'error')
}
