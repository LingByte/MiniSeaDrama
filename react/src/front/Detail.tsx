import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Empty, QualityBadge, ScriptText, cn } from '../components/ui'
import { PRICE_LABEL, SALE_LABEL, SALE_NOTE, isBuyoutSold, money, quote } from '../lib/data'
import { downloadScript } from '../lib/files'
import { rememberNext, useAuth } from '../lib/auth'
import { go, useStore } from '../lib/store'
import { Checkout } from './Checkout'
import { ScriptCard } from './ScriptCard'


export function Detail({ id }: { id: string }) {
  const { state, toast } = useStore()
  const { user } = useAuth()
  const s = state.scripts.find((x) => x.id === id)
  const [ep, setEp] = useState(0)
  const [checkout, setCheckout] = useState(false)
  const [progress, setProgress] = useState(0)
  const readerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = readerRef.current
    if (!el) return
    const f = () => {
      const r = el.getBoundingClientRect()
      const total = r.height - window.innerHeight + 200
      setProgress(Math.min(1, Math.max(0, (200 - r.top) / Math.max(total, 1))))
    }
    window.addEventListener('scroll', f, { passive: true })
    f()
    return () => window.removeEventListener('scroll', f)
  }, [ep])

  if (!s || s.status !== 'on')
    return (
      <div className="mx-auto max-w-3xl px-5 py-24">
        <Empty icon="book" title="剧本不存在或已下架" action={<Button onClick={() => go('/')}>返回剧本库</Button>} />
      </div>
    )

  const owned = !!user && state.orders.some((o) => o.account === user.email && o.status === 'paid' && o.scriptId === s.id)
  const sold = !owned && isBuyoutSold(s)
  const q = quote(s)
  const buy = () => {
    if (sold) return toast('该剧本已被买断，暂不可购买', 'info')
    if (!user) {
      rememberNext(`/script/${s.id}`)
      toast('请先登录后再购买', 'info')
      return go('/login')
    }
    setCheckout(true)
  }
  const unlocked = owned ? s.episodes.length : s.trialCount
  const related = state.scripts.filter((x) => x.status === 'on' && x.id !== s.id && x.tags.some((g) => s.tags.includes(g))).slice(0, 4)
  const lockedPreview = Math.min(s.totalEpisodes - s.episodes.length, 5)

  return (
    <div className="mx-auto max-w-7xl px-5 pt-6 lg:px-8">
      <div className="fixed top-0 left-0 z-50 h-[3px] bg-brand-500 transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
      <button onClick={() => go('/')} className="group flex items-center gap-1.5 text-sm text-ink-500 transition hover:text-brand-700">
        <Icon name="arrowLeft" size={16} className="transition-transform group-hover:-translate-x-0.5" />
        剧本库
        <span className="text-ink-300">/</span>
        <span className="text-ink-800">{s.title}</span>
      </button>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          {/* 信息头 */}
          <section className="flex flex-col gap-7 rounded-3xl border border-line bg-white p-6 sm:flex-row md:p-7">
            <img src={s.cover} alt={s.title} className="aspect-[3/4] w-full rounded-2xl object-cover shadow-[0_20px_40px_-20px_rgba(15,27,45,.4)] sm:w-[200px]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-1.5">
                {s.quality && <QualityBadge q={s.quality} />}
                <Badge tone="gray">{s.audience}</Badge>
              </div>
              <h1 className="mt-3 text-[28px] leading-tight font-bold tracking-tight">{s.title}</h1>
              <p className="mt-1 text-ink-400">{s.enTitle}</p>
              <p className="mt-4 text-[15px] font-medium text-ink-800">“{s.logline}”</p>
              <p className="mt-3 text-sm leading-relaxed text-ink-500">{s.synopsis}</p>
              <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
                {[
                  ['总集数', `${s.totalEpisodes} 集`],
                  ['剧本语言', s.language],
                  ['评分', `${s.rating.toFixed(1)} / 5`],
                  ['已售', s.saleType === 'buyout' ? (isBuyoutSold(s) ? '已买断' : '待售') : `${s.sales} 次`],
                ].map(([k, v]) => (
                  <div key={k} className="bg-white px-4 py-3">
                    <dt className="text-xs text-ink-400">{k}</dt>
                    <dd className="mt-0.5 text-sm font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <Icon name="globe" size={14} className="text-brand-500" />
                适配市场：{s.markets.join('、')}
                <span className="mx-1 text-ink-300">|</span>
                {s.tags.map((t) => (
                  <span key={t} className="text-brand-700">
                    #{t}
                  </span>
                ))}
                {state.tagGroups.filter((g) => !['quality', 'plot', 'market'].includes(g.id)).flatMap((g) => (s.extra?.[g.id] ?? []).map((t) => (
                  <span key={g.id + t} className="rounded bg-slate-100 px-1.5 py-0.5 text-ink-600">
                    {g.name}：{t}
                  </span>
                )))}
              </div>
            </div>
          </section>

          {/* 试读 */}
          <section ref={readerRef} className="mt-8">
            <div className="flex items-end justify-between">
              <div>
                <h2 className="text-xl font-bold tracking-tight">{owned ? '剧本阅读' : '免费试读'}</h2>
                <p className="mt-1 text-sm text-ink-500">{owned ? '你已购买此剧本，可阅读并下载全部内容' : `开放前 ${s.trialCount} 集完整内容，购买后解锁全部 ${s.totalEpisodes} 集`}</p>
              </div>
              {owned && (
                <Button variant="soft" size="sm" icon="download" onClick={() => downloadScript(s, toast)}>
                  下载 Word 剧本
                </Button>
              )}
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-[200px_1fr]">
              <ol className="flex gap-2 overflow-x-auto md:sticky md:top-24 md:flex-col md:self-start md:overflow-visible">
                {s.episodes.map((e, i) => {
                  const locked = i >= unlocked
                  return (
                    <li key={i} className="shrink-0">
                      <button
                        onClick={() => (locked ? buy() : setEp(i))}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-200',
                          ep === i && !locked ? 'bg-brand-600 text-white shadow-[0_8px_20px_-10px_rgba(26,107,240,.9)]' : 'bg-white text-ink-700 ring-1 ring-line hover:ring-brand-200',
                          locked && 'text-ink-400',
                        )}
                      >
                        <span className={cn('text-xs font-semibold tabular-nums', ep === i && !locked ? 'text-white/70' : 'text-ink-400')}>EP{String(i + 1).padStart(2, '0')}</span>
                        <span className="flex-1 truncate">{e.title}</span>
                        {locked && <Icon name="lock" size={14} />}
                      </button>
                    </li>
                  )
                })}
                {Array.from({ length: lockedPreview }).map((_, k) => (
                  <li key={'l' + k} className="hidden shrink-0 md:block">
                    <button onClick={() => !owned && buy()} className="flex w-full items-center gap-3 rounded-xl bg-white/60 px-3 py-2.5 text-left text-sm text-ink-400 ring-1 ring-line transition hover:ring-brand-200">
                      <span className="text-xs font-semibold tabular-nums">EP{String(s.episodes.length + k + 1).padStart(2, '0')}</span>
                      <span className="flex-1">{owned ? '完整版文件' : '购买后解锁'}</span>
                      <Icon name="lock" size={14} />
                    </button>
                  </li>
                ))}
                <li className="hidden px-3 pt-1 text-xs text-ink-400 md:block">… 共 {s.totalEpisodes} 集</li>
              </ol>

              <article key={ep} className="anim-scale-in relative min-h-[420px] rounded-2xl border border-line bg-white px-6 py-7 md:px-10 md:py-9">
                <div className="mb-6 flex items-center justify-between border-b border-dashed border-line pb-4">
                  <div>
                    <p className="text-xs font-semibold tracking-[0.2em] text-brand-600">EPISODE {ep + 1}</p>
                    <h3 className="mt-1 text-lg font-bold">
                      第 {ep + 1} 集 · {s.episodes[ep]?.title}
                    </h3>
                  </div>
                  <span className="text-xs text-ink-400">约 {Math.max(1, Math.round((s.episodes[ep]?.text.length ?? 0) / 120))} 分钟时长</span>
                </div>
                <ScriptText text={s.episodes[ep]?.text ?? ''} />
                <div className="mt-10 flex items-center justify-between border-t border-line pt-5">
                  <Button variant="ghost" size="sm" icon="chevronLeft" disabled={ep === 0} onClick={() => setEp(ep - 1)}>
                    上一集
                  </Button>
                  {ep + 1 < unlocked ? (
                    <Button variant="soft" size="sm" onClick={() => setEp(ep + 1)}>
                      下一集 <Icon name="chevronRight" size={15} />
                    </Button>
                  ) : !owned ? (
                    <Button size="sm" icon="lock" onClick={() => buy()}>
                      试读结束，购买解锁全部 {s.totalEpisodes} 集
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-400">完整内容请下载剧本文件</span>
                  )}
                </div>
              </article>
            </div>
          </section>
        </div>

        {/* 购买卡 */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-3xl border border-line bg-white p-6 shadow-[0_24px_50px_-30px_rgba(26,107,240,.5)]">
            {owned ? (
              <div className="text-center">
                <span className="anim-pop mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-50 text-emerald-600">
                  <Icon name="check" size={26} stroke={2.5} />
                </span>
                <p className="mt-3 font-semibold">你已购买此剧本</p>
                <p className="mt-1 text-sm text-ink-500">可随时下载完整剧本</p>
                <Button className="mt-5 w-full" icon="download" onClick={() => downloadScript(s, toast)}>
                  下载 Word 剧本
                </Button>
                <Button variant="secondary" className="mt-2 w-full" onClick={() => go('/orders')}>
                  查看订单
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <Badge tone={s.saleType === 'buyout' ? 'orange' : 'brand'}>{SALE_LABEL[s.saleType]}剧本</Badge>
                  <span className="text-xs text-ink-500">{SALE_NOTE[s.saleType].short}</span>
                </div>
                <p className={cn('mt-3 rounded-xl px-3.5 py-3 text-[13px] leading-relaxed ring-1', s.saleType === 'buyout' ? 'bg-rose-50/60 text-rose-900/80 ring-rose-100' : 'bg-sky-50/60 text-sky-900/80 ring-sky-100')}>{SALE_NOTE[s.saleType].long}</p>
                <p className="mt-5 text-sm text-ink-500">{PRICE_LABEL[s.saleType]}</p>
                <p key={q.total} className={cn('anim-pop mt-1 text-[36px] leading-none font-bold tracking-tight', sold ? 'text-ink-300 line-through' : 'text-brand-700')}>
                  {money(q.total)}
                </p>
                {sold ? (
                  <div className="mt-5 rounded-xl bg-slate-100 px-4 py-3 text-center text-sm text-ink-500">
                    <Icon name="lock" size={15} className="mr-1.5 inline -translate-y-px" />
                    该剧本已被买断，暂不可购买
                  </div>
                ) : (
                  <Button size="lg" className="mt-5 w-full" icon="cart" onClick={buy}>
                    购买剧本
                  </Button>
                )}
                <ul className="mt-5 space-y-2 text-xs text-ink-500">
                  {['支付成功后在「我的订单」解锁，下载完整 Word 剧本', '购买记录永久保存，可随时重新下载', '支付方式：支付宝'].map((t) => (
                    <li key={t} className="flex items-center gap-2">
                      <Icon name="check" size={13} className="text-brand-500" />
                      {t}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>

      {related.length > 0 && (
        <section className="mt-16">
          <h2 className="text-xl font-bold tracking-tight">同题材推荐</h2>
          <div className="stagger mt-5 grid grid-cols-2 gap-4 md:grid-cols-4 lg:gap-6">
            {related.map((r, i) => (
              <ScriptCard key={r.id} s={r} i={i} />
            ))}
          </div>
        </section>
      )}

      <Checkout open={checkout} onClose={() => setCheckout(false)} script={s} />
    </div>
  )
}
