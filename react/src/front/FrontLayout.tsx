import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, Logo } from '../components/Icon'
import { cn } from '../components/ui'
import { go, useStore } from '../lib/store'
import { useAuth } from '../lib/auth'

const NAV = [
  { path: '/', label: '剧本库', match: (p: string) => p === '/' || p.startsWith('/script') },
  { path: '/orders', label: '我的订单', match: (p: string) => p.startsWith('/orders') },
]

export function FrontLayout({ path, children }: { path: string; children: ReactNode }) {
  const { state } = useStore()
  const { user, logout } = useAuth()
  const [scrolled, setScrolled] = useState(false)
  const mine = state.orders.filter((o) => !!user && o.account === user.email && o.status === 'paid').length
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 8)
    f()
    window.addEventListener('scroll', f, { passive: true })
    return () => window.removeEventListener('scroll', f)
  }, [])

  return (
    <div className="min-h-screen">
      <header
        className={cn(
          'sticky top-0 z-40 transition-all duration-300',
          scrolled ? 'border-b border-line bg-white/80 shadow-[0_8px_30px_-20px_rgba(15,27,45,.25)] backdrop-blur-xl' : 'border-b border-transparent bg-transparent',
        )}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-5 lg:px-8">
          <button onClick={() => go('/')} aria-label="海漫首页">
            <Logo />
          </button>
          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => {
              const active = n.match(path)
              return (
                <button
                  key={n.path}
                  onClick={() => go(n.path)}
                  className={cn(
                    'relative flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors',
                    active ? 'text-brand-700' : 'text-ink-600 hover:text-ink-900',
                  )}
                >
                  {n.label}
                  {n.path === '/orders' && mine > 0 && (
                    <span className="anim-pop grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">{mine}</span>
                  )}
                  <span
                    className={cn(
                      'absolute inset-x-3.5 -bottom-[13px] h-[2px] origin-center rounded-full bg-brand-600 transition-transform duration-300 ease-[var(--ease-smooth)]',
                      active ? 'scale-x-100' : 'scale-x-0',
                    )}
                  />
                </button>
              )
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <UserMenu email={user.email} onLogout={logout} />
            ) : (
              <div className="ml-1 flex items-center gap-1.5">
                <button onClick={() => go('/login')} className="h-9 rounded-xl px-3.5 text-sm font-medium text-ink-700 transition hover:bg-brand-50 hover:text-brand-700">
                  登录
                </button>
                <button onClick={() => go('/register')} className="h-9 rounded-xl bg-brand-600 px-4 text-sm font-medium text-white shadow-[0_8px_18px_-8px_rgba(26,107,240,.8)] transition hover:bg-brand-700 active:scale-95">
                  注册
                </button>
              </div>
            )}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
          {NAV.map((n) => (
            <button key={n.path} onClick={() => go(n.path)} className={cn('h-8 shrink-0 rounded-lg px-3 text-sm', n.match(path) ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600')}>
              {n.label}
            </button>
          ))}
        </nav>
      </header>
      <main key={path.split('/')[1] + (path.split('/')[2] ?? '')} className="page-enter pb-24">
        {children}
      </main>
    </div>
  )
}

function UserMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', f)
    return () => document.removeEventListener('mousedown', f)
  }, [open])
  return (
    <div ref={ref} className="relative ml-1">
      <button onClick={() => setOpen(!open)} className="flex h-9 items-center gap-2 rounded-xl border border-line bg-white pr-2.5 pl-1.5 transition hover:border-brand-300" aria-label="账号菜单">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-xs font-semibold text-white uppercase">{email[0]}</span>
        <Icon name="chevronDown" size={14} className={cn('text-ink-400 transition-transform duration-300', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="anim-scale-in absolute right-0 mt-2 w-60 origin-top-right rounded-2xl border border-line bg-white p-1.5 shadow-[0_20px_40px_-16px_rgba(15,27,45,.3)]">
          <div className="border-b border-line px-3 pt-2 pb-3">
            <p className="text-xs text-ink-400">已登录</p>
            <p className="truncate text-sm font-semibold">{email}</p>
          </div>
          <button
            onClick={() => {
              setOpen(false)
              go('/orders')
            }}
            className="mt-1 flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-ink-700 transition hover:bg-brand-50 hover:text-brand-700"
          >
            <Icon name="receipt" size={16} /> 我的订单
          </button>
          <button
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-ink-700 transition hover:bg-rose-50 hover:text-rose-600"
          >
            <Icon name="arrowRight" size={16} /> 退出登录
          </button>
        </div>
      )}
    </div>
  )
}
