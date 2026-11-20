import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Button, Modal, ModalHeader, cn, fmtDate, inputCls } from '../components/ui'
import { GRADE_SUGGEST_PRICE, PRICE_LABEL, SALE_LABEL, money, qualityGrade, suggestPrice, type SaleType, type Script } from '../lib/data'
import { useStore } from '../lib/store'
import { Card, PageHeader, StatusBadge } from './parts'

/** 支持特价一位小数；百分比调价后取整到 0.1 */
const round = (n: number) => Math.max(1, Math.round(n * 10) / 10)

export function Pricing() {
  const { state, setPrices, saveScript, toast } = useStore()
  const [pending, setPending] = useState<Record<string, number>>({})
  const [sel, setSel] = useState<string[]>([])
  const [mode, setMode] = useState<'down' | 'up' | 'set'>('down')
  const [amount, setAmount] = useState('10')
  const [note, setNote] = useState('')
  const [history, setHistory] = useState<Script | null>(null)
  const [saving, setSaving] = useState(false)

  const list = state.scripts.filter((s) => s.status !== 'draft')
  const changed = Object.entries(pending).filter(([id, p]) => state.scripts.find((s) => s.id === id)?.price !== p)
  const priceOf = (s: Script) => pending[s.id] ?? s.price
  const setOne = (id: string, p: number) => setPending((x) => ({ ...x, [id]: p }))
  const allSel = sel.length === list.length && list.length > 0

  const applyBulk = () => {
    const v = Number(amount)
    if (!v || v <= 0) return toast('请输入有效数值', 'error')
    const next = { ...pending }
    for (const id of sel) {
      const s = state.scripts.find((x) => x.id === id)!
      const cur = priceOf(s)
      next[id] = mode === 'set' ? Math.round(v) : round(cur * (mode === 'down' ? 1 - v / 100 : 1 + v / 100))
    }
    setPending(next)
    toast(`已为 ${sel.length} 部剧本预设新价格，确认后保存生效`, 'info')
  }

  const save = async () => {
    if (!changed.length || saving) return
    setSaving(true)
    try {
      await setPrices(
        changed.map(([id, price]) => ({ id, price })),
        note.trim() || '定价中心调价',
      )
      toast(`${changed.length} 部剧本价格已更新，前台即时生效`)
      setPending({})
      setSel([])
      setNote('')
    } catch {
      /* setPrices 内部已 toast */
    } finally {
      setSaving(false)
    }
  }

  const applyGradeSuggest = () => {
    const targets = sel.length ? sel : list.map((s) => s.id)
    if (!targets.length) return toast('没有可调价的剧本', 'error')
    const next = { ...pending }
    let n = 0
    for (const id of targets) {
      const s = state.scripts.find((x) => x.id === id)
      if (!s?.quality) continue
      next[id] = suggestPrice(s.quality)
      n++
    }
    setPending(next)
    toast(`已按评级填入 ${n} 部建议价（S ${GRADE_SUGGEST_PRICE.S} / A ${GRADE_SUGGEST_PRICE.A} / B ${GRADE_SUGGEST_PRICE.B} / C ${GRADE_SUGGEST_PRICE.C} / D ${GRADE_SUGGEST_PRICE.D}），确认后保存`, 'info')
  }

  return (
    <div className="pb-24">
      <PageHeader title="定价中心" sub="集中管理所有剧本价格：单个修改、批量涨降价，确认后统一生效，并自动记录调价历史。" />

      <div className="stagger mb-5 grid gap-4 md:grid-cols-3">
        {[
          ['平均标准价', money(list.reduce((a, s) => a + s.price, 0) / Math.max(1, list.length)), 'tag'],
          ['在售剧本', `${list.filter((s) => s.status === 'on').length} / ${list.length}`, 'book'],
          ['近 30 天调价次数', String(list.reduce((a, s) => a + s.priceHistory.filter((h) => Date.now() - +new Date(h.at) < 30 * 864e5).length, 0)), 'history'],
        ].map(([l, v, i], k) => (
          <div key={l} style={{ ['--i' as string]: k }} className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-muted text-foreground">
              <Icon name={i} size={18} />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">{l}</p>
              <p className="mt-0.5 text-lg font-semibold tracking-tight">{v}</p>
            </div>
          </div>
        ))}
      </div>

      <Card>
        <div className={cn('flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 transition-colors', sel.length > 0 && 'bg-muted/50')}>
          {sel.length ? (
            <>
              <span className="anim-fade-in text-sm font-medium text-foreground">已选 {sel.length} 部</span>
              <div className="flex h-9 gap-1 rounded-xl border border-border bg-card p-1">
                {(
                  [
                    ['down', '降价 %'],
                    ['up', '涨价 %'],
                    ['set', '统一定价 $'],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} onClick={() => setMode(k)} className={cn('rounded-lg px-3 text-[13px] transition active:scale-95', mode === k ? 'bg-primary font-medium text-primary-foreground' : 'text-muted-foreground')}>
                    {l}
                  </button>
                ))}
              </div>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className={cn(inputCls, 'h-9 w-28')} />
              <Button size="sm" className="h-9" onClick={applyBulk}>
                应用到所选
              </Button>
              <button onClick={() => setSel([])} className="ml-auto text-[13px] text-muted-foreground hover:text-foreground">
                取消选择
              </button>
            </>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-3">
              <p className="text-[13px] text-muted-foreground">
                <Icon name="info" size={14} className="mr-1 inline -translate-y-px" />
                勾选后可批量调价；也可单独改价格。建议价：D 19.9 · C 99 · B 199 · A 599 · S 1099（可改）。
              </p>
              <Button size="sm" variant="secondary" className="ml-auto h-9" onClick={applyGradeSuggest}>
                按评级填建议价
              </Button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="w-12 py-3 pl-5">
                  <Check checked={allSel} onChange={() => setSel(allSel ? [] : list.map((s) => s.id))} />
                </th>
                <th className="py-3 font-medium">剧本</th>
                <th className="py-3 font-medium">评级</th>
                <th className="py-3 font-medium">状态</th>
                <th className="py-3 font-medium">当前价</th>
                <th className="py-3 font-medium">新价格</th>
                <th className="py-3 font-medium">快捷调整</th>
                <th className="py-3 font-medium">销售方式</th>
                <th className="py-3 pr-5 font-medium">最近调价</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((s) => {
                const np = priceOf(s)
                const diff = np - s.price
                const last = s.priceHistory[s.priceHistory.length - 1]
                return (
                  <tr key={s.id} className={cn('transition-colors duration-300', diff !== 0 ? 'bg-amber-50/50' : sel.includes(s.id) ? 'bg-muted/40' : 'hover:bg-slate-50/60')}>
                    <td className="py-3 pl-5">
                      <Check checked={sel.includes(s.id)} onChange={() => setSel((x) => (x.includes(s.id) ? x.filter((i) => i !== s.id) : [...x, s.id]))} />
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-3">
                        <img src={s.cover} alt="" className="h-11 w-9 rounded-md object-cover" />
                        <div className="min-w-0">
                          <p className="max-w-[180px] truncate font-medium">{s.title}</p>
                          <p className="text-xs text-muted-foreground">{s.tags.slice(0, 2).join(' · ')}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3">
                      <span className="text-xs font-medium text-muted-foreground">{s.quality ? qualityGrade(s.quality) : '—'}</span>
                      {s.quality && (
                        <button
                          type="button"
                          title="填入该评级建议价"
                          onClick={() => setOne(s.id, suggestPrice(s.quality))}
                          className="ml-1 text-[11px] text-primary hover:underline"
                        >
                          {money(suggestPrice(s.quality))}
                        </button>
                      )}
                    </td>
                    <td className="py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {money(s.price)}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{PRICE_LABEL[s.saleType]}</span>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">¥</span>
                          <input
                            type="number"
                            step="0.1"
                            value={np}
                            onChange={(e) => setOne(s.id, round(Number(e.target.value)))}
                            className={cn('h-9 w-28 rounded-lg border pr-2 pl-6 font-semibold outline-none transition focus:ring-3 focus:ring-ring/40', diff ? 'border-amber-300 bg-white' : 'border-border focus:border-primary')}
                          />
                        </div>
                        {diff !== 0 && (
                          <span className={cn('anim-scale-in rounded-md px-1.5 py-0.5 text-[11px] font-semibold', diff > 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600')}>
                            {diff > 0 ? '+' : ''}
                            {Math.round((diff / s.price) * 100)}%
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3">
                      <div className="flex gap-1">
                        {[-10, -5, 5, 10].map((p) => (
                          <button key={p} onClick={() => setOne(s.id, round(np * (1 + p / 100)))} className="h-7 rounded-md bg-slate-100 px-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-primary active:scale-95">
                            {p > 0 ? '+' : ''}
                            {p}%
                          </button>
                        ))}
                        {diff !== 0 && (
                          <button onClick={() => setOne(s.id, s.price)} title="还原" className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-slate-100">
                            <Icon name="refresh" size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-3">
                      <div className="flex h-8 w-fit gap-0.5 rounded-lg bg-slate-100/80 p-0.5">
                        {(['wholesale', 'buyout'] as SaleType[]).map((t) => (
                          <button
                            key={t}
                            onClick={() => {
                              if (s.saleType === t) return
                              saveScript({ ...s, saleType: t })
                              toast(`《${s.title}》已设为${SALE_LABEL[t]}剧本`)
                            }}
                            className={cn('rounded-md px-2.5 text-xs transition-all', s.saleType === t ? (t === 'buyout' ? 'bg-rose-500 font-semibold text-white shadow-sm' : 'bg-white font-semibold text-sky-700 shadow-sm') : 'text-muted-foreground hover:text-foreground')}
                          >
                            {SALE_LABEL[t]}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 pr-5">
                      <button onClick={() => setHistory(s)} className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary">
                        {last ? fmtDate(last.at) : '—'}
                        <Icon name="history" size={13} className="text-muted-foreground group-hover:text-primary" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 待保存提示条 */}
      <div className={cn('fixed right-0 bottom-0 left-0 z-40 transition-all duration-500 ease-[var(--ease-smooth)] lg:left-[232px]', changed.length ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0')}>
        <div className="mx-4 mb-4 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.25)] lg:mx-6">
          <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4 sm:py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700">
                <Icon name="tag" size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {changed.length} 部价格待保存
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {changed
                    .slice(0, 3)
                    .map(([id, price]) => {
                      const s = state.scripts.find((x) => x.id === id)
                      return `${s?.title || id} → ${money(price)}`
                    })
                    .join(' · ')}
                  {changed.length > 3 ? ` 等` : ''}
                </p>
              </div>
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="调价原因（选填）"
              className={cn(inputCls, 'h-9 min-w-0 flex-1 sm:max-w-xs')}
            />
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" className="h-9" disabled={saving} onClick={() => setPending({})}>
                撤销
              </Button>
              <Button loading={saving} onClick={() => void save()} className="h-9 min-w-[7.5rem]">
                {saving ? '保存中…' : '保存并生效'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal open={!!history} onClose={() => setHistory(null)} side>
        {history && <HistoryPanel s={state.scripts.find((x) => x.id === history.id) ?? history} onClose={() => setHistory(null)} />}
      </Modal>
    </div>
  )
}

function HistoryPanel({ s, onClose }: { s: Script; onClose: () => void }) {
  const h = [...s.priceHistory]
  const prices = h.map((x) => x.price)
  const min = Math.min(...prices) * 0.95
  const max = Math.max(...prices) * 1.05
  const pts = h.map((x, i) => `${h.length === 1 ? 50 : (i / (h.length - 1)) * 100},${40 - ((x.price - min) / (max - min || 1)) * 36}`).join(' ')
  return (
    <>
      <ModalHeader title="调价历史" sub={s.title} onClose={onClose} />
      <div className="p-6">
        <div className="rounded-2xl bg-background p-4">
          <p className="text-xs text-muted-foreground">当前标准价</p>
          <p className="text-2xl font-bold text-primary">{money(s.price)}</p>
          <svg viewBox="0 0 100 44" className="mt-3 h-20 w-full overflow-visible" preserveAspectRatio="none">
            <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        </div>
        <ol className="relative mt-6 space-y-5 border-l border-border pl-6">
          {h.reverse().map((x, i) => (
            <li key={i} className="relative">
              <span className={cn('absolute top-1 -left-[29px] h-3 w-3 rounded-full ring-4 ring-white', i === 0 ? 'bg-primary' : 'bg-muted-foreground')} />
              <p className="text-sm font-semibold">{money(x.price)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{x.note}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{fmtDate(x.at, true)}</p>
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}

function Check({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} role="checkbox" aria-checked={checked} className={cn('grid h-[18px] w-[18px] place-items-center rounded-[5px] border transition-all duration-200', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary')}>
      {checked && <Icon name="check" size={12} stroke={3.5} className="anim-pop" />}
    </button>
  )
}
