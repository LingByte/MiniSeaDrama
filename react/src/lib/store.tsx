import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { uid, DEFAULT_GROUPS, type Order, type Script, type TagGroup, type ScriptStatus } from './data'
import { api, ApiError, getToken, setToken } from './api'
import { readUser, type Me } from './auth'

interface State {
  scripts: Script[]
  orders: Order[]
  tagGroups: TagGroup[]
}
export interface Toast {
  id: number
  msg: string
  tone: 'success' | 'info' | 'error'
}

/** 网关返回的支付二维码信息：img 为现成二维码图片，qrcode 为码内容 */
export interface PayQr {
  img: string
  qrcode: string
  payurl: string
}

/** 唯一数据源是服务端；本地不保留任何演示/占位数据 */
const EMPTY: State = { scripts: [], orders: [], tagGroups: [] }

/** 服务端未返回标签分类时使用内置分类，保证管理端标签步骤可用 */
const withDefaultGroups = (groups: TagGroup[] | undefined): TagGroup[] =>
  groups && groups.length ? groups : DEFAULT_GROUPS

function useStoreValue() {
  const [state, setState] = useState<State>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const tid = useRef(0)
  const seq = useRef(0)
  const warned = useRef(false)

  const toast = useCallback((msg: string, tone: Toast['tone'] = 'success') => {
    const id = ++tid.current
    setToasts((t) => [...t, { id, msg, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  const isAdminNow = () => readUser()?.role === 'admin'

  /** 游客视角：只取上架剧本 + 自己的订单，任何情况下都必须能读出来 */
  const loadGuest = useCallback(async (): Promise<State> => {
    let bs: { scripts: Script[]; tagGroups: TagGroup[] }
    try {
      bs = await api<{ scripts: Script[]; tagGroups: TagGroup[] }>('/bootstrap')
    } catch (e) {
      // Go 后端暂未实现剧目/标签接口（可能返回 401/404/405）：统一降级为空数据
      if (e instanceof ApiError) {
        bs = { scripts: [], tagGroups: [] }
      } else {
        throw e
      }
    }
    let orders: Order[] = []
    if (getToken()) {
      try {
        const r = await api<{ orders: Order[] }>('/orders')
        orders = r.orders
      } catch {
        /* 订单读不到不影响浏览 */
      }
    }
    return { scripts: bs.scripts, orders, tagGroups: withDefaultGroups(bs.tagGroups) }
  }, [])

  /** 从服务端拉取全量数据。管理员拿全部剧本（含草稿）+ 全部订单；买家只看自己的订单 */
  const refresh = useCallback(async () => {
    const my = ++seq.current
    try {
      let next: State
      if (getToken() && isAdminNow()) {
        try {
          const r = await api<State>('/admin/all')
          next = { scripts: r.scripts, orders: r.orders, tagGroups: withDefaultGroups(r.tagGroups) }
        } catch {
          // 登录态失效（token 过期 / 数据重置）时降级为游客，前台照常可访问
          next = await loadGuest()
        }
      } else {
        next = await loadGuest()
      }
      if (my !== seq.current) return // 已有更新的请求，丢弃过期响应
      setState(next)
      setLoadError('')
      warned.current = false
    } catch (e) {
      if (my !== seq.current) return
      const msg = e instanceof Error ? e.message : '无法连接服务器'
      setLoadError(msg)
      if (!warned.current) {
        warned.current = true
        toast('无法读取服务器数据：' + msg, 'error')
      }
    } finally {
      if (my === seq.current) setLoaded(true)
    }
  }, [toast, loadGuest])

  useEffect(() => {
    refresh()
    const f = () => refresh()
    const onVis = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('haiman:auth', f)
    window.addEventListener('focus', f)
    window.addEventListener('storage', f)
    document.addEventListener('visibilitychange', onVis)
    // 后台改了内容，前台其它标签页最迟 15 秒内同步
    const timer = window.setInterval(f, 15_000)
    return () => {
      window.removeEventListener('haiman:auth', f)
      window.removeEventListener('focus', f)
      window.removeEventListener('storage', f)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(timer)
    }
  }, [refresh])

  const err = (e: unknown, fb: string) => toast(e instanceof Error ? e.message : fb, 'error')

  /** 所有写操作一律「提交 → 回读服务端」，不靠本地猜测结果 */
  const actions = useMemo(
    () => ({
      refresh,
      async saveScript(s: Script) {
        try {
          await api<{ script: Script }>(`/admin/scripts/${s.id}`, { method: 'PUT', body: { script: s } })
          await refresh()
        } catch (e) {
          err(e, '保存失败')
          throw e
        }
      },
      async deleteScript(id: string) {
        try {
          await api(`/admin/scripts/${id}`, { method: 'DELETE' })
          await refresh()
        } catch (e) { err(e, '删除失败') }
      },
      async setStatus(id: string, status: ScriptStatus) {
        try {
          await api(`/admin/scripts/${id}`, { method: 'PATCH', body: { status } })
          await refresh()
        } catch (e) { err(e, '操作失败') }
      },
      async setPrices(changes: { id: string; price: number }[], note: string) {
        try {
          await api('/admin/pricing', { body: { changes, note } })
          await refresh()
        } catch (e) { err(e, '调价失败') }
      },
      async saveGroup(g: TagGroup) {
        try {
          await api(`/admin/groups/${g.id}`, { method: 'PUT', body: { group: g } })
          await refresh()
        } catch (e) { err(e, '保存失败') }
      },
      async deleteGroup(id: string) {
        try {
          await api(`/admin/groups/${id}`, { method: 'DELETE' })
          await refresh()
        } catch (e) { err(e, '删除失败') }
      },
      async addTag(gid: string, name: string) {
        try {
          await api(`/admin/groups/${gid}/tags`, { body: { name } })
          await refresh()
        } catch (e) { err(e, '添加失败') }
      },
      async renameTag(gid: string, from: string, to: string) {
        try {
          await api(`/admin/groups/${gid}/tags`, { method: 'PATCH', body: { from, to } })
          await refresh()
        } catch (e) { err(e, '重命名失败') }
      },
      async removeTag(gid: string, name: string) {
        try {
          await api(`/admin/groups/${gid}/tags?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
          await refresh()
        } catch (e) { err(e, '删除失败') }
      },
      async setTagScripts(gid: string, name: string, scriptIds: string[]) {
        try {
          await api(`/admin/groups/${gid}/tag-scripts`, { body: { name, scriptIds } })
          await refresh()
        } catch (e) { err(e, '操作失败') }
      },
      /** 下单：创建待支付订单并返回支付二维码（在当前弹窗内扫码，不再跳转新页面） */
      async placeOrder(o: { scriptId: string; buyer: string; company: string; email: string; type: 'alipay' }): Promise<{ order: Order; payUrl: string; qr: PayQr | null }> {
        const r = await api<{ order: Order; payUrl: string; qr: PayQr | null }>('/orders', {
          body: { scriptId: o.scriptId, buyer: o.buyer, company: o.company, email: o.email, type: o.type },
        })
        await refresh()
        return r
      },
      /** 为待支付订单重新获取支付二维码 */
      async payOrder(id: string): Promise<{ payUrl: string; qr: PayQr | null }> {
        const r = await api<{ payUrl: string; qr: PayQr | null }>(`/orders/${id}/pay`, { method: 'POST', body: {} })
        return r
      },
      async refund(id: string): Promise<boolean> {
        try {
          await api(`/admin/orders/${id}/refund`, { method: 'POST' })
          await refresh()
          return true
        } catch (e) {
          err(e, '退款失败')
          return false
        }
      },
      async reset() {
        await api('/admin/reset', { method: 'POST' })
        await refresh()
      },
    }),
    [refresh, toast],
  )

  return { state, loaded, loadError, toasts, toast, ...actions }
}

type Store = ReturnType<typeof useStoreValue>
const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue()

  if (!value.loaded) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas text-ink-600">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
          <p className="mt-4 text-sm">正在从服务器读取数据…</p>
        </div>
      </div>
    )
  }

  // 后端不可用时不显示任何假数据，直接给出明确错误与重试入口
  if (value.loadError && value.state.scripts.length === 0) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas px-6 text-ink-700">
        <div className="w-full max-w-md rounded-2xl border border-line bg-white p-8 text-center shadow-sm">
          <p className="text-lg font-semibold">无法连接服务器</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">
            页面只展示服务端的真实数据，未加载任何本地演示数据。<br />请确认后端服务已启动后重试。
          </p>
          <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600">{value.loadError}</p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              onClick={() => value.refresh()}
              className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              重新连接
            </button>
            <button
              onClick={() => {
                setToken(null)
                try {
                  localStorage.removeItem('haiman-user-v1')
                } catch {
                  /* ignore */
                }
                location.reload()
              }}
              className="rounded-xl border border-line px-5 py-2.5 text-sm font-medium text-ink-600 hover:bg-ink-50"
            >
              清除登录状态并重载
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Ctx.Provider value={value}>
      {value.loadError && (
        <div className="fixed inset-x-0 top-0 z-[100] bg-rose-600 px-4 py-2 text-center text-xs text-white">
          服务器连接异常：{value.loadError}（显示的是上次成功读取的数据）
          <button className="ml-3 underline" onClick={() => value.refresh()}>重试</button>
        </div>
      )}
      {children}
    </Ctx.Provider>
  )
}
export function useStore() {
  const v = useContext(Ctx)
  if (!v) throw new Error('StoreProvider missing')
  return v
}

export const newId = () => uid('s')

/* ---------- 路由：基于 hash，零依赖 ---------- */
export function go(path: string) {
  if (location.hash.slice(1) === path) return
  location.hash = path
}
export function useRoute() {
  const get = () => location.hash.slice(1) || '/'
  const [path, setPath] = useState(get)
  useEffect(() => {
    const f = () => {
      setPath(get())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return path
}
