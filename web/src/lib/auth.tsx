import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, setToken, getToken } from './api'

export interface Me {
  email: string
  role: 'buyer' | 'admin'
  username?: string
  /** 展示用签名 URL */
  avatar?: string
  /** 对象存储 key */
  avatarKey?: string
}

const USER_KEY = 'haiman-user-v1'

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const readUser = (): Me | null => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null')
  } catch {
    return null
  }
}

const persistUser = (u: Me | null) => {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u))
    else localStorage.removeItem(USER_KEY)
  } catch {
    /* ignore */
  }
}

interface Auth {
  user: Me | null
  /** 成功返回 null，失败返回错误文案 */
  register: (email: string, pw: string) => Promise<string | null>
  login: (email: string, pw: string) => Promise<string | null>
  logout: () => void
  /** 刷新 /me（头像等） */
  refreshMe: () => Promise<void>
  /** 更新头像 key 并刷新展示 URL */
  setAvatar: (key: string, previewUrl?: string) => Promise<string | null>
}
const Ctx = createContext<Auth | null>(null)

/** 登录/登出后通知 store 刷新订单数据 */
const fireAuthChange = () => window.dispatchEvent(new CustomEvent('haiman:auth'))

function mapMe(r: { email?: string; role?: string; username?: string; avatar?: string; avatarKey?: string }, fallbackEmail = ''): Me {
  return {
    email: (r.email || fallbackEmail).toLowerCase(),
    role: r.role === 'admin' ? 'admin' : 'buyer',
    username: r.username,
    avatar: r.avatar || undefined,
    avatarKey: r.avatarKey || undefined,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(() => (getToken() ? readUser() : null))

  const start = (u: Me, token: string) => {
    setToken(token)
    persistUser(u)
    setUser(u)
    fireAuthChange()
  }

  const refreshMe = useCallback(async () => {
    if (!getToken()) return
    try {
      const r = await api<{ email: string; role?: string; username?: string; avatar?: string; avatarKey?: string }>('/me')
      const next = mapMe(r, user?.email || '')
      persistUser(next)
      setUser(next)
    } catch {
      /* 保持本地缓存 */
    }
  }, [user?.email])

  useEffect(() => {
    if (getToken()) void refreshMe()
    // 仅挂载时拉一次资料
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Go 后端登录：POST /auth/login 返回 {access_token, role, ...} */
  const doLogin = useCallback(async (email: string, pw: string) => {
    const r = await api<{
      access_token?: string
      token?: string
      role?: string
      email?: string
      username?: string
      avatar?: string
      avatarKey?: string
    }>('/auth/login', {
      body: { email, password: pw },
    })
    const token = r?.access_token || r?.token
    if (!token) throw new Error('登录响应缺少 access_token')
    start(mapMe(r, email), token)
    return null
  }, [])

  const register = useCallback(async (raw: string, pw: string) => {
    const email = raw.trim().toLowerCase()
    const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') || 'user'
    const username = base.length >= 3 ? base : `user_${base}`
    try {
      await api('/register', { body: { username, email, password: pw } })
      return await doLogin(email, pw)
    } catch (e) {
      return e instanceof Error ? e.message : '注册失败，请稍后再试'
    }
  }, [doLogin])

  const login = useCallback(async (raw: string, pw: string) => {
    const email = raw.trim().toLowerCase()
    try {
      return await doLogin(email, pw)
    } catch (e) {
      return e instanceof Error ? e.message : '登录失败，请稍后再试'
    }
  }, [doLogin])

  const logout = useCallback(() => {
    setToken(null)
    persistUser(null)
    setUser(null)
    fireAuthChange()
  }, [])

  const setAvatar = useCallback(async (key: string, previewUrl?: string) => {
    try {
      const r = await api<{ email: string; role?: string; username?: string; avatar?: string; avatarKey?: string }>('/me', {
        method: 'PATCH',
        body: { avatar: key },
      })
      const next = mapMe(r)
      if (previewUrl && !next.avatar) next.avatar = previewUrl
      persistUser(next)
      setUser(next)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : '头像保存失败'
    }
  }, [])

  const value = useMemo(
    () => ({ user, register, login, logout, refreshMe, setAvatar }),
    [user, register, login, logout, refreshMe, setAvatar],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('AuthProvider missing')
  return v
}

/** 登录后跳回原页面（如从购买页被拦到登录） */
export function rememberNext(path: string) {
  try {
    sessionStorage.setItem('haiman-next', path)
  } catch {
    /* ignore */
  }
}
export function takeNext(): string | null {
  try {
    const v = sessionStorage.getItem('haiman-next')
    sessionStorage.removeItem('haiman-next')
    return v
  } catch {
    return null
  }
}
