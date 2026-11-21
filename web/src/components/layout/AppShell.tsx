import { useRef, useState, type ReactNode } from 'react'
import { Logo } from '@/assets/logo'
import { Button } from '@/components/ui'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/utils'
import { rememberNext, useAuth } from '@/lib/auth'
import { uploadAvatarFile } from '@/lib/files'
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

function initials(email: string) {
  const local = (email.split('@')[0] || '?').trim()
  return local.slice(0, 2).toUpperCase()
}

function UserMenu() {
  const { user, logout, setAvatar } = useAuth()
  const { toast } = useStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  if (!user) return null

  const onPick = async (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件', 'error')
      return
    }
    if (file.size > 8 << 20) {
      toast('头像请小于 8MB', 'error')
      return
    }
    setUploading(true)
    try {
      const { key, url } = await uploadAvatarFile(file)
      const err = await setAvatar(key, url)
      if (err) toast(err, 'error')
      else toast('头像已更新')
    } catch (e) {
      toast(e instanceof Error ? e.message : '头像上传失败', 'error')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'flex h-9 items-center gap-2 rounded-full border border-border bg-card py-0.5 pr-2.5 pl-0.5 text-left transition',
            'hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          )}
        >
          <Avatar size="sm" className="size-7">
            {user.avatar ? <AvatarImage src={user.avatar} alt="" /> : null}
            <AvatarFallback className="text-[11px] font-semibold">{initials(user.email)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-[140px] truncate text-[13px] font-medium sm:inline">{user.email}</span>
          <Icon name="chevronDown" size={14} className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal">
              <div className="flex items-center gap-3 py-1">
                <Avatar>
                  {user.avatar ? <AvatarImage src={user.avatar} alt="" /> : null}
                  <AvatarFallback className="text-xs font-semibold">{initials(user.email)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{user.username || user.email.split('@')[0]}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  {user.role === 'admin' && (
                    <span className="mt-1 inline-flex rounded border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                      管理员
                    </span>
                  )}
                </div>
              </div>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => go('/orders')}>
              <Icon name="file" size={15} className="mr-2" />
              我的订单
            </DropdownMenuItem>
            {user.role === 'admin' && (
              <DropdownMenuItem onClick={() => go('/manage/scripts')}>
                <Icon name="book" size={15} className="mr-2" />
                管理后台
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Icon name="image" size={15} className="mr-2" />
              {uploading ? '上传中…' : '更换头像'}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                logout()
                go('/')
              }}
            >
              <Icon name="x" size={15} className="mr-2" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  const { user } = useAuth()
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
              <UserMenu />
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
