import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Button, cn, fmtDate, idx } from '../components/ui'
import { money } from '../lib/data'
import { go, useStore } from '../lib/store'
import { Card, PageHeader } from './parts'

export function Dashboard() {
  const { state } = useStore()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(t)
  }, [])

  const paid = state.orders.filter((o) => o.status === 'paid')
  const revenue = paid.reduce((a, o) => a + o.paid, 0)
  const onSale = state.scripts.filter((s) => s.status === 'on').length
  const drafts = state.scripts.filter((s) => s.status === 'draft')
  // 环比一律由真实订单计算，不写死任何增长率
  const now = Date.now()
  const week = 7 * 864e5
  const age = (o: (typeof paid)[number]) => now - +new Date(o.createdAt)
  const cur = paid.filter((o) => age(o) < week)
  const prev = paid.filter((o) => age(o) >= week && age(o) < 2 * week)
  const sum = (xs: typeof paid) => xs.reduce((a, o) => a + o.paid, 0)
  const avg = (xs: typeof paid) => (xs.length ? sum(xs) / xs.length : 0)
  const growth = (a: number, b: number) => {
    if (b === 0) return a > 0 ? '本期新增' : '暂无成交'
    const v = ((a - b) / b) * 100
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
  }
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 864e5)
    const key = fmtDate(d.toISOString())
    const daySum = paid.filter((o) => fmtDate(o.createdAt) === key).reduce((a, o) => a + o.paid, 0)
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, sum: daySum, today: i === 6 }
  })
  const max = Math.max(...days.map((d) => d.sum), 1)
  const top = [...state.scripts].filter((s) => s.status !== 'draft').sort((a, b) => b.sales - a.sales).slice(0, 5)

  const kpis = [
    { label: '累计销售额', value: money(revenue), icon: 'wallet', trend: growth(sum(cur), sum(prev)) },
    { label: '有效订单', value: paid.length, icon: 'receipt', trend: growth(cur.length, prev.length) },
    { label: '在售剧本', value: onSale, icon: 'book', trend: `${drafts.length} 草稿` },
    { label: '平均客单价', value: money(paid.length ? revenue / paid.length : 0), icon: 'trend', trend: growth(avg(cur), avg(prev)) },
  ]

  return (
    <>
      <PageHeader
        title="数据概览"
        sub={`今天是 ${fmtDate(new Date().toISOString())}，当前在售 ${onSale} 部剧本`}
        actions={
          <>
            <Button icon="upload" onClick={() => go('/admin/scripts/new')}>
              上架新剧本
            </Button>
          </>
        }
      />
      <div className="stagger grid grid-cols-2 gap-4 xl:grid-cols-4">
        {kpis.map((k, i) => (
          <div key={k.label} style={idx(i)} className="group rounded-2xl border border-line bg-white p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-28px_rgba(26,107,240,.8)]">
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-500">{k.label}</span>
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-50 text-brand-600 transition group-hover:bg-brand-600 group-hover:text-white">
                <Icon name={k.icon} size={17} />
              </span>
            </div>
            <p className="mt-3 text-[26px] font-bold tracking-tight">{k.value}</p>
            <p className={cn('mt-1 text-xs', k.trend.startsWith('+') || k.trend === '本期新增' ? 'text-emerald-600' : 'text-ink-400')}>
              {k.trend} <span className="text-ink-400">{k.label === '在售剧本' ? '待完善' : '较前 7 日'}</span>
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card title="近 7 日销售额" extra={<span className="text-xs text-ink-400">单位：元（¥）</span>}>
          <div className="flex h-64 items-end gap-3 px-6 pt-6 pb-5">
            {days.map((d, i) => (
              <div key={d.label} className="group flex h-full flex-1 flex-col items-center justify-end gap-2">
                <span className="text-[11px] font-medium text-ink-500 opacity-0 transition group-hover:opacity-100">{money(d.sum)}</span>
                <div className="relative w-full max-w-[44px] flex-1">
                  <div
                    className={cn('absolute inset-x-0 bottom-0 rounded-t-lg transition-all duration-[900ms] ease-[var(--ease-smooth)] group-hover:opacity-90', d.today ? 'bg-brand-600' : 'bg-brand-200 group-hover:bg-brand-400')}
                    style={{ height: mounted ? `${Math.max(4, (d.sum / max) * 100)}%` : '0%', transitionDelay: `${i * 60}ms` }}
                  />
                </div>
                <span className={cn('text-xs', d.today ? 'font-semibold text-brand-700' : 'text-ink-400')}>{d.today ? '今天' : d.label}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="热销剧本 TOP 5" extra={<button onClick={() => go('/admin/scripts')} className="text-xs text-brand-700">全部</button>}>
          <ul className="divide-y divide-line">
            {top.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <span className={cn('w-5 text-center text-sm font-bold', i < 3 ? 'text-brand-600' : 'text-ink-300')}>{i + 1}</span>
                <img src={s.cover} alt="" className="h-10 w-8 rounded-md object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.title}</p>
                  <p className="text-xs text-ink-400">{s.tags.slice(0, 2).join(' · ')}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">{s.sales}</p>
                  <p className="text-[11px] text-ink-400">已售</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card title="最新订单" extra={<button onClick={() => go('/admin/orders')} className="text-xs text-brand-700">查看全部</button>}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {state.orders.slice(0, 6).map((o) => (
                  <tr key={o.id} className="transition hover:bg-slate-50/70">
                    <td className="py-3 pl-5 font-mono text-xs text-ink-500">{o.id}</td>
                    <td className="max-w-[200px] truncate py-3 font-medium">{o.scriptTitle}</td>
                    <td className="py-3 text-ink-500">{o.company || o.buyer}</td>
                    <td className="py-3 text-ink-400">{fmtDate(o.createdAt, true)}</td>
                    <td className={cn('py-3 pr-5 text-right font-semibold', o.status === 'refunded' && 'text-ink-300 line-through')}>{money(o.paid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="待办事项">
          <ul className="space-y-2 p-4">
            {drafts.map((s) => (
              <li key={s.id}>
                <button onClick={() => go(`/admin/scripts/edit/${s.id}`)} className="group flex w-full items-center gap-3 rounded-xl bg-orange-50/60 p-3 text-left ring-1 ring-orange-100 transition hover:ring-orange-200">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-orange-500">
                    <Icon name="edit" size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">完善草稿《{s.title}》</span>
                    <span className="text-xs text-ink-500">完成后即可上架销售</span>
                  </span>
                  <Icon name="chevronRight" size={16} className="text-ink-400 transition group-hover:translate-x-0.5" />
                </button>
              </li>
            ))}
            {[
              ['tag', '检查定价', '季度调价窗口：本月底前', '/admin/pricing'],
            ].map(([icon, t, d, to]) => (
              <li key={t}>
                <button onClick={() => go(to)} className="group flex w-full items-center gap-3 rounded-xl p-3 text-left ring-1 ring-line transition hover:ring-brand-200">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon name={icon} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t}</span>
                    <span className="text-xs text-ink-500">{d}</span>
                  </span>
                  <Icon name="chevronRight" size={16} className="text-ink-400 transition group-hover:translate-x-0.5" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  )
}
