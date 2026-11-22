import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, QualityBadge, cn, idx } from '../components/ui'
import { DEFAULT_GROUPS, PRICE_LABEL, SALE_LABEL, isBuyoutSold, money, qualityGrade, type SaleType, type Script } from '../lib/data'
import { api } from '../lib/api'
import { go, useStore } from '../lib/store'

// 品质按钮：每个等级一种颜色，与蓝色的情节标签区分开
const QUALITY_CHIP: Record<string, { on: string; off: string }> = {
  all: { on: 'bg-ink-900 text-white ring-ink-900', off: 'bg-white text-ink-600 ring-line hover:ring-ink-300' },
  S: { on: 'bg-amber-500 text-white ring-amber-500', off: 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100' },
  A: { on: 'bg-violet-600 text-white ring-violet-600', off: 'bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100' },
  B: { on: 'bg-emerald-600 text-white ring-emerald-600', off: 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100' },
  C: { on: 'bg-slate-600 text-white ring-slate-600', off: 'bg-slate-100 text-ink-600 ring-slate-200 hover:bg-slate-200' },
  D: { on: 'bg-orange-500 text-white ring-orange-500', off: 'bg-orange-50 text-orange-700 ring-orange-200 hover:bg-orange-100' },
}

const SALE_CHIP = {
  全部: { on: 'bg-ink-900 text-white ring-ink-900', off: 'bg-white text-ink-600 ring-line hover:ring-ink-300' },
  wholesale: { on: 'bg-sky-600 text-white ring-sky-600', off: 'bg-sky-50 text-sky-700 ring-sky-200 hover:bg-sky-100' },
  buyout: { on: 'bg-rose-500 text-white ring-rose-500', off: 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100' },
}

const SORTS = [
  ['hot', '综合推荐'],
  ['new', '最新上架'],
  ['sales', '销量最高'],
  ['priceAsc', '价格从低到高'],
  ['priceDesc', '价格从高到低'],
] as const

type ScriptsPage = {
  scripts: Script[]
  nextCursor?: string
  total: number
  onSaleTotal: number
  plotCounts: Record<string, number>
  featured: Script[]
  newCount: number
}

export function Home() {
  const { state } = useStore()
  const [plot, setPlot] = useState('全部')
  const [market, setMarket] = useState('全部市场')
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>('hot')
  const [q, setQ] = useState('')
  const [quality, setQuality] = useState('全部品质')
  const [tagSel, setTagSel] = useState('全部标签')
  const [plotOpen, setPlotOpen] = useState(false)
  const [saleF, setSaleF] = useState<'全部' | SaleType>('全部')
  const libRef = useRef<HTMLDivElement>(null)

  // 书架改走 /scripts 分页；bootstrap 不再下发剧本，不能再读 state.scripts
  const [list, setList] = useState<Script[]>([])
  const [featured, setFeatured] = useState<Script[]>([])
  const [onSaleTotal, setOnSaleTotal] = useState(0)
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [plotCount, setPlotCount] = useState<Record<string, number>>({})
  const [newCount, setNewCount] = useState(0)
  const [nextCursor, setNextCursor] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const groupTags = (id: string) => {
    const fromState = state.tagGroups.find((g) => g.id === id)?.tags ?? []
    if (fromState.length) return fromState
    return DEFAULT_GROUPS.find((g) => g.id === id)?.tags ?? []
  }
  const plotTags = Object.keys(plotCount)
    .filter((t) => (plotCount[t] ?? 0) > 0)
    .sort((a, b) => (plotCount[b] ?? 0) - (plotCount[a] ?? 0))
  const marketTags = groupTags('market')
  const qualityTags = groupTags('quality')
  const otherTags = state.tagGroups.filter((g) => !['plot', 'quality', 'market'].includes(g.id)).flatMap((g) => g.tags.map((t) => ({ key: `${g.id}::${t}`, label: `${g.name} · ${t}` })))
  const soldIds = new Set(list.filter((s) => isBuyoutSold(s)).map((s) => s.id))

  useEffect(() => {
    let alive = true
    setLoading(true)
    const qs = new URLSearchParams({ limit: '48', sort })
    if (plot !== '全部') qs.set('plot', plot)
    if (market !== '全部市场') qs.set('market', market)
    if (quality !== '全部品质') qs.set('quality', quality)
    if (saleF !== '全部') qs.set('saleType', saleF)
    if (tagSel !== '全部标签') qs.set('tag', tagSel)
    if (q.trim()) qs.set('q', q.trim())
    void api<ScriptsPage>(`/scripts?${qs}`)
      .then((r) => {
        if (!alive) return
        setList(r.scripts ?? [])
        setNextCursor(r.nextCursor ?? '')
        setFilteredTotal(r.total ?? 0)
        setOnSaleTotal(r.onSaleTotal ?? 0)
        setPlotCount(r.plotCounts ?? {})
        setFeatured((r.featured ?? []).slice(0, 3))
        setNewCount(r.newCount ?? 0)
      })
      .catch(() => {
        if (!alive) return
        setList([])
        setNextCursor('')
        setFilteredTotal(0)
        setOnSaleTotal(0)
        setPlotCount({})
        setFeatured([])
        setNewCount(0)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [plot, market, quality, saleF, tagSel, sort, q])

  const loadMore = () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const qs = new URLSearchParams({ limit: '48', sort, cursor: nextCursor })
    if (plot !== '全部') qs.set('plot', plot)
    if (market !== '全部市场') qs.set('market', market)
    if (quality !== '全部品质') qs.set('quality', quality)
    if (saleF !== '全部') qs.set('saleType', saleF)
    if (tagSel !== '全部标签') qs.set('tag', tagSel)
    if (q.trim()) qs.set('q', q.trim())
    void api<ScriptsPage>(`/scripts?${qs}`)
      .then((r) => {
        setList((prev) => [...prev, ...(r.scripts ?? [])])
        setNextCursor(r.nextCursor ?? '')
      })
      .finally(() => setLoadingMore(false))
  }

  const scrollLib = () => libRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <>
      {/* Hero — quiet lingpan density */}
      <section className="border-b border-border pb-10">
        <div className="grid items-end gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground">
              本月新上架 {newCount} 部
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">出海短剧剧本库</h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              按品质与情节标签筛选，免费试读前几集后再购买。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                scrollLib()
              }}
              className="mt-6 flex max-w-lg items-center gap-2 rounded-xl border border-border bg-card p-1"
            >
              <Icon name="search" className="ml-3 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索剧名、题材或关键词"
                className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <button type="submit" className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
                搜索
              </button>
            </form>
            <div className="mt-8 flex gap-8 text-sm">
              {[
                [onSaleTotal + '+', '在售'],
                ['6', '市场'],
                ['3 集', '试读'],
              ].map(([n, l]) => (
                <div key={l}>
                  <p className="text-lg font-semibold">{n}</p>
                  <p className="text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
          </div>

                    {/* 封面扇形展示 */}
          <div className="relative mx-auto hidden h-[460px] w-full max-w-[480px] lg:block">
            {featured.map((s, i) => {
              const pos = [
                'left-[6%] top-[60px] -rotate-[8deg] z-10',
                'left-1/2 -translate-x-1/2 top-0 z-20',
                'right-[6%] top-[60px] rotate-[8deg] z-10',
              ][i === 0 ? 1 : i === 1 ? 0 : 2]
              return (
                <button
                  key={s.id}
                  onClick={() => go(`/script/${s.id}`)}
                  className={cn('group absolute w-[210px] transition-all duration-500 ease-[var(--ease-smooth)] hover:z-30 hover:-translate-y-3', pos)}
                >
                  <div className="anim-float overflow-hidden rounded-2xl bg-white p-2 ring-1 ring-line" style={{ animationDelay: `${i * -2}s` }}>
                    <img src={s.cover} alt={s.title} className="aspect-[3/4] w-full rounded-xl object-cover" />
                    <div className="px-1.5 pt-2.5 pb-1 text-left">
                      <p className="truncate text-sm font-semibold">{s.title}</p>
                      <p className="mt-0.5 flex items-center justify-between text-xs text-ink-500">
                        <span>{s.tags.slice(0, 2).join(' · ')}</span>
                        <span className="font-semibold text-brand-700">{money(s.price)}</span>
                      </p>
                    </div>
                  </div>
                </button>
              )
            })}
            <div className="anim-float absolute bottom-6 -left-4 z-30 flex items-center gap-3 rounded-2xl bg-white/95 px-4 py-3 shadow-xl ring-1 ring-line backdrop-blur" style={{ animationDelay: '-3s' }}>
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
                <Icon name="trend" />
              </span>
              <div className="text-left">
                <p className="text-xs text-ink-500">在售剧本</p>
                <p className="text-sm font-semibold">{onSaleTotal} 部 · 持续更新</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 剧本库 · 书架 */}
      <section ref={libRef} className="mx-auto max-w-7xl scroll-mt-16 px-5 pt-16 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">剧本书架</h2>
            <p className="mt-1 text-sm text-ink-500">共 {filteredTotal} 部剧本 · 点击任意一本抽出试读</p>
          </div>
          <div className="flex items-center gap-2">
            {otherTags.length > 0 && <SelectBox value={tagSel} onChange={setTagSel} options={['全部标签', ...otherTags.map((t) => t.key)]} labels={{ 全部标签: '全部标签', ...Object.fromEntries(otherTags.map((t) => [t.key, t.label])) }} icon="hash" />}
            <SelectBox value={market} onChange={setMarket} options={['全部市场', ...marketTags]} icon="globe" />
            <SelectBox value={sort} onChange={(v) => setSort(v as typeof sort)} options={SORTS.map((s) => s[0])} labels={Object.fromEntries(SORTS)} icon="filter" />
          </div>
        </div>
        <div className="mt-5 divide-y divide-line rounded-2xl border border-line bg-white">
          <div className="flex items-start gap-4 px-5 py-4">
            <span className="w-9 shrink-0 pt-1.5 text-[13px] font-semibold text-ink-500">情节</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-2">
              <PlotChip active={plot === '全部'} onClick={() => setPlot('全部')} label="全部" count={onSaleTotal} />
              {(plotOpen ? plotTags : plotTags.slice(0, 9)).map((t) => (
                <PlotChip key={t} active={plot === t} onClick={() => setPlot(t)} label={t} count={plotCount[t] ?? 0} />
              ))}
              {plotTags.length > 9 && (
                <button onClick={() => setPlotOpen(!plotOpen)} className="flex h-8 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-brand-700 transition hover:bg-brand-50">
                  {plotOpen ? '收起' : `更多 ${plotTags.length - 9} 个`}
                  <Icon name="chevronDown" size={14} className={cn('transition-transform duration-300', plotOpen && 'rotate-180')} />
                </button>
              )}
              {q && (
                <button onClick={() => setQ('')} className="flex h-8 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-[13px] text-ink-700">
                  搜索：{q} <Icon name="x" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-start gap-4 px-5 py-4">
            <span className="w-9 shrink-0 pt-1.5 text-[13px] font-semibold text-ink-500">品质</span>
            <div className="flex flex-wrap gap-2">
              {['全部品质', ...qualityTags].map((t) => {
                const on = quality === t
                const c = t === '全部品质' ? QUALITY_CHIP.all : (QUALITY_CHIP[qualityGrade(t)] ?? QUALITY_CHIP.A)
                return (
                  <button
                    key={t}
                    onClick={() => setQuality(t)}
                    className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium ring-1 transition-all duration-200 active:scale-95', on ? c.on : c.off)}
                  >
                    {t !== '全部品质' && <Icon name="sparkle" size={13} />}
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex items-start gap-4 px-5 py-4">
            <span className="w-9 shrink-0 pt-1.5 text-[13px] font-semibold text-ink-500">类型</span>
            <div className="flex flex-wrap gap-2">
              {(['全部', 'wholesale', 'buyout'] as const).map((t) => {
                const on = saleF === t
                const c = SALE_CHIP[t]
                return (
                  <button key={t} onClick={() => setSaleF(t)} className={cn('flex h-8 items-center rounded-lg px-3.5 text-[13px] font-medium ring-1 transition-all duration-200 active:scale-95', on ? c.on : c.off)}>
                    {t === '全部' ? '全部' : SALE_LABEL[t]}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        {loading && !list.length ? (
          <div className="mt-10 grid place-items-center py-16 text-sm text-ink-500">加载书架中…</div>
        ) : list.length ? (
          <>
            <Bookshelf soldIds={soldIds} list={list} />
            {nextCursor && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded-xl border border-line bg-white px-5 py-2.5 text-sm font-medium text-ink-700 hover:border-brand-200 hover:text-brand-700 disabled:opacity-60"
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="mt-4">
            <Empty
              icon="search"
              title="书架上没有符合条件的剧本"
              sub="试试切换题材或清除搜索关键词"
              action={
                <button
                  className="text-sm font-medium text-brand-700"
                  onClick={() => {
                    setPlot('全部')
                    setMarket('全部市场')
                    setQuality('全部品质')
                    setSaleF('全部')
                    setTagSel('全部标签')
                    setQ('')
                  }}
                >
                  清除全部筛选
                </button>
              }
            />
          </div>
        )}
      </section>

      {/* 购买流程 */}
      <section className="mx-auto mt-24 max-w-7xl px-5 lg:px-8">
        <h2 className="text-center text-2xl font-bold tracking-tight">四步完成剧本采购</h2>
        <p className="mt-2 text-center text-sm text-ink-500">从挑选到下载剧本，最快 5 分钟</p>
        <div className="mt-10 grid gap-4 md:grid-cols-4">
          {[
            ['grid', '浏览剧本库', '按品质、情节标签、目标市场筛选，书架上随手翻看'],
            ['book', '免费试读', '每部剧本开放前 2–3 集完整内容'],
            ['tag', '登录并下单', '注册账号，确认订单后即可支付'],
            ['download', '下载完整剧本', '支付成功后随时在「我的订单」下载'],
          ].map(([icon, t, d], i) => (
            <div key={t} className="group relative rounded-2xl border border-line bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-brand-200 hover:shadow-[0_20px_40px_-28px_rgba(26,107,240,.6)]">
              <span className="absolute top-5 right-5 text-3xl font-bold text-brand-50 transition-colors group-hover:text-brand-100">0{i + 1}</span>
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600 transition-all duration-300 group-hover:bg-brand-600 group-hover:text-white">
                <Icon name={icon} size={20} />
              </span>
              <p className="mt-5 font-semibold">{t}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{d}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function SelectBox({ value, onChange, options, labels, icon }: { value: string; onChange: (v: string) => void; options: string[]; labels?: Record<string, string>; icon: string }) {
  return (
    <label className="relative flex h-10 items-center gap-2 rounded-xl border border-line bg-white pr-8 pl-3 text-sm text-ink-700 transition hover:border-brand-200">
      <Icon name={icon} size={15} className="text-ink-400" />
      <select value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
      {labels?.[value] ?? value}
      <Icon name="chevronDown" size={15} className="pointer-events-none absolute right-2.5 text-ink-400" />
    </label>
  )
}

function Bookshelf({ list, soldIds }: { list: Script[]; soldIds: Set<string> }) {
  return (
    <div className="stagger mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 sm:gap-5">
      {list.map((s, i) => (
        <Book key={s.id} s={s} sold={soldIds.has(s.id)} i={i} />
      ))}
    </div>
  )
}

function Book({ s, i, sold }: { s: Script; i: number; sold: boolean }) {
  return (
    <button
      onClick={() => go(`/script/${s.id}`)}
      style={idx(i)}
      aria-label={sold ? `${s.title}，已买断` : `${s.title}，免费试读`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-white text-left transition-all duration-300 hover:-translate-y-1 hover:border-brand-200 hover:shadow-[0_20px_40px_-24px_rgba(26,107,240,.45)]"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-slate-100">
        <img src={s.cover} alt={`${s.title} 封面`} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.04]" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        {sold && (
          <div className="absolute inset-0 grid place-items-center bg-black/50">
            <span className="-rotate-12 rounded-md border-2 border-white bg-rose-600/90 px-2.5 py-1 text-sm font-bold tracking-widest text-white shadow">已买断</span>
          </div>
        )}
        {s.quality && <QualityBadge q={s.quality.split(' ')[0]} className="absolute top-2 left-2 !px-1.5 shadow-sm" />}
        <span className="absolute top-2 right-2 flex items-center gap-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-ink-800 backdrop-blur">
          <Icon name="star" size={10} className="fill-amber-400 text-amber-400" />
          {s.rating.toFixed(1)}
        </span>
        {!sold && (
          <span className="absolute inset-x-0 top-1/2 mx-auto flex w-fit -translate-y-1/2 translate-y-2 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 opacity-0 shadow-lg transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
            <Icon name="book" size={13} />
            试读 {s.trialCount} 集
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-1 text-sm font-semibold text-ink-900 transition-colors group-hover:text-brand-700">{s.title}</p>
        <p className="mt-0.5 line-clamp-1 text-xs text-ink-500">
          {s.tags.slice(0, 2).join(' · ')}
          {s.tags.length ? ' · ' : ''}
          {s.totalEpisodes} 集
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-sm font-bold text-brand-700">
          <span className={cn(sold && 'text-ink-300 line-through')}>{money(s.price)}</span>
          <span className={cn('rounded px-1.5 py-px text-[10px] font-semibold', s.saleType === 'buyout' ? 'bg-rose-50 text-rose-600' : 'bg-sky-50 text-sky-700')}>{PRICE_LABEL[s.saleType]}</span>
        </p>
      </div>
    </button>
  )
}

function PlotChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex h-8 items-center gap-1.5 rounded-full pr-2.5 pl-3.5 text-[13px] font-medium transition-all duration-200 active:scale-95',
        active ? 'bg-brand-600 text-white' : 'bg-brand-50/70 text-ink-700 hover:bg-brand-100 hover:text-brand-800',
      )}
    >
      {label}
      <span className={cn('grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold tabular-nums transition-colors', active ? 'bg-white/25 text-white' : 'bg-white text-ink-400 group-hover:text-brand-700')}>{count}</span>
    </button>
  )
}
