import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Empty, QualityBadge, cn, idx } from '../components/ui'
import { PRICE_LABEL, SALE_LABEL, getVals, isBuyoutSold, money, qualityGrade, type SaleType, type Script } from '../lib/data'
import { go, useStore } from '../lib/store'

const QUALITY_CHIP: Record<string, { on: string; off: string }> = {
  all: { on: 'bg-primary text-primary-foreground', off: 'bg-card text-muted-foreground border border-border hover:text-foreground' },
  S: { on: 'bg-amber-600 text-white', off: 'bg-card text-amber-800 border border-border hover:bg-muted' },
  A: { on: 'bg-primary text-primary-foreground', off: 'bg-card text-foreground border border-border hover:bg-muted' },
  B: { on: 'bg-emerald-700 text-white', off: 'bg-card text-emerald-800 border border-border hover:bg-muted' },
  C: { on: 'bg-muted-foreground text-background', off: 'bg-card text-muted-foreground border border-border hover:bg-muted' },
  D: { on: 'bg-orange-600 text-white', off: 'bg-card text-orange-800 border border-border hover:bg-muted' },
}

const SALE_CHIP = {
  全部: { on: 'bg-primary text-primary-foreground', off: 'bg-card text-muted-foreground border border-border hover:text-foreground' },
  wholesale: { on: 'bg-primary text-primary-foreground', off: 'bg-card text-muted-foreground border border-border hover:text-foreground' },
  buyout: { on: 'bg-foreground text-background', off: 'bg-card text-muted-foreground border border-border hover:text-foreground' },
}

const SORTS = [
  ['hot', '综合推荐'],
  ['new', '最新上架'],
  ['sales', '销量最高'],
  ['priceAsc', '价格从低到高'],
  ['priceDesc', '价格从高到低'],
] as const

