import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, cn } from '../components/ui'
import { SALE_LABEL, STATUS_LABEL, money, type Order } from '../lib/data'
import { api } from '../lib/api'
import { go, useStore } from '../lib/store'

/** 支付完成后的浏览器回跳页：持续查询订单状态直到确认（后端另有保底轮询） */
export function PayReturn({ outTradeNo }: { outTradeNo: string }) {
  const { refresh, state, toast } = useStore()
  const [order, setOrder] = useState<Order | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (!outTradeNo) return
    let stop = false
    let tries = 0
    const tick = async () => {
      if (stop) return
      tries++
      try {
        const r = await api<{ order: Order }>(`/pay/status?out_trade_no=${outTradeNo}`)
        if (stop) return
        setOrder(r.order)
        setChecked(true)
        if (r.order.status === 'paid') {
          stop = true
          clearInterval(t)
          refresh()
        }
      } catch {
        /* 网络波动，下一轮重试 */
      }
      // 最多轮询 5 分钟
      if (tries > 120) {
        stop = true
        clearInterval(t)
        setChecked(true)
      }
    }
    tick()
    const t = setInterval(tick, 2500)
    return () => {
      stop = true
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outTradeNo])

  const s = order ? state.scripts.find((x) => x.id === order.scriptId) : null

  return (
    <div className="mx-auto max-w-xl px-5 pt-16 pb-10 lg:px-8">
      <div className="rounded-3xl border border-line bg-white p-8 text-center shadow-[0_24px_60px_-32px_rgba(15,27,45,.3)]">
        {!order ? (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand-50 text-brand-600">
              <span className="h-6 w-6 animate-spin rounded-full border-[3px] border-brand-200 border-t-brand-600" />
            </span>
            <h1 className="mt-5 text-xl font-bold">正在确认支付结果…</h1>
            <p className="mt-2 text-sm text-ink-500">订单号 {outTradeNo}，一般几秒内完成确认</p>
            <p className="mt-4 text-xs text-ink-400">如果长时间无结果，可能是支付未完成，可稍后在「我的订单」中查看</p>
            <div className="mt-6">
              <Button variant="secondary" onClick={() => go('/orders')}>
                查看我的订单
              </Button>
            </div>
          </>
        ) : order.status === 'paid' ? (
          <>
            <span className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30">
              <Icon name="check" size={30} stroke={3} />
            </span>
            <h1 className="mt-5 text-xl font-bold">支付成功</h1>
            <div className="mt-5 flex items-center gap-4 rounded-2xl bg-canvas p-4 text-left">
              {s && <img src={order.cover} alt="" className="h-16 w-12 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{order.scriptTitle}</p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-500">
                  <Badge tone={order.saleType === 'buyout' ? 'rose' : 'brand'}>{SALE_LABEL[order.saleType]}</Badge>
                  订单号 {order.id}
                </p>
              </div>
              <p className="font-bold text-brand-700">{money(order.paid)}</p>
            </div>
            <div className="mt-6 flex justify-center gap-3">
              <Button variant="secondary" onClick={() => go('/orders')}>
                查看我的订单
              </Button>
              {s && <Button onClick={() => go(`/script/${s.id}`)}>去阅读 / 下载</Button>}
            </div>
          </>
        ) : order.status === 'pending' ? (
          <>
            <span className={cn('mx-auto grid h-16 w-16 place-items-center rounded-full', checked ? 'bg-amber-50 text-amber-600' : 'bg-brand-50 text-brand-600')}>
              {checked ? <Icon name="info" size={28} /> : <span className="h-6 w-6 animate-spin rounded-full border-[3px] border-brand-200 border-t-brand-600" />}
            </span>
            <h1 className="mt-5 text-xl font-bold">{checked ? '支付还未确认' : '正在确认支付结果…'}</h1>
            <p className="mt-2 text-sm text-ink-500">订单 {order.id} · 状态 {STATUS_LABEL[order.status]}</p>
            <p className="mt-4 text-xs text-ink-400">
              {checked ? '如果已完成付款，稍等片刻后会自动确认；也可在我的订单里继续支付或查询' : '支付完成后会自动跳转'}
            </p>
            <div className="mt-6">
              <Button variant="secondary" onClick={() => go('/orders')}>
                去我的订单处理
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-rose-50 text-rose-500">
              <Icon name="x" size={28} />
            </span>
            <h1 className="mt-5 text-xl font-bold">订单{STATUS_LABEL[order.status] ?? order.status}</h1>
            <p className="mt-2 text-sm text-ink-500">{order.closedNote ?? `订单 ${order.id} 当前状态：${STATUS_LABEL[order.status]}`}</p>
            <div className="mt-6 flex justify-center gap-3">
              <Button variant="secondary" onClick={() => go('/orders')}>
                查看我的订单
              </Button>
              <Button onClick={() => toast('如有疑问请联系客服', 'info')}>联系客服</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
