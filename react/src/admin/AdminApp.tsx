import { useState, type FormEvent, type ReactNode } from 'react'
import { Icon, Logo } from '../components/Icon'
import { Badge, Button, Field, cn, inputCls } from '../components/ui'
import { go, useStore } from '../lib/store'
import { useAuth, EMAIL_RE } from '../lib/auth'
import { Dashboard } from './Dashboard'
import { Scripts } from './Scripts'
import { Editor } from './Editor'
import { Pricing } from './Pricing'
import { Tags } from './Tags'
import { AdminOrders } from './AdminOrders'

const NAV = [
  { group: '概览', items: [{ key: '', label: '数据概览', icon: 'chart' }] },
  {
    group: '剧本',
    items: [
      { key: 'scripts', label: '剧本管理', icon: 'book' },
      { key: 'scripts/new', label: '上架新剧本', icon: 'upload' },
      { key: 'tags', label: '标签管理', icon: 'hash' },
      { key: 'pricing', label: '定价中心', icon: 'tag' },
    ],
  },
  {
    group: '运营',
    items: [
      { key: 'orders', label: '订单管理', icon: 'receipt' },
    ],
  },
]

export function AdminApp({ parts, path }: { parts: string[]; path: string }) {
  const { user, login } = useAuth()

  /* 管理端登录门禁：未登录或非管理员账号时显示登录页 */
  if (!user || user.role !== 'admin') return <AdminLogin current={user} login={login} />

  return <AdminShell parts={parts} path={path} />
}

function AdminLogin({ current, login }: { current: { email: string; role: string } | null; login: (e: string, p: string) => Promise<string | null> }) {
  const { toast } = useStore()
  const [email, setEmail] = useState(current?.email ?? '')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(current ? '该账号不是管理员，请使用管理员账号登录' : '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!EMAIL_RE.test(email.trim())) return setError('请输入管理员邮箱')
    if (pw.length < 6) return setError('请输入密码（至少 6 位）')
    setBusy(true)
    const err = await login(email, pw)
    setBusy(false)
    if (err) return setError(err)
    if (toast) toast('管理员登录成功')
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[#f3f6fb] px-5">
      <div className="anim-scale-in w-full max-w-[400px] rounded-3xl border border-line bg-white p-8 shadow-[0_24px_60px_-30px_rgba(15,27,45,.25)]">
        <div className="flex items-center gap-2">
          <Logo />
          <Badge tone="gray" className="!text-[10px]">ADMIN</Badge>
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">管理后台登录</h1>
        <p className="mt-1.5 text-sm text-ink-500">仅限管理员账号访问，买家请从前台进入</p>
        <form onSubmit={submit} noValidate className="mt-7 space-y-4">
          <Field label="管理员邮箱" error={error || undefined}>
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="2286204478@qq.com" autoFocus />
          </Field>
          <Field label="密码">
            <input type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="请输入密码" autoComplete="current-password" />
          </Field>
          <Button className="h-11 w-full" disabled={busy}>
            {busy ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                登录中
              </>
            ) : (
              '登录后台'
            )}
          </Button>
        </form>
        <button onClick={() => go('/')} className="mt-5 flex items-center gap-1.5 text-sm text-ink-500 transition hover:text-brand-700">
          <Icon name="arrowLeft" size={15} />
          返回前台
        </button>
      </div>
    </div>
  )
}

function AdminShell({ parts, path }: { parts: string[]; path: string }) {
  const { state } = useStore()
  const adminLogout = useAdminLogout()
  const key = parts.join('/')
  const activeKey = key.startsWith('scripts/edit') ? 'scripts' : key
  const drafts = state.scripts.filter((s) => s.status === 'draft').length

  let page: ReactNode = <Dashboard />
  if (key === 'scripts') page = <Scripts />
  else if (key === 'scripts/new') page = <Editor />
  else if (parts[0] === 'scripts' && parts[1] === 'edit') page = <Editor id={parts[2]} />
  else if (key === 'pricing') page = <Pricing />
  else if (key === 'tags') page = <Tags />
  else if (key === 'orders') page = <AdminOrders />

  return (
    <div className="flex min-h-screen bg-[#f3f6fb]">
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-line bg-white lg:flex">
        <div className="flex h-16 items-center gap-2 px-5">
          <Logo />
          <Badge tone="gray" className="ml-1 !text-[10px]">
            ADMIN
          </Badge>
        </div>
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 pt-4">
          {NAV.map((g) => (
            <div key={g.group}>
              <p className="px-3 pb-2 text-[11px] font-semibold tracking-wider text-ink-400">{g.group}</p>
              <ul className="space-y-0.5">
                {g.items.map((n) => {
                  const active = activeKey === n.key
                  return (
                    <li key={n.key}>
                      <button
                        onClick={() => go('/admin' + (n.key ? '/' + n.key : ''))}
                        className={cn(
                          'relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm transition-all duration-200',
                          active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-600 hover:bg-slate-50 hover:text-ink-900',
                        )}
                      >
                        <span className={cn('absolute top-2.5 -left-3 h-5 w-1 rounded-r-full bg-brand-600 transition-all duration-300', active ? 'opacity-100' : 'opacity-0')} />
                        <Icon name={n.icon} size={17} />
                        {n.label}
                        {n.key === 'scripts' && drafts > 0 && <span className="ml-auto rounded-md bg-orange-50 px-1.5 text-[11px] font-semibold text-orange-600">{drafts} 草稿</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="m-3 rounded-2xl bg-gradient-to-br from-brand-50 to-sky-50 p-4 ring-1 ring-brand-100">
          <p className="text-[13px] font-semibold text-ink-800">云端数据</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">所有操作实时保存到服务器，前台买家端同步可见；切换标签页或每隔 15 秒自动刷新。</p>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-line bg-white/85 px-5 backdrop-blur-xl lg:px-8">
          <div className="flex gap-1 overflow-x-auto lg:hidden">
            {NAV.flatMap((g) => g.items).map((n) => (
              <button key={n.key} onClick={() => go('/admin' + (n.key ? '/' + n.key : ''))} className={cn('h-8 shrink-0 rounded-lg px-2.5 text-[13px]', activeKey === n.key ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600')}>
                {n.label}
              </button>
            ))}
          </div>
          <p className="hidden text-sm text-ink-400 lg:block">至简海漫 HAIMAN 剧本管理后台</p>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={() => go('/')} className="flex h-9 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-[13px] font-medium text-ink-700 transition hover:border-brand-300 hover:text-brand-700">
              <Icon name="external" size={15} />
              查看前台
            </button>
            <button onClick={adminLogout} title="退出管理员登录" className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-semibold text-white transition hover:opacity-90">管</button>
          </div>
        </header>
        <main key={path} className="page-enter px-5 py-7 lg:px-8">
          {page}
        </main>
      </div>
    </div>
  )
}

function useAdminLogout() {
  const { logout } = useAuth()
  return () => {
    logout()
    go('/admin')
  }
}

