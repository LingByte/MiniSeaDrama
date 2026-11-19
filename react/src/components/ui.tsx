import { useEffect, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { useStore } from '../lib/store'
import { QUALITY_STYLE } from '../lib/data'

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export const idx = (i: number) => ({ '--i': i }) as CSSProperties

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: string
}
export function Button({ variant = 'primary', size = 'md', icon, className, children, ...p }: BtnProps) {
  const v = {
    primary:
      'bg-brand-600 text-white shadow-[0_8px_20px_-8px_rgba(26,107,240,.7)] hover:bg-brand-700 hover:shadow-[0_10px_24px_-8px_rgba(26,107,240,.8)]',
    secondary: 'bg-white text-ink-800 border border-line hover:border-brand-300 hover:text-brand-700',
    ghost: 'text-ink-600 hover:bg-brand-50 hover:text-brand-700',
    soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
    danger: 'bg-white text-rose-600 border border-rose-200 hover:bg-rose-50',
  }[variant]
  const s = { sm: 'h-8 px-3 text-[13px] rounded-lg', md: 'h-10 px-4 text-sm rounded-xl', lg: 'h-12 px-6 text-[15px] rounded-xl' }[size]
  return (
    <button
      {...p}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-all duration-200 ease-[var(--ease-smooth)] active:scale-[.97] disabled:pointer-events-none disabled:opacity-45',
        v,
        s,
        className,
      )}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  )
}

export function Badge({ children, tone = 'brand', className }: { children: ReactNode; tone?: 'brand' | 'gray' | 'orange' | 'green' | 'rose' | 'white'; className?: string }) {
  const t = {
    brand: 'bg-brand-50 text-brand-700 ring-brand-100',
    gray: 'bg-slate-100 text-ink-600 ring-slate-200/60',
    orange: 'bg-orange-50 text-orange-600 ring-orange-100',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    rose: 'bg-rose-50 text-rose-600 ring-rose-100',
    white: 'bg-white/90 text-ink-800 ring-white/40 backdrop-blur',
  }[tone]
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', t, className)}>{children}</span>
}

export function QualityBadge({ q, className }: { q: string; className?: string }) {
  if (!q) return null
  const g = q.trim().charAt(0).toUpperCase()
  const tone = QUALITY_STYLE[g] ?? QUALITY_STYLE.A
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', tone, className)}>
      <Icon name="sparkle" size={11} />
      {q}
    </span>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300', checked ? 'bg-brand-600' : 'bg-slate-200')}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-300 ease-[var(--ease-smooth)]',
          checked && 'translate-x-5',
        )}
      />
    </button>
  )
}

export const inputCls =
  'w-full rounded-xl border border-line bg-white px-3.5 h-10 text-sm text-ink-900 placeholder:text-ink-400 outline-none transition-all duration-200 hover:border-brand-200 focus:border-brand-400 focus:ring-4 focus:ring-brand-100'

export function Field({ label, hint, children, required, error }: { label: string; hint?: string; children: ReactNode; required?: boolean; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium text-ink-700">
        {label}
        {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-xs text-rose-500">{error}</span> : hint && <span className="mt-1.5 block text-xs text-ink-400">{hint}</span>}
    </label>
  )
}

export function Chip({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-9 rounded-full px-4 text-sm font-medium transition-all duration-200 active:scale-95',
        active ? 'bg-brand-600 text-white shadow-[0_6px_14px_-6px_rgba(26,107,240,.8)]' : 'bg-white text-ink-600 ring-1 ring-line hover:text-brand-700 hover:ring-brand-200',
      )}
    >
      {children}
    </button>
  )
}

