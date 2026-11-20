import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { api, setToken, getToken } from './api'

export interface Me {
  email: string
  role: 'buyer' | 'admin'
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

interface Auth {
  user: Me | null
  /** 成功返回 null，失败返回错误文案 */
  register: (email: string, pw: string) => Promise<string | null>
  login: (email: string, pw: string) => Promise<string | null>
  logout: () => void
}
const Ctx = createContext<Auth | null>(null)

/** 登录/登出后通知 store 刷新订单数据 */
const fireAuthChange = () => window.dispatchEvent(new CustomEvent('haiman:auth'))

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(() => (getToken() ? readUser() : null))

  const start = (u: Me, token: string) => {
    setToken(token)
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(u))
    } catch {
      /* ignore */
    }
    setUser(u)
    fireAuthChange()
  }

  /** Go 后端登录：POST /auth/login 返回 {access_token, role, ...} */
  const doLogin = useCallback(async (email: string, pw: string) => {
    const r = await api<{ access_token?: string; token?: string; role?: string; email?: string }>('/auth/login', {
      body: { email, password: pw },
    })
    const token = r?.access_token || r?.token
    if (!token) throw new Error('登录响应缺少 access_token')
    const role: Me['role'] = r?.role === 'admin' ? 'admin' : 'buyer'
    start({ email: (r?.email || email).toLowerCase(), role }, token)
    return null
  }, [])

  const register = useCallback(async (raw: string, pw: string) => {
    const email = raw.trim().toLowerCase()
    // Go 后端注册要求 username(3-50)；用邮箱前缀生成，长度不足时补足
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
    // Go 后端 JWT 无状态，没有 logout 接口，清理本地登录态即可
    setToken(null)
    try {
      localStorage.removeItem(USER_KEY)
    } catch {
      /* ignore */
    }
    setUser(null)
    fireAuthChange()
  }, [])

  const value = useMemo(() => ({ user, register, login, logout }), [user, register, login, logout])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('AuthProvider missing')
  return v
}

/** 登录前想做的事（如购买某部剧本），登录后回到原页面 */
const NEXT = 'haiman-next-v1'
export const rememberNext = (path: string) => sessionStorage.setItem(NEXT, path)
export const takeNext = () => {
  const p = sessionStorage.getItem(NEXT)
  sessionStorage.removeItem(NEXT)
  return p
}
