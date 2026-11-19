import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, QualityBadge, cn, idx } from '../components/ui'
import { PRICE_LABEL, SALE_LABEL, getVals, isBuyoutSold, money, qualityGrade, type SaleType, type Script } from '../lib/data'
import { go, useStore } from '../lib/store'

// 品质按钮：每个等级一种颜色，与蓝色的情节标签区分开
const QUALITY_CHIP: Record<string, { on: string; off: string }> = {
  all: { on: 'bg-ink-900 text-white ring-ink-900', off: 'bg-white text-ink-600 ring-line hover:ring-ink-300' },
  S: { on: 'bg-amber-500 text-white ring-amber-500 shadow-[0_6px_14px_-6px_rgba(245,158,11,.9)]', off: 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100' },
  A: { on: 'bg-violet-600 text-white ring-violet-600 shadow-[0_6px_14px_-6px_rgba(124,58,237,.8)]', off: 'bg-violet-50 text-violet-700 ring-violet-200 hover:bg-violet-100' },
  B: { on: 'bg-emerald-600 text-white ring-emerald-600 shadow-[0_6px_14px_-6px_rgba(5,150,105,.8)]', off: 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100' },
  C: { on: 'bg-slate-600 text-white ring-slate-600', off: 'bg-slate-100 text-ink-600 ring-slate-200 hover:bg-slate-200' },
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
  // 书架上的情节标签：只展示在售剧本实际用到的，按使用数量排序
  const plotCount = new Map<string, number>()
  onSale.forEach((s) => s.tags.forEach((t) => plotCount.set(t, (plotCount.get(t) ?? 0) + 1)))
  const plotTags = groupTags('plot')
    .filter((t) => plotCount.has(t))
    .sort((a, b) => (plotCount.get(b) ?? 0) - (plotCount.get(a) ?? 0))
  const marketTags = groupTags('market')
  const qualityTags = groupTags('quality')
  // 其余分类（情节标签与后台自建分类）合并成一个标签筛选
  const otherTags = state.tagGroups.filter((g) => !['plot', 'quality', 'market'].includes(g.id)).flatMap((g) => g.tags.map((t) => ({ key: `${g.id}::${t}`, label: `${g.name} · ${t}` })))
  const featured = [...onSale].sort((a, b) => b.sales - a.sales).slice(0, 3)

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const r = onSale.filter(
      (s) =>
        (plot === '全部' || s.tags.includes(plot)) &&
        (market === '全部市场' || s.markets.includes(market)) &&
        (quality === '全部品质' || s.quality === quality) &&
        (saleF === '全部' || s.saleType === saleF) &&
        (tagSel === '全部标签' || getVals(s, tagSel.split('::')[0]).includes(tagSel.split('::')[1])) &&
        (!kw || [s.title, s.enTitle, s.logline, ...s.tags].join(' ').toLowerCase().includes(kw)),
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
      {/* Hero */}
      <section className="relative -mt-16 overflow-hidden pt-16">
        <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" />
        <div className="absolute -top-40 left-1/2 h-[560px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,#d6e9ff,transparent)]" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 pt-14 pb-20 lg:grid-cols-[1.1fr_1fr] lg:px-8 lg:pt-20">
          <div className="stagger">
            <span style={idx(0)} className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/80 py-1 pr-3 pl-1 text-xs font-medium text-brand-700 shadow-sm backdrop-blur">
              <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] text-white">NEW</span>
              本月新上架 {onSale.filter((s) => Date.now() - +new Date(s.createdAt) < 30 * 864e5).length} 部原创剧本
            </span>
            <h1 style={idx(1)} className="mt-6 text-[40px] leading-[1.15] font-bold tracking-tight text-ink-900 md:text-[54px]">
              为出海短剧，
              <br />
              提供<span className="shimmer-text">可直接开拍</span>的剧本
            </h1>
            <p style={idx(2)} className="mt-5 max-w-lg text-[16px] leading-relaxed text-ink-500">
              海漫原创编剧团队出品，按品质分级、按情节标签挑选，覆盖契约婚姻、重生复仇、追妻火葬场等海外爆款桥段。免费试读前几集，看准再买。
            </p>
            <form
              style={idx(3)}
              onSubmit={(e) => {
                e.preventDefault()
                scrollLib()
              }}
              className="mt-8 flex max-w-lg items-center gap-2 rounded-2xl border border-line bg-white p-1.5 shadow-[0_16px_40px_-20px_rgba(26,107,240,.35)] transition-shadow focus-within:shadow-[0_16px_40px_-16px_rgba(26,107,240,.5)]"
            >
              <Icon name="search" className="ml-3 text-ink-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索剧名、题材或关键词，如「契约婚姻」"
                className="h-11 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-400"
              />
              <button className="h-11 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition hover:bg-brand-700 active:scale-95">找剧本</button>
            </form>
            <div style={idx(4)} className="mt-10 flex gap-10">
              {[
                [onSale.length + '+', '在售原创剧本'],
                ['6', '覆盖海外市场'],
                ['3 集', '平均免费试读'],
              ].map(([n, l]) => (
                <div key={l}>
                  <p className="text-2xl font-bold tracking-tight text-ink-900">{n}</p>
                  <p className="mt-1 text-xs text-ink-500">{l}</p>
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
                  <div className="anim-float overflow-hidden rounded-2xl bg-white p-2 shadow-[0_30px_60px_-25px_rgba(15,27,45,.45)] ring-1 ring-line" style={{ animationDelay: `${i * -2}s` }}>
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
                <p className="text-sm font-semibold">{onSale.length} 部 · 持续更新</p>
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
            <p className="mt-1 text-sm text-ink-500">共 {list.length} 部剧本 · 点击任意一本抽出试读</p>
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
              <PlotChip active={plot === '全部'} onClick={() => setPlot('全部')} label="全部" count={onSale.length} />
              {(plotOpen ? plotTags : plotTags.slice(0, 9)).map((t) => (
                <PlotChip key={t} active={plot === t} onClick={() => setPlot(t)} label={t} count={plotCount.get(t) ?? 0} />
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

// 每本书的高度略有差异，更像真实书架
const RATIOS = ['3 / 4', '3 / 4.25', '3 / 3.9', '3 / 4.15', '3 / 4.05']

function Bookshelf({ list, soldIds }: { list: Script[]; soldIds: Set<string> }) {
  const cols = useCols()
  const rows: Script[][] = []
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols))
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
  return (
    <div className="mt-4 space-y-10">
      {rows.map((row, r) => (
        <div key={r} className="relative rounded-3xl bg-gradient-to-b from-brand-100/70 via-brand-50 to-white px-4 pt-10 pb-4 shadow-[inset_0_8px_24px_-12px_rgba(26,107,240,.25)] ring-1 ring-brand-100 sm:px-8">
          {/* 书脊靠板 */}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-3 rounded-l-3xl bg-gradient-to-r from-brand-200/60 to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-3 rounded-r-3xl bg-gradient-to-l from-brand-200/60 to-transparent" />
          <div className="stagger grid items-end gap-4 sm:gap-7" style={gridStyle}>
            {row.map((s, i) => (
              <Book key={s.id} s={s} sold={soldIds.has(s.id)} i={r * cols + i} ratio={RATIOS[(r * cols + i) % RATIOS.length]} />
            ))}
          </div>
          {/* 搁板 */}
          <div className="relative -mx-4 sm:-mx-8">
            <div className="h-4 rounded-sm bg-gradient-to-b from-white via-brand-200 to-brand-300 shadow-[0_10px_20px_-6px_rgba(26,107,240,.35)]" />
            <div className="mx-3 h-2 rounded-b-xl bg-brand-300/60 blur-[2px]" />
          </div>
          <div className="mt-3 grid gap-4 sm:gap-7" style={gridStyle}>
            {row.map((s) => (
              <button key={s.id} onClick={() => go(`/script/${s.id}`)} className="group text-left">
                <p className="line-clamp-1 text-sm font-semibold text-ink-900 transition-colors group-hover:text-brand-700">{s.title}</p>
                <p className="mt-0.5 line-clamp-1 text-xs text-ink-500">
                  {s.tags.slice(0, 2).join(' · ')} · {s.totalEpisodes} 集
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-bold text-brand-700">
                  <span className={cn(soldIds.has(s.id) && 'text-ink-300 line-through')}>{money(s.price)}</span>
                  <span className={cn('rounded px-1.5 py-px text-[10px] font-semibold', s.saleType === 'buyout' ? 'bg-rose-50 text-rose-600' : 'bg-sky-50 text-sky-700')}>{PRICE_LABEL[s.saleType]}</span>
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
      onClick={() => go(`/script/${s.id}`)}
      style={idx(i)}
      aria-label={`${s.title}，免费试读`}
      className="group relative block w-full origin-bottom transition-transform duration-500 ease-[var(--ease-smooth)] [perspective:900px] hover:z-10 hover:-translate-y-4 hover:-rotate-[2.5deg]"
    >
      <div className="relative overflow-hidden rounded-r-md rounded-l-[3px] shadow-[6px_10px_18px_-8px_rgba(15,27,45,.55)] transition-shadow duration-500 group-hover:shadow-[14px_26px_34px_-14px_rgba(26,107,240,.6)]" style={{ aspectRatio: ratio }}>
        <img src={s.cover} alt={`${s.title} 封面`} loading="lazy" className="h-full w-full object-cover" />
        {/* 书脊 */}
        <div className="absolute inset-y-0 left-0 w-[9%] bg-gradient-to-r from-black/45 via-white/20 to-black/10" />
        <div className="absolute inset-y-0 left-[9%] w-px bg-white/30" />
        {sold && (
          <div className="absolute inset-0 grid place-items-center bg-ink-900/55 backdrop-blur-[1px]">
            <span className="-rotate-12 rounded-md border-2 border-white/90 px-2.5 py-1 text-sm font-bold tracking-widest text-white">已买断</span>
          </div>
        )}
        {/* 封面光泽 */}
        <div className="absolute inset-0 bg-gradient-to-br from-white/25 via-transparent to-black/25" />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-900/85 to-transparent px-3 pt-8 pb-2.5 pl-[14%]">
          <p className="line-clamp-2 text-[13px] leading-tight font-bold text-white drop-shadow">{s.title}</p>
        </div>
        {s.quality && <QualityBadge q={s.quality.split(' ')[0]} className="absolute top-2 left-[11%] !px-1.5 shadow-sm" />}
        <span className="absolute top-2 right-2 flex items-center gap-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-ink-800 backdrop-blur">
          <Icon name="star" size={10} className="fill-amber-400 text-amber-400" />
          {s.rating.toFixed(1)}
        </span>
        <span className="absolute inset-x-0 top-1/2 mx-auto flex w-fit -translate-y-1/2 translate-y-2 items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 opacity-0 shadow-lg transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <Icon name="book" size={13} />
          试读 {s.trialCount} 集
        </span>
      </div>
      {/* 书页边缘 */}
      <div className="absolute top-[2px] -right-[3px] bottom-[2px] w-[4px] rounded-r-sm bg-[repeating-linear-gradient(to_bottom,#fff,#fff_2px,#dbe7f5_2px,#dbe7f5_3px)] shadow-sm" />
    </button>
  )
}

function PlotChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex h-8 items-center gap-1.5 rounded-full pr-2.5 pl-3.5 text-[13px] font-medium transition-all duration-200 active:scale-95',
        active ? 'bg-brand-600 text-white shadow-[0_6px_14px_-6px_rgba(26,107,240,.8)]' : 'bg-brand-50/70 text-ink-700 hover:bg-brand-100 hover:text-brand-800',
      )}
    >
      {label}
      <span className={cn('grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold tabular-nums transition-colors', active ? 'bg-white/25 text-white' : 'bg-white text-ink-400 group-hover:text-brand-700')}>{count}</span>
    </button>
  )
}