function scriptSearchBlob(s: Script) {
  return [s.title, s.enTitle, s.logline, s.synopsis, s.quality, s.language, ...s.tags, ...s.markets].join(' ').toLowerCase()
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

  const onSale = state.scripts.filter((s) => s.status === 'on')
  const soldIds = new Set(state.scripts.filter((s) => isBuyoutSold(s)).map((s) => s.id))
  const groupTags = (id: string) => state.tagGroups.find((g) => g.id === id)?.tags ?? []
  const plotCount = new Map<string, number>()
  onSale.forEach((s) => s.tags.forEach((t) => plotCount.set(t, (plotCount.get(t) ?? 0) + 1)))
  // 展示标签库全部情节标签（含 0 部在售）
  const plotTags = [...groupTags('plot')].sort((a, b) => (plotCount.get(b) ?? 0) - (plotCount.get(a) ?? 0))
  const marketTags = groupTags('market')
  const qualityTags = groupTags('quality')
  const otherTags = state.tagGroups.filter((g) => !['plot', 'quality', 'market'].includes(g.id)).flatMap((g) => g.tags.map((t) => ({ key: `${g.id}::${t}`, label: `${g.name} · ${t}` })))
  const featured = [...onSale].sort((a, b) => b.sales - a.sales).slice(0, 4)
  const newCount = onSale.filter((s) => Date.now() - +new Date(s.createdAt) < 30 * 864e5).length

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const r = onSale.filter(
      (s) =>
        (plot === '全部' || s.tags.includes(plot)) &&
        (market === '全部市场' || s.markets.includes(market)) &&
        (quality === '全部品质' || s.quality === quality) &&
        (saleF === '全部' || s.saleType === saleF) &&
        (tagSel === '全部标签' || getVals(s, tagSel.split('::')[0]).includes(tagSel.split('::')[1])) &&
        (!kw || scriptSearchBlob(s).includes(kw)),
    )
    const price = (s: (typeof r)[number]) => s.price
    const by: Record<string, (a: (typeof r)[number], b: (typeof r)[number]) => number> = {
      hot: (a, b) => b.sales * b.rating - a.sales * a.rating,
      new: (a, b) => b.createdAt.localeCompare(a.createdAt),
      sales: (a, b) => b.sales - a.sales,
      priceAsc: (a, b) => price(a) - price(b),
      priceDesc: (a, b) => price(b) - price(a),
    }
    return r.sort(by[sort])
  }, [onSale, plot, market, quality, saleF, tagSel, sort, q])

  const scrollLib = () => libRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <>
      <section className="relative -mx-4 -mt-6 overflow-hidden border-b border-border lg:-mx-6">
        <div className="absolute inset-0">
          {featured[0] ? (
            <img src={featured[0].cover} alt="" className="h-full w-full scale-105 object-cover opacity-[0.18]" />
          ) : (
            <div className="h-full w-full bg-muted" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-background/70 via-background/88 to-background" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_55%)]" />
        </div>

        <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 pt-14 pb-12 lg:grid-cols-[1.05fr_0.95fr] lg:px-6 lg:pt-16 lg:pb-14">
          <div className="anim-fade-in max-w-xl">
            <p className="text-[11px] font-semibold tracking-[0.22em] text-primary">HAIMAN</p>
            <h1 className="mt-2 text-[2.35rem] leading-[1.1] font-bold tracking-tight md:text-5xl">至简海漫</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-[15px]">
              出海短剧剧本库 · 按品质与情节筛选，免费试读后再购买
              {newCount > 0 ? ` · 本月新上架 ${newCount} 部` : ''}
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                scrollLib()
              }}
              className="mt-7 flex max-w-md items-center gap-2 rounded-xl border border-border bg-card/90 p-1 shadow-sm backdrop-blur"
            >
              <Icon name="search" className="ml-3 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索剧名、题材或关键词"
                className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {q && (
                <button type="button" onClick={() => setQ('')} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition active:scale-90 hover:bg-muted" aria-label="清除">
                  <Icon name="x" size={14} />
                </button>
              )}
              <button type="submit" className="h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.97]">
                搜索
              </button>
            </form>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={scrollLib}
                className="h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90 active:scale-[0.97]"
              >
                浏览书架
              </button>
              <span className="text-xs text-muted-foreground">在售 {onSale.length} 部 · 前 3 集可试读</span>
            </div>
          </div>

          <div className="relative mx-auto hidden h-[380px] w-full max-w-[460px] lg:block">
            {featured.slice(0, 3).map((s, i) => {
              const pos = [
                'left-[4%] top-[64px] -rotate-[7deg] z-10',
                'left-1/2 -translate-x-1/2 top-2 z-20',
                'right-[4%] top-[64px] rotate-[7deg] z-10',
              ][i === 0 ? 1 : i === 1 ? 0 : 2]
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => go(`/script/${s.id}`)}
                  className={cn(
                    'group absolute w-[176px] transition duration-300 hover:z-30 hover:-translate-y-2 hover:rotate-0 active:scale-[0.98]',
                    pos,
                  )}
                >
                  <div className="overflow-hidden rounded-xl border border-border/80 bg-card/95 p-1.5 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.45)] backdrop-blur">
                    <img src={s.cover} alt={s.title} className="aspect-[3/4] w-full rounded-lg object-cover transition duration-500 group-hover:scale-[1.03]" />
                    <div className="px-1.5 pt-2 pb-1 text-left">
                      <p className="truncate text-sm font-medium">{s.title}</p>
                      <p className="mt-0.5 flex items-center justify-between text-xs text-muted-foreground">
                        <span className="truncate">{s.tags.slice(0, 2).join(' · ')}</span>
                        <span className="shrink-0 font-medium text-foreground">{money(s.price)}</span>
                      </p>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <section ref={libRef} className="scroll-mt-16 pt-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">剧本书架</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {q ? (
                <>
                  「{q}」· 找到 {list.length} 部
                </>
              ) : (
                <>共 {list.length} 部 · 点击封面试读</>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {otherTags.length > 0 && (
              <SelectBox
                value={tagSel}
                onChange={setTagSel}
                options={['全部标签', ...otherTags.map((t) => t.key)]}
                labels={{ 全部标签: '全部标签', ...Object.fromEntries(otherTags.map((t) => [t.key, t.label])) }}
                icon="hash"
              />
            )}
            <SelectBox value={market} onChange={setMarket} options={['全部市场', ...marketTags]} icon="globe" />
            <SelectBox value={sort} onChange={(v) => setSort(v as typeof sort)} options={SORTS.map((s) => s[0])} labels={Object.fromEntries(SORTS)} icon="filter" />
          </div>
        </div>

        <div className="mt-5 space-y-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          <FilterRow label="情节">
            <PlotChip active={plot === '全部'} onClick={() => setPlot('全部')} label="全部" count={onSale.length} />
            {(plotOpen ? plotTags : plotTags.slice(0, 9)).map((t) => (
              <PlotChip key={t} active={plot === t} onClick={() => setPlot(t)} label={t} count={plotCount.get(t) ?? 0} />
            ))}
            {plotTags.length > 9 && (
              <button type="button" onClick={() => setPlotOpen(!plotOpen)} className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium text-primary transition active:scale-95 hover:bg-muted">
                {plotOpen ? '收起' : `更多 ${plotTags.length - 9} 个`}
                <Icon name="chevronDown" size={14} className={cn('transition-transform', plotOpen && 'rotate-180')} />
              </button>
            )}
            {q && (
              <button type="button" onClick={() => setQ('')} className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground transition active:scale-95">
                搜索：{q} <Icon name="x" size={13} />
              </button>
            )}
          </FilterRow>
          <FilterRow label="品质">
            {['全部品质', ...qualityTags].map((t) => {
              const on = quality === t
              const c = t === '全部品质' ? QUALITY_CHIP.all : (QUALITY_CHIP[qualityGrade(t)] ?? QUALITY_CHIP.A)
              return (
                <button key={t} type="button" onClick={() => setQuality(t)} className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition active:scale-95', on ? c.on : c.off)}>
                  {t !== '全部品质' && <Icon name="sparkle" size={13} />}
                  {t}
                </button>
              )
            })}
          </FilterRow>
          <FilterRow label="类型">
            {(['全部', 'wholesale', 'buyout'] as const).map((t) => {
              const on = saleF === t
              const c = SALE_CHIP[t]
              return (
                <button key={t} type="button" onClick={() => setSaleF(t)} className={cn('flex h-8 items-center rounded-lg px-3.5 text-[13px] font-medium transition active:scale-95', on ? c.on : c.off)}>
                  {t === '全部' ? '全部' : SALE_LABEL[t]}
                </button>
              )
            })}
          </FilterRow>
        </div>

        {list.length ? (
          <Bookshelf soldIds={soldIds} key={saleF + plot + market + quality + tagSel + sort + q} list={list} />
        ) : (
          <div className="mt-4">
            <Empty
              icon="search"
              title="书架上没有符合条件的剧本"
              sub="试试切换题材或清除搜索关键词"
              action={
                <button
                  type="button"
                  className="text-sm font-medium text-primary transition active:scale-95"
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

      <section className="mt-12 border-t border-border pt-10 pb-6 sm:mt-16 sm:pt-12">
        <h2 className="text-center text-lg font-semibold tracking-tight sm:text-xl">四步完成采购</h2>
        <p className="mt-1.5 text-center text-xs text-muted-foreground sm:mt-2 sm:text-sm">从挑选到下载，最快 5 分钟</p>
        <ol className="mx-auto mt-6 flex max-w-4xl gap-3 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] snap-x snap-mandatory sm:mt-8 sm:grid sm:grid-cols-4 sm:gap-6 sm:overflow-visible sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {[
            ['浏览剧本库', '按品质、情节与市场筛选'],
            ['免费试读', '每部开放前 2–3 集'],
            ['登录下单', '确认订单后支付宝支付'],
            ['下载剧本', '在「我的订单」随时取件'],
          ].map(([t, d], i) => (
            <li
              key={t}
              className="relative w-[72%] shrink-0 snap-start rounded-2xl border border-border/80 bg-card/60 px-4 py-4 sm:w-auto sm:rounded-none sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:text-left"
            >
              <div className="flex items-baseline gap-2 sm:block">
                <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground">0{i + 1}</p>
                <p className="text-sm font-semibold sm:mt-2">{t}</p>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground sm:mt-1 sm:text-sm">{d}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 px-4 py-3.5">
      <span className="w-9 shrink-0 pt-1.5 text-[13px] font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-2">{children}</div>
    </div>
  )
}

function SelectBox({ value, onChange, options, labels, icon }: { value: string; onChange: (v: string) => void; options: string[]; labels?: Record<string, string>; icon: string }) {
  return (
    <label className="relative flex h-9 items-center gap-2 rounded-xl border border-border bg-card pr-8 pl-3 text-sm text-foreground transition hover:bg-muted/50">
      <Icon name={icon} size={15} className="text-muted-foreground" />
      <select value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
      {labels?.[value] ?? value}
      <Icon name="chevronDown" size={15} className="pointer-events-none absolute right-2.5 text-muted-foreground" />
    </label>
  )
}

function useCols() {
  const calc = () => (window.innerWidth >= 1024 ? 5 : window.innerWidth >= 768 ? 4 : window.innerWidth >= 520 ? 3 : 2)
  const [c, setC] = useState(calc)
  useEffect(() => {
    const f = () => setC(calc())
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])
  return c
}

const RATIOS = ['3 / 4', '3 / 4.25', '3 / 3.9', '3 / 4.15', '3 / 4.05']

function Bookshelf({ list, soldIds }: { list: Script[]; soldIds: Set<string> }) {
  const cols = useCols()
  const rows: Script[][] = []
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols))
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
  return (
    <div className="mt-5 space-y-7">
      {rows.map((row, r) => (
        <div key={r} className="rounded-xl border border-border bg-card/80 px-4 pt-7 pb-4 sm:px-5">
          <div className="stagger grid items-end gap-4 sm:gap-5" style={gridStyle}>
            {row.map((s, i) => (
              <Book key={s.id} s={s} sold={soldIds.has(s.id)} i={r * cols + i} ratio={RATIOS[(r * cols + i) % RATIOS.length]} />
            ))}
          </div>
          <div className="mt-3 h-px bg-border" />
          <div className="mt-3 grid gap-4 sm:gap-5" style={gridStyle}>
            {row.map((s) => (
              <button key={s.id} type="button" onClick={() => go(`/script/${s.id}`)} className="group text-left">
                <p className="line-clamp-1 text-sm font-medium text-foreground transition-colors group-hover:text-primary">{s.title}</p>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {s.tags.slice(0, 2).join(' · ')} · {s.totalEpisodes} 集
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <span className={cn(soldIds.has(s.id) && 'text-muted-foreground line-through')}>{money(s.price)}</span>
                  <span className="rounded border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">{PRICE_LABEL[s.saleType]}</span>
                </p>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Book({ s, i, ratio, sold }: { s: Script; i: number; ratio: string; sold: boolean }) {
  return (
    <button
      type="button"
      onClick={() => go(`/script/${s.id}`)}
      style={idx(i)}
      aria-label={`${s.title}，免费试读`}
      className="group relative block w-full origin-bottom transition duration-300 hover:-translate-y-1.5 active:scale-[0.98]"
    >
      <div className="relative overflow-hidden rounded-lg border border-border shadow-[0_12px_28px_-20px_rgba(0,0,0,0.35)]" style={{ aspectRatio: ratio }}>
        <img src={s.cover} alt={`${s.title} 封面`} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]" />
        {sold && (
          <div className="absolute inset-0 grid place-items-center bg-foreground/50">
            <span className="-rotate-12 rounded-md border border-background px-2.5 py-1 text-sm font-semibold tracking-widest text-background">已买断</span>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-foreground/80 to-transparent px-2.5 pt-8 pb-2">
          <p className="line-clamp-2 text-[13px] leading-tight font-semibold text-background">{s.title}</p>
        </div>
        {s.quality && <QualityBadge q={s.quality.split(' ')[0]} className="absolute top-2 left-2 !px-1.5" />}
        <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md border border-border bg-card/95 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
          <Icon name="star" size={10} className="fill-amber-400 text-amber-400" />
          {s.rating.toFixed(1)}
        </span>
        <span className="absolute inset-x-0 top-1/2 mx-auto flex w-fit -translate-y-1/2 items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground opacity-0 shadow-sm transition group-hover:opacity-100">
          <Icon name="book" size={13} />
          试读 {s.trialCount} 集
        </span>
      </div>
    </button>
  )
}

function PlotChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition active:scale-95',
        active ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span className={cn('grid h-[18px] min-w-[18px] place-items-center rounded-md px-1 text-[11px] font-semibold tabular-nums', active ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground')}>{count}</span>
    </button>
  )
}
