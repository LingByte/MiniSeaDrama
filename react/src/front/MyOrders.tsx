import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Empty, Modal, cn, fmtDate, idx } from '../components/ui'
import { SALE_LABEL, STATUS_LABEL, money, type Order } from '../lib/data'
import { useAuth } from '../lib/auth'
import { downloadScript } from '../lib/files'
import { api } from '../lib/api'
import { go, useStore, type PayQr } from '../lib/store'

const BADGE_TONE: Record<string, 'green' | 'orange' | 'gray'> = { paid: 'green', pending: 'orange', refunded: 'gray', closed: 'gray' }

interface QrPay {
  order: Order
  qr: PayQr | null
  payUrl: string
}

export function MyOrders() {
  const { state, refresh, payOrder, toast } = useStore()
  const { user } = useAuth()
  const [payingId, setPayingId] = useState('')
  const [qrPay, setQrPay] = useState<QrPay | null>(null)
  const [checking, setChecking] = useState(false)
  const mine = state.orders.filter((o) => !!user && o.account === user.email)
  const hasPending = mine.some((o) => o.status === 'pending')

  // 存在待支付订单时自动轮询刷新（后端另有 30 秒保底轮询，双保险）
  useEffect(() => {
    if (!hasPending) return
    const t = setInterval(() => refresh(), 5000)
    return () => clearInterval(t)
  }, [hasPending, refresh])

  // 二维码弹窗开着时，订单一旦支付成功立即关闭并提示
  const paidNow = qrPay ? state.orders.find((o) => o.id === qrPay.order.id)?.status === 'paid' : false
  useEffect(() => {
    if (qrPay && paidNow) {
      setQrPay(null)
      toast('支付成功，剧本已解锁', 'success')
    }
  }, [paidNow, qrPay, toast])

  const continuePay = async (id: string) => {
    const order = state.orders.find((o) => o.id === id)
    setPayingId(id)
    try {
      const r = await payOrder(id)
      setQrPay({ order: order!, qr: r.qr, payUrl: r.payUrl })
      if (!r.qr) toast('未取到支付二维码，可在弹窗中打开收银台完成支付', 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : '获取支付二维码失败', 'error')
    } finally {
      setPayingId('')
    }
  }

  const checkPaid = async () => {
    if (!qrPay) return
    try {
      setChecking(true)
      const r = await api<{ order: Order }>(`/pay/status?out_trade_no=${qrPay.order.id}`)
      if (r.order.status === 'paid') {
        setQrPay(null)
        toast('支付成功，剧本已解锁', 'success')
      } else if (r.order.status !== 'pending') {
        setQrPay(null)
        toast(r.order.closedNote || '订单已关闭', 'error')
      } else {
        toast('尚未查询到支付结果，请稍后再试', 'info')
      }
      refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '查询失败', 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-5 pt-10 lg:px-8">
      <h1 className="text-2xl font-bold tracking-tight">我的订单</h1>
      <p className="mt-1 text-sm text-ink-500">购买成功后，完整剧本（Word 文件）会在这里解锁，可随时下载</p>
      {!user ? (
        <div className="mt-6">
          <Empty
            icon="lock"
            title="登录后查看订单"
            sub="登录账号后，你的购买记录会显示在这里"
            action={
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => go('/register')}>
                  注册
                </Button>
                <Button onClick={() => go('/login')}>登录</Button>
              </div>
            }
          />
        </div>
      ) : mine.length ? (
        <div className="stagger mt-6 space-y-3">
          {mine.map((o, i) => {
            const s = state.scripts.find((x) => x.id === o.scriptId)
            const paid = o.status === 'paid'
            const pending = o.status === 'pending'
            const fresh = paid && o.paidAt && Date.now() - +new Date(o.paidAt) < 5 * 60 * 1000
            return (
              <div key={o.id} style={idx(i)} className={cn('rounded-2xl border bg-white p-4 transition-shadow', fresh ? 'border-emerald-200 shadow-[0_16px_36px_-24px_rgba(16,185,129,.7)]' : 'border-line')}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <img src={o.cover} alt="" className={cn('h-24 w-[72px] rounded-xl object-cover', !paid && 'opacity-50 grayscale')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold">{o.scriptTitle}</p>
                      <Badge tone={o.saleType === 'buyout' ? 'rose' : 'brand'}>{SALE_LABEL[o.saleType]}</Badge>
                      <Badge tone={BADGE_TONE[o.status] ?? 'gray'}>{STATUS_LABEL[o.status] ?? o.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      订单号 {o.id} · {fmtDate(o.createdAt, true)} · {o.payMethod}
                    </p>
                    <p className="mt-2 text-sm">
                      {pending ? (
                        <span className="text-ink-500">
                          应付 <b className="text-brand-700">{money(o.paid)}</b> · 支付完成后自动解锁
                        </span>
                      ) : (
                        <>
                          实付 <b className={paid ? 'text-brand-700' : 'text-ink-400 line-through'}>{money(o.paid)}</b>
                        </>
                      )}
                    </p>
                  </div>
                  {pending ? (
                    <div className="flex gap-2 self-start sm:self-center">
                      <Button size="sm" onClick={() => continuePay(o.id)} disabled={payingId === o.id}>
                        {payingId === o.id ? '打开中…' : '继续支付'}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => go(`/script/${o.scriptId}`)}>
                        阅读
                      </Button>
                    </div>
                  ) : (
                    <Button variant="secondary" size="sm" className="self-start sm:self-center" onClick={() => go(`/script/${o.scriptId}`)}>
                      阅读
                    </Button>
                  )}
                </div>
                {/* 解锁区：支付成功后可下载管理员上传的完整剧本 Word 文件 */}
                <div className={cn('mt-4 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3', paid ? 'bg-emerald-50/70 ring-1 ring-emerald-100' : 'bg-slate-50 ring-1 ring-line')}>
                  <span className={cn('grid h-10 w-10 place-items-center rounded-lg', paid ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-ink-400')}>
                    <Icon name={paid ? 'file' : 'lock'} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-semibold', paid ? 'text-emerald-800' : 'text-ink-500')}>
                      {paid
                        ? fresh
                          ? '刚刚解锁 · 完整剧本'
                          : '已解锁 · 完整剧本'
                        : pending
                          ? '待支付 · 支付后解锁完整剧本'
                          : o.status === 'closed'
                            ? (o.closedNote || '订单已关闭 · 内容未解锁')
                            : '已退款 · 内容已锁定'}
                    </p>
                    <p className="truncate text-xs text-ink-500">{s?.fileName ?? `${o.scriptTitle}.docx`}</p>
                  </div>
                  {paid && (
                    <Button size="sm" icon="download" disabled={!s} onClick={() => s && downloadScript(s, toast)}>
                      下载 Word 剧本
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="mt-6">
          <Empty
            icon="receipt"
            title="还没有订单"
            sub="去剧本库挑一部，试读满意再下单"
            action={
              <Button onClick={() => go('/')}>
                <Icon name="grid" size={16} />
                浏览剧本库
              </Button>
            }
          />
        </div>
      )}

      {/* 继续支付：在当前页面弹二维码，不再跳转新窗口 */}
      {qrPay && (
        <Modal open onClose={() => setQrPay(null)} width="max-w-[400px]">
          <div className="px-6 pt-6 pb-5 text-center">
            <p className="text-[15px] font-semibold">支付宝扫码支付</p>
            <p className="mt-1.5 text-sm text-ink-500">打开支付宝「扫一扫」，扫描下方二维码</p>
            {qrPay.qr?.img ? (
              <img src={qrPay.qr.img} alt="支付宝收款二维码" className="anim-scale-in mx-auto mt-4 h-52 w-52 rounded-xl bg-white p-2 ring-1 ring-line" />
            ) : (
              <div className="mx-auto mt-4 grid h-52 w-52 place-items-center rounded-xl bg-white px-4 ring-1 ring-line">
                <p className="text-xs leading-relaxed text-ink-500">二维码获取失败，请点击下方链接完成支付</p>
              </div>
            )}
            <p className="mt-3 text-xs text-ink-400">
              {qrPay.order.scriptTitle} · {money(qrPay.order.paid)}
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={checkPaid} disabled={checking} className="min-w-[132px]">
                {checking ? '查询中…' : '已完成支付？查询结果'}
              </Button>
              <button
                onClick={() => qrPay.payUrl && window.open(qrPay.payUrl, '_blank', 'noopener')}
                className="text-center text-[13px] font-medium text-brand-700 hover:underline"
              >
                扫码遇到问题？点击在新窗口打开收银台
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
