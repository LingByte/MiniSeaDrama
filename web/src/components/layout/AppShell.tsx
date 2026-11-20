import { type ReactNode } from 'react'
import { Logo } from '@/assets/logo'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { rememberNext, useAuth } from '@/lib/auth'
import { go, useStore } from '@/lib/store'

const BUYER_NAV = [
  { path: '/', label: '剧本库', match: (p: string) => p === '/' || p.startsWith('/script') },
  { path: '/orders', label: '我的订单', match: (p: string) => p.startsWith('/orders') },
]

const ADMIN_NAV = [
  { path: '/manage/scripts', label: '剧本管理', match: (p: string) => p.startsWith('/manage/scripts') },
  { path: '/manage/tags', label: '标签', match: (p: string) => p.startsWith('/manage/tags') },
  { path: '/manage/pricing', label: '定价', match: (p: string) => p.startsWith('/manage/pricing') },
  { path: '/manage/orders', label: '全部订单', match: (p: string) => p.startsWith('/manage/orders') },
  { path: '/manage/ai', label: 'AI 生成', match: (p: string) => p.startsWith('/manage/ai') },
]

export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  const { user, logout } = useAuth()
  const { state } = useStore()
  const isAdmin = user?.role === 'admin'
  const paid = state.orders.filter((o) => !!user && o.account === user.email && o.status === 'paid').length
  const nav = [...BUYER_NAV, ...(isAdmin ? ADMIN_NAV : [])]

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 lg:px-6">
          <button type="button" onClick={() => go('/')} aria-label="首页" className="shrink-0">
            <Logo />
          </button>
          <nav className="hidden items-center gap-0.5 md:flex">
            {nav.map((n) => {
              const active = n.match(path)
              return (
                <button
                  key={n.path}
                  type="button"
                  onClick={() => go(n.path)}
                  className={cn(
                    'relative flex h-8 items-center rounded-lg px-3 text-sm transition-colors',
                    active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {n.label}
                  {n.path === '/orders' && paid > 0 && (
                    <span className="ml-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                      {paid}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <>
                {isAdmin && (
                  <span className="hidden rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:inline">
                    管理员
                  </span>
                )}
                <span className="hidden max-w-[160px] truncate text-sm text-muted-foreground sm:inline">{user.email}</span>
                <Button variant="secondary" size="sm" onClick={() => logout()}>
                  退出
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => go('/login')}>
                  登录
                </Button>
                <Button size="sm" onClick={() => go('/register')}>
                  注册
                </Button>
              </>
            )}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto border-t border-border px-3 py-1.5 md:hidden">
          {nav.map((n) => (
            <button
              key={n.path}
              type="button"
              onClick={() => go(n.path)}
              className={cn(
                'h-8 shrink-0 rounded-lg px-2.5 text-[13px]',
                n.match(path) ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
              )}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl page-enter px-4 py-6 lg:px-6">{children}</main>
    </div>
  )
}

/** Guard manage routes for non-admins */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (!user) {
    rememberNext(window.location.hash.replace(/^#/, '') || '/manage/scripts')
    go('/login')
    return null
  }
  if (user.role !== 'admin') {
    go('/')
    return null
  }
  return <>{children}</>
}