export function Modal({ open, onClose, children, width = 'max-w-lg', side = false }: { open: boolean; onClose: () => void; children: ReactNode; width?: string; side?: boolean }) {
  useEffect(() => {
    if (!open) return
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', f)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', f)
      document.body.style.overflow = ''
    }
  }, [open, onClose])
  if (!open) return null
  // 用 Portal 挂到 body：祖先元素若带 transform（如页面入场动画）会改变 fixed 定位的
  // 参照系，导致弹窗相对长页面居中而不是相对屏幕居中
  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex', side ? 'justify-end' : 'items-center justify-center p-4')}>
      <div className="anim-fade-in absolute inset-0 bg-ink-900/30 backdrop-blur-[3px]" onClick={onClose} />
      <div
        role="dialog"
        className={cn(
          'relative w-full bg-white shadow-[0_30px_80px_-20px_rgba(15,27,45,.35)]',
          side ? 'anim-slide-right h-full max-w-md overflow-y-auto' : cn('anim-scale-in max-h-[92vh] overflow-y-auto rounded-2xl', width),
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function ModalHeader({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-white/95 px-6 py-4 backdrop-blur">
      <div>
        <h3 className="text-[17px] font-semibold text-ink-900">{title}</h3>
        {sub && <p className="mt-0.5 text-[13px] text-ink-500">{sub}</p>}
      </div>
      <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition hover:bg-slate-100 hover:text-ink-700" aria-label="关闭">
        <Icon name="x" />
      </button>
    </div>
  )
}

export function Toaster() {
  const { toasts } = useStore()
  return (
    <div className="pointer-events-none fixed top-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="anim-toast flex items-center gap-2.5 rounded-xl bg-ink-900 px-4 py-2.5 text-sm text-white shadow-xl">
          <span className={cn('grid h-5 w-5 place-items-center rounded-full', t.tone === 'error' ? 'bg-rose-500' : t.tone === 'info' ? 'bg-brand-500' : 'bg-emerald-500')}>
            <Icon name={t.tone === 'error' ? 'x' : t.tone === 'info' ? 'info' : 'check'} size={12} stroke={3} />
          </span>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

/** 剧本格式渲染：# 场景、角色：台词、【卡点】、其余为动作描写 */
export function ScriptText({ text, size = 'md' }: { text: string; size?: 'md' | 'lg' }) {
  const lines = text.split('\n').filter((l) => l.trim())
  const base = size === 'lg' ? 'text-[16px]' : 'text-[15px]'
  return (
    <div className={cn('space-y-3.5 leading-[1.85]', base)}>
      {lines.map((l, i) => {
        const t = l.trim()
        if (t.startsWith('#'))
          return (
            <p key={i} className="mt-2 border-l-[3px] border-brand-500 bg-brand-50/70 py-1.5 pl-3 text-[13px] font-semibold tracking-wide text-brand-800">
              {t.replace(/^#+\s*/, '')}
            </p>
          )
        if (t.startsWith('【卡点】'))
          return (
            <p key={i} className="rounded-xl border border-orange-200 bg-orange-50/70 px-4 py-3 text-orange-900">
              <span className="mr-2 rounded bg-orange-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">卡点</span>
              {t.replace('【卡点】', '')}
            </p>
          )
        const m = t.match(/^([^：:（(]{1,18})[：:](.+)$/)
        if (m)
          return (
            <p key={i} className="grid grid-cols-[minmax(64px,auto)_1fr] gap-3">
              <span className="pt-px text-right font-semibold text-ink-900">{m[1]}</span>
              <span className="text-ink-800">{m[2].trim()}</span>
            </p>
          )
        return (
          <p key={i} className="text-ink-500 italic">
            {t}
          </p>
        )
      })}
    </div>
  )
}

export function Empty({ icon, title, sub, action }: { icon: string; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="page-enter flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-white/60 px-6 py-16 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-500">
        <Icon name={icon} size={26} />
      </span>
      <p className="mt-4 font-semibold text-ink-800">{title}</p>
      {sub && <p className="mt-1 text-sm text-ink-500">{sub}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function download(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff' + content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const fmtDate = (iso: string, withTime = false) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` + (withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : '')
}
