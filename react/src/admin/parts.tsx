import type { ReactNode } from 'react'
import { Badge, cn } from '../components/ui'

export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-ink-500">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ children, className, title, extra }: { children: ReactNode; className?: string; title?: string; extra?: ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-white', className)}>
      {title && (
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {extra}
        </div>
      )}
      {children}
    </section>
  )
}

export function StatusBadge({ status }: { status: 'on' | 'off' | 'draft' }) {
  if (status === 'on')
    return (
      <Badge tone="green">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        在售
      </Badge>
    )
  if (status === 'off') return <Badge tone="gray">已下架</Badge>
  return <Badge tone="orange">草稿</Badge>
}
