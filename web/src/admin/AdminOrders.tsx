import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Modal, ModalHeader, cn, download, fmtDate, inputCls } from '../components/ui'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {(
              [
                ['all', '全部'],
                ['pending', '待支付'],
                ['paid', '已支付'],
                ['refunded', '已退款'],
                ['closed', '已关闭'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setStatus(k)} className={cn('h-8 rounded-lg px-3 text-[13px] transition', status === k ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')}>
                {l}
              </button>
            ))}
          </div>
          <div className="relative w-72">
            <Icon name="search" size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="订单号 / 剧本 / 公司 / 邮箱" className={cn(inputCls, 'h-9 pl-9')} />
          </div>
        </div>
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">订单号</TableHead>
              <TableHead>剧本</TableHead>
              <TableHead>销售方式</TableHead>
              <TableHead>买家</TableHead>
              <TableHead>实付</TableHead>
              <TableHead>支付方式</TableHead>
              <TableHead>下单时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="pr-4 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="pl-4 font-mono text-xs text-muted-foreground">
                  {o.id}
                  {o.mine && <Badge className="ml-1.5 !text-[10px]">新</Badge>}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <img src={o.cover} alt="" className="h-9 w-7 rounded object-cover" />
                    <span className="max-w-[160px] truncate text-sm font-medium">{o.scriptTitle}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{SALE_LABEL[o.saleType]}</TableCell>
                <TableCell className="whitespace-normal">
                  <p className="text-sm font-medium">{o.buyer}</p>
                  <p className="text-xs text-muted-foreground">{o.company || o.email}</p>
                </TableCell>
                <TableCell className={cn('font-medium', o.status === 'refunded' && 'text-muted-foreground line-through')}>{money(o.paid)}</TableCell>
                <TableCell className="text-muted-foreground">{o.payMethod}</TableCell>
                <TableCell className="text-muted-foreground">{fmtDate(o.createdAt, true)}</TableCell>
                <TableCell>{StatusBadge({ o })}</TableCell>
                <TableCell className="pr-4 text-right">
                  <button onClick={() => setView(o)} className="text-[13px] font-medium text-primary hover:underline">
                    详情
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!list.length && <p className="py-14 text-center text-sm text-muted-foreground">没有符合条件的订单</p>}
      </Card>

      <Modal open={!!view} onClose={() => setView(null)} side>
        {view && (() => {
          const o = state.orders.find((x) => x.id === view.id) ?? view
          return (
            <>
              <ModalHeader title={`订单 ${o.id}`} sub={fmtDate(o.createdAt, true)} onClose={() => setView(null)} />
              <div className="space-y-5 p-5">
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/40 p-4">
                  <div className="flex gap-4">
                    <img src={o.cover} alt="" className="h-20 w-[60px] rounded-lg object-cover" />
                    <div>
                      <p className="text-sm font-semibold">{o.scriptTitle}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{SALE_LABEL[o.saleType]}</p>
                      <div className="mt-2"><StatusBadge o={o} /></div>
                    </div>
                  </div>
                  {o.tradeNo && <p className="font-mono text-xs text-muted-foreground">网关单号 {o.tradeNo}</p>}
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
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="text-right font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-2 border-t border-dashed border-border pt-4 text-sm">
                  <div className="flex justify-between text-muted-foreground">
                    <span>原价</span>
                    <span>{money(o.original)}</span>
                  </div>
                  {o.discounts.map((d) => (
                    <div key={d.label} className="flex justify-between text-orange-700">
                      <span>{d.label}</span>
                      <span>-{money(d.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-1 text-base font-semibold">
                    <span>实付</span>
                    <span className="text-foreground">{money(o.paid)}</span>
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
