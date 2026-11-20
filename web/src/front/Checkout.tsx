import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Field, Modal, ModalHeader, cn, inputCls } from '../components/ui'
import { PRICE_LABEL, SALE_LABEL, SALE_NOTE, money, quote, type Order, type Script } from '../lib/data'
import { downloadScript } from '../lib/files'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { go, useStore, type PayQr } from '../lib/store'

const STEPS = ['确认订单', '买家信息', '支付']
// 仅支持支付宝扫码支付
const CHANNEL = { key: 'alipay', label: '支付宝', hint: '支付宝扫码支付', cls: 'bg-[#1677ff] text-white', char: '支' } as const

export function Checkout({ open, onClose, script: s }: { open: boolean; onClose: () => void; script: Script }) {
  const { user } = useAuth()
  const { placeOrder, refresh, toast } = useStore()
  const [step, setStep] = useState(0)
  const [info, setInfo] = useState({ buyer: '', company: '', email: '' })
  const [paying, setPaying] = useState(false)
  const [done, setDone] = useState<Order | null>(null)
  const [touched, setTouched] = useState(false)
  const [payUrl, setPayUrl] = useState('')
  const [qr, setQr] = useState<PayQr | null>(null)
  const [orderId, setOrderId] = useState('')
  const [checking, setChecking] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (open) {
      setStep(0)
      setDone(null)
      setPaying(false)
      setTouched(false)
      setPayUrl('')
      setQr(null)
      setOrderId('')
      setInfo((i) => ({ ...i, email: i.email || user?.email || '' }))
    }
  }, [open])

  const q = quote(s)
  const emailOk = /^\S+@\S+\.\S+$/.test(info.email)
  const infoOk = info.buyer.trim() && emailOk

  /** 查询一次支付状态；支付成功则刷新全局数据 */
  const checkStatus = async () => {
    if (!orderId || done) return null
    try {
      setChecking(true)
      const r = await api<{ order: Order }>(`/pay/status?out_trade_no=${orderId}`)
      if (r.order.status === 'paid') {
        setDone(r.order)
        refresh()
      } else if (r.order.status === 'closed') {
        toast(r.order.closedNote || '订单已关闭', 'error')
        setOrderId('')
        setPayUrl('')
        setQr(null)
      }
      return r.order
    } catch {
      return null
    } finally {
      setChecking(false)
    }
  }

  // 已发起支付后自动轮询，确认支付结果（后端另有 30 秒保底轮询）
  useEffect(() => {
    if (!orderId || done) return
    timer.current = setInterval(checkStatus, 3000)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, done])

  const submit = async () => {
    setPaying(true)
    try {
      const r = await placeOrder({
        scriptId: s.id,
        buyer: info.buyer.trim(),
        company: info.company.trim(),
        email: info.email.trim(),
        type: CHANNEL.key,
      })
      setPayUrl(r.payUrl)
      setQr(r.qr)
      setOrderId(r.order.id)
      toast(r.qr ? '请使用支付宝扫一扫完成支付' : '未取到支付二维码，可点击下方链接打开收银台', r.qr ? 'info' : 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : '下单失败，请稍后再试', 'error')
    } finally {
      setPaying(false)
    }
  }

  const reopenPay = () => {
    if (payUrl) window.open(payUrl, '_blank', 'noopener')
  }

  return (
    <Modal open={open} onClose={onClose} width="max-w-[560px]">
      {done ? (
        <div className="px-6 pt-8 pb-6 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-600 text-white">
            <Icon name="check" size={28} stroke={3} />
          </span>
          <h3 className="mt-5 text-xl font-semibold">支付成功</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            订单号 {done.id} · 订单确认已发送至 {done.email}
          </p>
          <div className="mt-5 flex items-center gap-4 rounded-xl border border-border bg-muted/40 p-4 text-left">
            <img src={s.cover} alt="" className="h-16 w-12 rounded-lg object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{s.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {SALE_LABEL[s.saleType]} · {s.totalEpisodes} 集
              </p>
            </div>
            <p className="font-semibold text-foreground">{money(done.paid)}</p>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => (onClose(), go('/orders'))}>
              查看订单
            </Button>
            <Button icon="download" onClick={() => downloadScript(s, toast)}>
              下载 Word 剧本
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ModalHeader title="购买剧本" sub={`${s.title} · ${s.enTitle}`} onClose={onClose} />
          {/* 步骤条 */}
          <div className="flex items-center gap-2 px-5 pt-4">
            {STEPS.map((t, i) => (
              <div key={t} className="flex flex-1 items-center gap-2">
                <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold', i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                  {i < step ? <Icon name="check" size={13} stroke={3} /> : i + 1}
                </span>
                <span className={cn('text-[13px]', i <= step ? 'font-medium text-foreground' : 'text-muted-foreground')}>{t}</span>
                {i < STEPS.length - 1 && (
                  <span className="relative h-px flex-1 bg-border">
                    <span className={cn('absolute inset-y-0 left-0 bg-primary transition-all', i < step ? 'w-full' : 'w-0')} />
                  </span>
                )}
              </div>
            ))}
          </div>

          <div key={step} className="anim-scale-in px-5 py-5">
            {step === 0 && (
              <div className="space-y-4">
                <div className="flex gap-4 rounded-xl border border-border p-4">
                  <img src={s.cover} alt="" className="h-24 w-[72px] rounded-lg object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{s.title}</p>
                    <p className="text-xs text-muted-foreground">{s.enTitle}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {s.tags.slice(0, 2).join(' · ')} · {s.totalEpisodes} 集 · {s.language}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-muted/40 px-4 py-3.5">
                  <Badge tone={s.saleType === 'buyout' ? 'rose' : 'brand'}>{SALE_LABEL[s.saleType]}</Badge>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{SALE_NOTE[s.saleType].long}</p>
                </div>
                <Summary q={q} label={PRICE_LABEL[s.saleType]} />
              </div>
            )}
            {step === 1 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="联系人" required error={touched && !info.buyer.trim() ? '请填写联系人' : undefined}>
                  <input className={inputCls} value={info.buyer} onChange={(e) => setInfo({ ...info, buyer: e.target.value })} placeholder="你的姓名" />
                </Field>
                <Field label="邮箱" required error={touched && !emailOk ? '请输入有效邮箱' : undefined}>
                  <input className={inputCls} value={info.email} onChange={(e) => setInfo({ ...info, email: e.target.value })} placeholder="name@company.com" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="公司" hint="选填">
                    <input className={inputCls} value={info.company} onChange={(e) => setInfo({ ...info, company: e.target.value })} placeholder="公司或工作室名称" />
                  </Field>
                </div>
              </div>
            )}
            {step === 2 && !payUrl && (
              <div className="space-y-4">
                {!s.fileName && (
                  <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-[13px] leading-relaxed text-orange-700">
                    该剧本尚未上传完整 Word 文件，暂时无法下单。请等待商家在后台补传剧本文件后再购买，避免付款后无文件可下载。
                  </div>
                )}
                <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
                  <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl text-base font-bold', CHANNEL.cls)}>{CHANNEL.char}</span>
                  <span>
                    <span className="block text-sm font-semibold">{CHANNEL.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{CHANNEL.hint}</span>
                  </span>
                </div>
                <Summary q={q} label={PRICE_LABEL[s.saleType]} compact />
              </div>
            )}
            {step === 2 && payUrl && (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-card p-5 text-center">
                  <p className="text-sm font-semibold">支付宝扫码支付</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">打开支付宝「扫一扫」，扫描下方二维码完成付款</p>
                  {qr?.img ? (
                    <img
                      src={qr.img}
                      alt="支付宝收款二维码"
                      className="anim-scale-in mx-auto mt-4 h-52 w-52 rounded-xl border border-border bg-card p-2"
                    />
                  ) : (
                    <div className="mx-auto mt-4 grid h-52 w-52 place-items-center rounded-xl border border-border bg-card px-4">
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        二维码获取失败<br />可点击下方链接在新窗口完成支付
                      </p>
                    </div>
                  )}
                  <p className="mt-4 text-xs text-muted-foreground">
                    订单号 {orderId} · {CHANNEL.label} · {money(q.total)}
                  </p>
                  <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    {checking ? (
                      <>
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
                        正在确认支付结果…
                      </>
                    ) : (
                      <>支付完成后本页会自动确认，无需刷新</>
                    )}
                  </p>
                </div>
                <button onClick={reopenPay} className="w-full text-center text-[13px] font-medium text-primary hover:underline">
                  扫码遇到问题？点击在新窗口打开收银台
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <div>
              <p className="text-xs text-muted-foreground">应付</p>
              <p className="text-lg font-semibold text-foreground">{money(q.total)}</p>
            </div>
            <div className="flex gap-2">
              {step > 0 && !payUrl && (
                <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={paying}>
                  上一步
                </Button>
              )}
              {step < 2 ? (
                <Button
                  onClick={() => {
                    if (step === 1 && !infoOk) return setTouched(true)
                    setStep(step + 1)
                  }}
                >
                  下一步 <Icon name="arrowRight" size={15} />
                </Button>
              ) : !payUrl ? (
                <Button
                  loading={paying}
                  disabled={!s.fileName}
                  className="min-w-[132px]"
                  onClick={() => {
                    void submit()
                  }}
                >
                  {!s.fileName ? '剧本文件准备中' : paying ? '正在创建订单' : `前往支付 ${money(q.total)}`}
                </Button>
              ) : (
                <Button
                  loading={checking}
                  className="min-w-[132px]"
                  onClick={() => {
                    void checkStatus()
                  }}
                >
                  {checking ? '查询中…' : '已完成支付？查询'}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

function Summary({ q, compact, label }: { q: ReturnType<typeof quote>; compact?: boolean; label: string }) {
  return (
    <div className={cn('space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-sm', compact && 'py-3')}>
      <div className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span>{money(q.base)}</span>
      </div>
      {q.lines.map((l) => (
        <div key={l.label} className="flex justify-between text-orange-700">
          <span>{l.label}</span>
          <span>-{money(l.amount)}</span>
        </div>
      ))}
      {!compact && (
        <div className="flex justify-between border-t border-border pt-2 font-semibold">
          <span>合计</span>
          <span className="text-foreground">{money(q.total)}</span>
        </div>
      )}
    </div>
  )
}
