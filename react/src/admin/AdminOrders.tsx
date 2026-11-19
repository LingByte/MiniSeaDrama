import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Modal, ModalHeader, cn, download, fmtDate, inputCls } from '../components/ui'
import { SALE_LABEL, STATUS_LABEL, money, type Order, type OrderStatus } from '../lib/data'
import { useStore } from '../lib/store'
import { Card, PageHeader } from './parts'

const BADGE_TONE: Record<OrderStatus, 'green' | 'orange' | 'gray'> = { paid: 'green', pending: 'orange', refunded: 'gray', closed: 'gray' }
const StatusBadge = ({ o }: { o: Order }) => <Badge tone={BADGE_TONE[o.status] ?? 'gray'}>{STATUS_LABEL[o.status] ?? o.status}</Badge>

export function AdminOrders() {
  const { state, refund, toast } = useStore()
  const [kw, setKw] = useState('')
  const [status, setStatus] = useState<'all' | OrderStatus>('all')
  const [view, setView] = useState<Order | null>(null)
  const [refunding, setRefunding] = useState('')

  const list = state.orders.filter((o) => (status === 'all' || o.status === status) && (!kw || [o.id, o.scriptTitle, o.company, o.email, o.buyer].join(' ').toLowerCase().includes(kw.toLowerCase())))
  const total = list.filter((o) => o.status === 'paid').reduce((a, o) => a + o.paid, 0)

  const exportCsv = () => {
    const rows = [['订单号', '剧本', '销售方式', '买家', '公司', '邮箱', '国家', '原价', '实付', '支付方式', '时间', '状态']]
    list.forEach((o) => rows.push([o.id, o.scriptTitle, SALE_LABEL[o.saleType], o.buyer, o.company ?? '', o.email, o.country ?? '', String(o.original), String(o.paid), o.payMethod, fmtDate(o.createdAt, true), STATUS_LABEL[o.status] ?? o.status]))
    download(`haiman-orders-${fmtDate(new Date().toISOString())}.csv`, rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv;charset=utf-8')
    toast(`已导出 ${list.length} 条订单`)
  }

  const doRefund = async (o: Order) => {
    setRefunding(o.id)
    try {
      const ok = await refund(o.id)
      if (ok) toast(`订单 ${o.id} 已退款`, 'info')
    } finally {
      setRefunding('')
    }
  }

  return (
    <>
      <PageHeader
        title="订单管理"
        sub={`共 ${list.length} 笔订单 · 有效金额 ${money(total)}`}
        actions={
          <Button variant="secondary" icon="download" onClick={exportCsv}>
            导出 CSV
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="flex gap-1 rounded-xl bg-slate-100/80 p-1">
            {(
              [
                ['all', '全部'],
                ['pending', '待支付'],
                ['paid', '已支付'],
                ['refunded', '已退款'],
                ['closed', '已关闭'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setStatus(k)} className={cn('h-8 rounded-lg px-3.5 text-[13px] transition', status === k ? 'bg-white font-semibold shadow-sm' : 'text-ink-500')}>
                {l}
              </button>
            ))}
          </div>
          <div className="relative w-72">
            <Icon name="search" size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
            <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="订单号 / 剧本 / 公司 / 邮箱" className={cn(inputCls, 'h-9 pl-9')} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-400">
                <th className="py-3 pl-5 font-medium">订单号</th>
                <th className="py-3 font-medium">剧本</th>
                <th className="py-3 font-medium">销售方式</th>
                <th className="py-3 font-medium">买家</th>
                <th className="py-3 font-medium">实付</th>
                <th className="py-3 font-medium">支付方式</th>
                <th className="py-3 font-medium">下单时间</th>
                <th className="py-3 font-medium">状态</th>
                <th className="py-3 pr-5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((o) => (
                <tr key={o.id} className="transition hover:bg-slate-50/70">
                  <td className="py-3 pl-5 font-mono text-xs text-ink-500">
                    {o.id}
                    {o.mine && <Badge className="ml-1.5 !text-[10px]">新</Badge>}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2.5">
                      <img src={o.cover} alt="" className="h-9 w-7 rounded object-cover" />
                      <span className="max-w-[160px] truncate font-medium">{o.scriptTitle}</span>
                    </div>
                  </td>
                  <td className="py-3 text-ink-600">{SALE_LABEL[o.saleType]}</td>
                  <td className="py-3">
                    <p className="font-medium">{o.buyer}</p>
                    <p className="text-xs text-ink-400">{o.company || o.email}</p>
                  </td>
                  <td className={cn('py-3 font-semibold', o.status === 'refunded' && 'text-ink-300 line-through')}>{money(o.paid)}</td>
                  <td className="py-3 text-ink-600">{o.payMethod}</td>
                  <td className="py-3 text-ink-500">{fmtDate(o.createdAt, true)}</td>
                  <td className="py-3">{StatusBadge({ o })}</td>
                  <td className="py-3 pr-5 text-right">
                    <button onClick={() => setView(o)} className="text-[13px] font-medium text-brand-700 hover:underline">
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <p className="py-14 text-center text-sm text-ink-400">没有符合条件的订单</p>}
        </div>
      </Card>

      <Modal open={!!view} onClose={() => setView(null)} side>
        {view && (() => {
          const o = state.orders.find((x) => x.id === view.id) ?? view
          return (
            <>
              <ModalHeader title={`订单 ${o.id}`} sub={fmtDate(o.createdAt, true)} onClose={() => setView(null)} />
              <div className="space-y-5 p-6">
                <div className="flex items-center justify-between gap-4 rounded-2xl bg-canvas p-4">
                  <div className="flex gap-4">
                    <img src={o.cover} alt="" className="h-20 w-[60px] rounded-lg object-cover" />
                    <div>
                      <p className="font-semibold">{o.scriptTitle}</p>
                      <p className="mt-1 text-xs text-ink-500">{SALE_LABEL[o.saleType]}</p>
                      <div className="mt-2"><StatusBadge o={o} /></div>
                    </div>
                  </div>
                  {o.tradeNo && <p className="font-mono text-xs text-ink-400">网关单号 {o.tradeNo}</p>}
                </div>
                <dl className="space-y-2.5 text-sm">
                  {[
                    ['联系人', o.buyer],
                    ['公司', o.company ?? ''],
                    ['邮箱', o.email],
                    ['国家/地区', o.country ?? ''],
                    ['支付方式', o.payMethod],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4">
                      <dt className="text-ink-500">{k}</dt>
                      <dd className="text-right font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-2 border-t border-dashed border-line pt-4 text-sm">
                  <div className="flex justify-between text-ink-500">
                    <span>原价</span>
                    <span>{money(o.original)}</span>
                  </div>
                  {o.discounts.map((d) => (
                    <div key={d.label} className="flex justify-between text-orange-600">
                      <span>{d.label}</span>
                      <span>-{money(d.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-1 text-base font-semibold">
                    <span>实付</span>
                    <span className="text-brand-700">{money(o.paid)}</span>
                  </div>
                </div>
                {o.status === 'paid' && (
                  <Button
                    variant="danger"
                    className="w-full"
                    icon="refresh"
                    disabled={refunding === o.id}
                    onClick={() => doRefund(o)}
                  >
                    {refunding === o.id ? '网关退款中…' : '办理退款'}
                  </Button>
                )}
              </div>
            </>
          )
        })()}
      </Modal>
    </>
  )
}
