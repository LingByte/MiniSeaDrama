/** 统一 HTTP 访问层：对接 Go 后端（/api/v1 + Bearer JWT + {code,msg,data} 信封） */
const TOKEN_KEY = 'haiman-token-v1'

/** Go 后端统一前缀 */
const API_PREFIX = '/api/v1'

/** 网络不可达 / 网关 5xx 时的统一文案（登录页与其它接口共用） */
export const SERVER_UNAVAILABLE = '无法连接服务器，请联系管理员'

export class ApiError extends Error {
  status: number
  code: string
  constructor(msg: string, status: number, code = '') {
    super(msg)
    this.status = status
    this.code = code
  }
}

export function isServerUnavailable(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504 || err.message === SERVER_UNAVAILABLE
  }
  return err instanceof Error && err.message === SERVER_UNAVAILABLE
}

function unavailableStatus(status: number) {
  return status === 502 || status === 503 || status === 504 || status === 521 || status === 522
}

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export const setToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export interface ApiOpts {
  method?: string
  body?: unknown
}

/** 登录态失效时清掉本地残留，避免整个站点被一个坏 token 卡死 */
function dropStaleLogin() {
  setToken(null)
  try {
    localStorage.removeItem('haiman-user-v1')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('haiman:auth'))
}

/** 构造带鉴权的 API URL（Go 后端路由前缀 /api/v1） */
export function apiUrl(path: string, method = 'GET') {
  const [p0, q0] = path.split('?')
  const qs = new URLSearchParams(q0 || '')
  // GET 加时间戳，避免中间层缓存登录态 / 列表响应
  if (method === 'GET') qs.set('_t', String(Date.now()))
  return API_PREFIX + p0 + (qs.toString() ? '?' + qs.toString() : '')
}

export function authHeaders(): Record<string, string> {
  const t = getToken()
  if (!t) return {}
  return { Authorization: 'Bearer ' + t }
}

function isAuthPath(path: string) {
  return path.split('?')[0].startsWith('/auth/') || path.split('?')[0] === '/register'
}

export async function api<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders() }
  let res: Response
  try {
    res = await fetch(apiUrl(path, method), {
      method,
      headers,
      cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(SERVER_UNAVAILABLE, 0)
  }

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    /* 非 JSON 响应（常见于网关 502 HTML） */
  }
  const env = (payload ?? {}) as {
    code?: number
    msg?: string
    message?: string
    error?: string
    data?: unknown
  }

  if (!res.ok) {
    if (unavailableStatus(res.status)) {
      throw new ApiError(SERVER_UNAVAILABLE, res.status)
    }
    const msg = env.msg || env.message || env.error || `请求失败（${res.status}）`
    if (res.status === 401 && getToken() && !isAuthPath(path)) dropStaleLogin()
    throw new ApiError(msg, res.status, env.error ?? '')
  }

  // Go 后端业务错误也返回 HTTP 200，成功码是 200（部分老接口用 0），其余为业务错误码
  if (typeof env.code === 'number' && env.code !== 200 && env.code !== 0) {
    if (getToken() && !isAuthPath(path) && (env.code === 401 || env.error === 'unauthorized')) {
      dropStaleLogin()
    }
    throw new ApiError(env.msg || env.message || env.error || '请求失败', res.status, env.error ?? '')
  }

  if (payload && typeof payload === 'object' && 'data' in env) {
    return env.data as T
  }
  return payload as T
}
