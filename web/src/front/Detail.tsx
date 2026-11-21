import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Empty, QualityBadge, ScriptText, cn } from '../components/ui'
import { PRICE_LABEL, SALE_LABEL, SALE_NOTE, isBuyoutSold, money, quote, type Script } from '../lib/data'
import { api } from '../lib/api'
import { downloadScript } from '../lib/files'
import { rememberNext, useAuth } from '../lib/auth'
import { go, useStore } from '../lib/store'
import { Checkout } from './Checkout'
import { ScriptCard } from './ScriptCard'

export function Detail({ id }: { id: string }) {
  const { state, toast } = useStore()
  const { user } = useAuth()
  const [full, setFull] = useState<Script | null>(null)
  const [fetchErr, setFetchErr] = useState(false)
  const [loading, setLoading] = useState(true)
  const [related, setRelated] = useState<Script[]>([])
  const s = full
  const [ep, setEp] = useState(0)
  const [checkout, setCheckout] = useState(false)
  const [progress, setProgress] = useState(0)
  const readerRef = useRef<HTMLDivElement>(null)

  // 书架已改为分页卡片（无正文），详情页始终按 id 拉试读/全文
  useEffect(() => {
    let alive = true
    setLoading(true)
    setFetchErr(false)
    setFull(null)
    setRelated([])
    setEp(0)
    void api<{ script: Script }>(`/scripts/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!alive) return
        if (r?.script) setFull(r.script)
        else setFetchErr(true)
      })
      .catch(() => {
        if (alive) setFetchErr(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, user])

  // 同题材推荐：按首个情节标签拉一页卡片，排除当前剧
  const relatedPlot = s?.tags?.[0] ?? ''
  useEffect(() => {
    if (!s?.id || !relatedPlot) return
    let alive = true
    const qs = new URLSearchParams({ limit: '8', sort: 'hot', plot: relatedPlot })
    void api<{ scripts: Script[] }>(`/scripts?${qs}`)
      .then((r) => {
        if (!alive) return
        setRelated((r.scripts ?? []).filter((x) => x.id !== s.id).slice(0, 4))
      })
      .catch(() => {
        /* 推荐失败不影响阅读 */
      })
    return () => {
      alive = false
    }
  }, [s?.id, relatedPlot])

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

  if (loading)
    return (
      <div className="grid min-h-[40vh] place-items-center text-sm text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-border border-t-primary" />
          <p className="mt-3">正在加载剧本…</p>
        </div>
      </div>
    )

  if (fetchErr || !s || s.status !== 'on')
    return (
      <div className="mx-auto max-w-3xl py-24">
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
  // 未购买：只信试读集数；接口也会截断 episodes，避免把后面集标题一起下发
  const trialN = Math.max(1, Math.floor(Number(s.trialCount)) || 1)
  const unlocked = owned ? s.episodes.length : Math.min(trialN, s.episodes.length || trialN)
  const lockedPreview = Math.min(Math.max(0, (s.totalEpisodes || 0) - unlocked), 12)

  return (
    <div className="pt-2">
      <div className="fixed top-0 left-0 z-50 h-0.5 bg-primary transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
      <button onClick={() => go('/')} className="group flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground">
        <Icon name="arrowLeft" size={16} className="transition-transform group-hover:-translate-x-0.5" />
        剧本库
        <span className="text-border">/</span>
        <span className="text-foreground">{s.title}</span>
      </button>

      <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <section className="flex flex-col gap-6 rounded-xl border border-border bg-card p-5 sm:flex-row">
            <img src={s.cover} alt={s.title} className="aspect-[3/4] w-full rounded-xl object-cover sm:w-[180px]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-1.5">
                {s.quality && <QualityBadge q={s.quality} />}
                <Badge tone="gray">{s.audience}</Badge>
              </div>
              <h1 className="mt-3 text-2xl leading-tight font-semibold tracking-tight">{s.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{s.enTitle}</p>
              <p className="mt-3 text-sm font-medium text-foreground">“{s.logline}”</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.synopsis}</p>
              <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
                {[
                  ['总集数', `${s.totalEpisodes} 集`],
                  ['剧本语言', s.language],
                  ['评分', `${s.rating.toFixed(1)} / 5`],
                  ['已售', s.saleType === 'buyout' ? (isBuyoutSold(s) ? '已买断' : '待售') : `${s.sales} 次`],
                ].map(([k, v]) => (
                  <div key={k} className="bg-card px-3 py-2.5">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="mt-0.5 text-sm font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Icon name="globe" size={14} />
                适配市场：{s.markets.join('、')}
                <span className="mx-1 text-border">|</span>
                {s.tags.map((t) => (
                  <span key={t} className="text-foreground">
                    #{t}
                  </span>
                ))}
                {state.tagGroups
                  .filter((g) => !['quality', 'plot', 'market'].includes(g.id))
                  .flatMap((g) =>
                    (s.extra?.[g.id] ?? []).map((t) => (
                      <span key={g.id + t} className="rounded border border-border bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {g.name}：{t}
                      </span>
                    )),
                  )}
              </div>
            </div>
          </section>

          <section ref={readerRef} className="mt-6">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{owned ? '剧本阅读' : '免费试读'}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{owned ? '你已购买此剧本，可阅读并下载全部内容' : `开放前 ${s.trialCount} 集完整内容，购买后解锁全部 ${s.totalEpisodes} 集`}</p>
              </div>
              {owned && (
                <Button variant="soft" size="sm" icon="download" onClick={() => downloadScript(s, toast)}>
                  下载 Word 剧本
                </Button>
              )}
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-[180px_1fr]">
              <ol className="flex gap-2 overflow-x-auto md:sticky md:top-24 md:flex-col md:self-start md:overflow-visible">
                {s.episodes.map((e, i) => {
                  const locked = i >= unlocked
                  return (
                    <li key={i} className="shrink-0">
                      <button
                        onClick={() => (locked ? buy() : setEp(i))}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition',
                          ep === i && !locked ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-foreground hover:bg-muted/50',
                          locked && 'text-muted-foreground',
                        )}
                      >
                        <span className={cn('text-xs font-semibold tabular-nums', ep === i && !locked ? 'text-primary-foreground/70' : 'text-muted-foreground')}>EP{String(i + 1).padStart(2, '0')}</span>
                        <span className="flex-1 truncate">{e.title}</span>
                        {locked && <Icon name="lock" size={14} />}
                      </button>
                    </li>
                  )
                })}
                {Array.from({ length: lockedPreview }).map((_, k) => (
                  <li key={'l' + k} className="hidden shrink-0 md:block">
                    <button onClick={() => !owned && buy()} className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50">
                      <span className="text-xs font-semibold tabular-nums">EP{String(s.episodes.length + k + 1).padStart(2, '0')}</span>
                      <span className="flex-1">{owned ? '完整版文件' : '购买后解锁'}</span>
                      <Icon name="lock" size={14} />
                    </button>
                  </li>
                ))}
                <li className="hidden px-3 pt-1 text-xs text-muted-foreground md:block">… 共 {s.totalEpisodes} 集</li>
              </ol>

              <article key={ep} className="anim-scale-in relative min-h-[420px] rounded-xl border border-border bg-card px-5 py-6 md:px-8 md:py-8">
                <div className="mb-5 flex items-center justify-between border-b border-dashed border-border pb-4">
                  <div>
                    <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground">EPISODE {ep + 1}</p>
                    <h3 className="mt-1 text-base font-semibold">{episodeHeading(ep, s.episodes[ep]?.title)}</h3>
                  </div>
                  <span className="text-xs text-muted-foreground">约 {Math.max(1, Math.round((s.episodes[ep]?.text.length ?? 0) / 120))} 分钟时长</span>
                </div>
                <ScriptText text={s.episodes[ep]?.text ?? ''} />
                <div className="mt-8 flex items-center justify-between border-t border-border pt-4">
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
                    <span className="text-xs text-muted-foreground">完整内容请下载剧本文件</span>
                  )}
                </div>
              </article>
            </div>
          </section>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-5">
            {owned ? (
              <div className="text-center">
                <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-50 text-emerald-700">
                  <Icon name="check" size={24} stroke={2.5} />
                </span>
                <p className="mt-3 text-sm font-semibold">你已购买此剧本</p>
                <p className="mt-1 text-sm text-muted-foreground">可随时下载完整剧本</p>
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
                  <span className="text-xs text-muted-foreground">{SALE_NOTE[s.saleType].short}</span>
                </div>
                <p className="mt-3 rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground">{SALE_NOTE[s.saleType].long}</p>
                <p className="mt-4 text-sm text-muted-foreground">{PRICE_LABEL[s.saleType]}</p>
                <p key={q.total} className={cn('mt-1 text-3xl leading-none font-semibold tracking-tight', sold ? 'text-muted-foreground line-through' : 'text-foreground')}>
                  {money(q.total)}
                </p>
                {sold ? (
                  <div className="mt-5 rounded-xl bg-muted px-4 py-3 text-center text-sm text-muted-foreground">
                    <Icon name="lock" size={15} className="mr-1.5 inline -translate-y-px" />
                    该剧本已被买断，暂不可购买
                  </div>
                ) : (
                  <Button size="lg" className="mt-5 w-full" icon="cart" onClick={buy}>
                    购买剧本
                  </Button>
                )}
                <ul className="mt-5 space-y-2 text-xs text-muted-foreground">
                  {['支付成功后在「我的订单」解锁，下载完整 Word 剧本', '购买记录永久保存，可随时重新下载', '支付方式：支付宝'].map((t) => (
                    <li key={t} className="flex items-center gap-2">
                      <Icon name="check" size={13} className="text-primary" />
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
        <section className="mt-12">
          <h2 className="text-lg font-semibold tracking-tight">同题材推荐</h2>
          <div className="stagger mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:gap-4">
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

/** 标题已是「第 N 集」时不再叠一层「第 i 集 ·」 */
function episodeHeading(index: number, title?: string) {
  const t = (title || '').trim()
  if (!t) return `第 ${index + 1} 集`
  if (/^第\s*\d+\s*集/.test(t)) return t
  return `第 ${index + 1} 集 · ${t}`
}
