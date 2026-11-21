import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Badge as ShadcnBadge } from '@/components/ui/badge'
import { Button as ShadcnButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Icon } from './Icon'
import { useStore } from '../lib/store'
import { QUALITY_STYLE } from '../lib/data'

export { cn }
export const idx = (i: number) => ({ '--i': i }) as CSSProperties

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: string
  /** 外部控制的加载态；异步 onClick 也会自动进入加载并防重复点击 */
  loading?: boolean
}

const variantMap = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  soft: 'secondary',
  danger: 'destructive',
} as const

const sizeMap = {
  sm: 'sm',
  md: 'default',
  lg: 'lg',
} as const

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  loading,
  disabled,
  onClick,
  ...p
}: BtnProps) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const pending = Boolean(loading || busy)

  const handleClick = async (e: MouseEvent<HTMLButtonElement>) => {
    if (pending || disabled || lock.current || !onClick) return
    const result = onClick(e) as void | Promise<unknown>
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      lock.current = true
      setBusy(true)
      try {
        await result
      } finally {
        lock.current = false
        setBusy(false)
      }
    }
  }

  return (
    <ShadcnButton
      type={type}
      variant={variantMap[variant]}
      size={sizeMap[size]}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      onClick={handleClick}
      className={cn(
        'gap-2 transition-[transform,opacity,box-shadow] duration-150 active:scale-[0.96]',
        pending && 'opacity-80',
        className,
      )}
      {...p}
    >
      {pending ? (
        <span className="inline-block size-[1em] animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />
      ) : (
        icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />
      )}
      {children}
    </ShadcnButton>
  )
}

export function Badge({
  children,
  tone = 'brand',
  className,
}: {
  children: ReactNode
  tone?: 'brand' | 'gray' | 'orange' | 'green' | 'rose' | 'white'
  className?: string
}) {
  const t = {
    brand: 'bg-primary/10 text-primary border-transparent',
    gray: 'bg-muted text-muted-foreground border-transparent',
    orange: 'bg-orange-50 text-orange-700 border-transparent',
    green: 'bg-emerald-50 text-emerald-700 border-transparent',
    rose: 'bg-rose-50 text-rose-700 border-transparent',
    white: 'bg-card/95 text-foreground border-border',
  }[tone]
  return (
    <ShadcnBadge variant="outline" className={cn('rounded-md px-2 py-0.5 text-xs font-medium', t, className)}>
      {children}
    </ShadcnBadge>
  )
}

export function QualityBadge({ q, className }: { q: string; className?: string }) {
  if (!q) return null
  const g = q.trim().charAt(0).toUpperCase()
  const tone = QUALITY_STYLE[g] ?? QUALITY_STYLE.A
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium', tone, className)}>
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
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}
    >
      <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform', checked && 'translate-x-4')} />
    </button>
  )
}

export const inputCls =
  'flex h-9 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40'

export function TextInput(props: ComponentProps<typeof Input>) {
  return <Input className={cn(inputCls, props.className)} {...props} />
}

export function Field({ label, hint, children, required, error }: { label: string; hint?: string; children: ReactNode; required?: boolean; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium text-foreground">
        {label}
        {required && <span className="text-destructive">*</span>}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-xs text-destructive">{error}</span> : hint && <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function Chip({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-8 rounded-lg px-3 text-sm font-medium transition active:scale-95',
        active ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground hover:text-foreground',
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
  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex', side ? 'justify-end' : 'items-center justify-center p-4')}>
      <div className="anim-fade-in absolute inset-0 bg-foreground/20" onClick={onClose} />
      <div
        role="dialog"
        className={cn(
          'relative w-full border border-border bg-card text-card-foreground shadow-sm',
          side ? 'anim-slide-right h-full max-w-md overflow-y-auto' : cn('anim-scale-in max-h-[92vh] overflow-y-auto rounded-xl', width),
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
    <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card px-5 py-3.5">
      <div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {sub && <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>}
      </div>
      <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="关闭">
        <Icon name="x" />
      </button>
    </div>
  )
}

export function Toaster() {
  const { toasts } = useStore()
  return (
    <div className="pointer-events-none fixed top-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="anim-toast flex items-center gap-2.5 rounded-xl border border-border bg-foreground px-4 py-2.5 text-sm text-background shadow-sm">
          <span className={cn('grid h-5 w-5 place-items-center rounded-full', t.tone === 'error' ? 'bg-rose-500' : t.tone === 'info' ? 'bg-primary' : 'bg-emerald-500')}>
            <Icon name={t.tone === 'error' ? 'x' : t.tone === 'info' ? 'info' : 'check'} size={12} stroke={3} />
          </span>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

/** 剧本 / 试读正文：按 Markdown 渲染（标题、加粗、列表、分隔线等） */
export function ScriptText({ text, size = 'md' }: { text: string; size?: 'md' | 'lg' }) {
  const source = (text || '')
    // 旧版「【卡点】」行转成引用块，方便在 MD 里继续高亮
    .replace(/^(【卡点】)(.*)$/gm, (_, _tag: string, rest: string) => `> **卡点** ${rest.trim()}`)
  const base = size === 'lg' ? 'text-[16px]' : 'text-sm'
  return (
    <div className={cn('script-md leading-[1.85] text-foreground', base)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-1 mb-4 border-b border-border pb-2 text-xl font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-6 mb-3 border-l-2 border-primary bg-muted/50 py-1.5 pl-3 text-[15px] font-semibold tracking-wide text-foreground first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-5 mb-2 text-[14px] font-semibold text-foreground first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-4 mb-1.5 text-[13px] font-semibold text-foreground first:mt-0">{children}</h4>
          ),
          p: ({ children }) => <p className="my-2.5 text-foreground/90">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          em: ({ children }) => <em className="italic text-muted-foreground">{children}</em>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5 text-foreground/90">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5 text-foreground/90">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed marker:text-muted-foreground">{children}</li>,
          hr: () => <hr className="my-5 border-border" />,
          blockquote: ({ children }) => (
            <blockquote className="my-3 rounded-xl border border-border bg-muted/50 px-4 py-3 text-foreground not-italic">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} className="font-medium text-primary underline-offset-2 hover:underline" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const block = Boolean(className)
            if (block) {
              return (
                <code className="block overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 text-[12px] leading-relaxed text-foreground">
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-muted px-1 py-0.5 text-[12px] font-medium text-foreground">{children}</code>
            )
          },
          pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[420px] border-collapse text-left text-[13px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          th: ({ children }) => <th className="border-b border-border px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-border px-3 py-2 text-foreground/90">{children}</td>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

export function Empty({ icon, title, sub, action }: { icon: string; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="page-enter flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon name={icon} size={24} />
      </span>
      <p className="mt-4 text-sm font-semibold text-foreground">{title}</p>
      {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
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
