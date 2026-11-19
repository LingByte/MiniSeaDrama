import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Button, Modal, ModalHeader, cn, fmtDate, inputCls } from '../components/ui'
import { PRICE_LABEL, SALE_LABEL, money, type SaleType, type Script } from '../lib/data'
import { useStore } from '../lib/store'
import { Card, PageHeader, StatusBadge } from './parts'

const round = (n: number) => Math.max(100, Math.round(n / 10) * 10)

export function Pricing() {
  const { state, setPrices, saveScript, toast } = useStore()
  const [pending, setPending] = useState<Record<string, number>>({})
  const [sel, setSel] = useState<string[]>([])
  const [mode, setMode] = useState<'down' | 'up' | 'set'>('down')
  const [amount, setAmount] = useState('10')
  const [note, setNote] = useState('')
  const [history, setHistory] = useState<Script | null>(null)

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

  const save = () => {
    setPrices(
      changed.map(([id, price]) => ({ id, price })),
      note.trim() || '定价中心调价',
    )
    toast(`${changed.length} 部剧本价格已更新，前台即时生效`)
    setPending({})
    setSel([])
    setNote('')
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
          <div key={l} style={{ ['--i' as string]: k }} className="flex items-center gap-4 rounded-2xl border border-line bg-white p-5">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <Icon name={i} size={20} />
            </span>
            <div>
              <p className="text-xs text-ink-500">{l}</p>
              <p className="mt-0.5 text-xl font-bold tracking-tight">{v}</p>
            </div>
          </div>
        ))}
      </div>

      <Card>
        <div className={cn('flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 transition-colors duration-300', sel.length > 0 && 'bg-brand-50/60')}>
          {sel.length ? (
            <>
              <span className="anim-fade-in text-sm font-medium text-brand-800">已选 {sel.length} 部</span>
              <div className="flex h-9 gap-1 rounded-xl bg-white p-1 ring-1 ring-line">
                {(
                  [
                    ['down', '降价 %'],
                    ['up', '涨价 %'],
                    ['set', '统一定价 $'],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} onClick={() => setMode(k)} className={cn('rounded-lg px-3 text-[13px] transition', mode === k ? 'bg-brand-600 font-medium text-white' : 'text-ink-600')}>
                    {l}
                  </button>
                ))}
              </div>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className={cn(inputCls, 'h-9 w-28')} />
              <Button size="sm" className="h-9" onClick={applyBulk}>
                应用到所选
              </Button>
              <button onClick={() => setSel([])} className="ml-auto text-[13px] text-ink-500 hover:text-ink-800">
                取消选择
              </button>
            </>
          ) : (
            <p className="text-[13px] text-ink-500">
              <Icon name="info" size={14} className="mr-1 inline -translate-y-px" />
              勾选剧本可批量调价；直接修改价格框即可单独调价。所有修改需点击底部「保存并生效」。
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-400">
                <th className="w-12 py-3 pl-5">
                  <Check checked={allSel} onChange={() => setSel(allSel ? [] : list.map((s) => s.id))} />
                </th>
                <th className="py-3 font-medium">剧本</th>
                <th className="py-3 font-medium">状态</th>
                <th className="py-3 font-medium">当前价</th>
                <th className="py-3 font-medium">新价格</th>
                <th className="py-3 font-medium">快捷调整</th>
                <th className="py-3 font-medium">销售方式</th>
                <th className="py-3 pr-5 font-medium">最近调价</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((s) => {
                const np = priceOf(s)
                const diff = np - s.price
                const last = s.priceHistory[s.priceHistory.length - 1]
                return (
                  <tr key={s.id} className={cn('transition-colors duration-300', diff !== 0 ? 'bg-amber-50/50' : sel.includes(s.id) ? 'bg-brand-50/40' : 'hover:bg-slate-50/60')}>
                    <td className="py-3 pl-5">
                      <Check checked={sel.includes(s.id)} onChange={() => setSel((x) => (x.includes(s.id) ? x.filter((i) => i !== s.id) : [...x, s.id]))} />
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-3">
                        <img src={s.cover} alt="" className="h-11 w-9 rounded-md object-cover" />
                        <div className="min-w-0">
                          <p className="max-w-[180px] truncate font-medium">{s.title}</p>
                          <p className="text-xs text-ink-400">{s.tags.slice(0, 2).join(' · ')}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="py-3 text-ink-500">
                      {money(s.price)}
                      <span className="ml-1.5 text-[11px] text-ink-400">{PRICE_LABEL[s.saleType]}</span>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-400">$</span>
                          <input
                            type="number"
                            value={np}
                            onChange={(e) => setOne(s.id, Math.round(Number(e.target.value)))}
                            className={cn('h-9 w-28 rounded-lg border pr-2 pl-6 font-semibold outline-none transition focus:ring-4 focus:ring-brand-100', diff ? 'border-amber-300 bg-white' : 'border-line focus:border-brand-400')}
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
                          <button key={p} onClick={() => setOne(s.id, round(np * (1 + p / 100)))} className="h-7 rounded-md bg-slate-100 px-2 text-xs text-ink-600 transition hover:bg-brand-100 hover:text-brand-700 active:scale-95">
                            {p > 0 ? '+' : ''}
                            {p}%
                          </button>
                        ))}
                        {diff !== 0 && (
                          <button onClick={() => setOne(s.id, s.price)} title="还原" className="grid h-7 w-7 place-items-center rounded-md text-ink-400 hover:bg-slate-100">
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
                            className={cn('rounded-md px-2.5 text-xs transition-all', s.saleType === t ? (t === 'buyout' ? 'bg-rose-500 font-semibold text-white shadow-sm' : 'bg-white font-semibold text-sky-700 shadow-sm') : 'text-ink-500 hover:text-ink-800')}
                          >
                            {SALE_LABEL[t]}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 pr-5">
                      <button onClick={() => setHistory(s)} className="group flex items-center gap-1.5 text-xs text-ink-500 hover:text-brand-700">
                        {last ? fmtDate(last.at) : '—'}
                        <Icon name="history" size={13} className="text-ink-300 group-hover:text-brand-600" />
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
        <div className="mx-5 mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-ink-900 px-5 py-3.5 text-white shadow-2xl lg:mx-8">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-400/20 text-amber-300">
            <Icon name="tag" size={16} />
          </span>
          <span className="text-sm">
            <b>{changed.length}</b> 部剧本价格待保存
          </span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="调价原因（选填），如：周年庆前调价" className="h-9 min-w-[200px] flex-1 rounded-lg bg-white/10 px-3 text-sm placeholder:text-white/40 outline-none focus:bg-white/15" />
          <button onClick={() => setPending({})} className="h-9 rounded-lg px-3 text-sm text-white/70 hover:text-white">
            撤销全部
          </button>
          <Button onClick={save} className="h-9 !shadow-none">
            保存并生效
          </Button>
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
        <div className="rounded-2xl bg-canvas p-4">
          <p className="text-xs text-ink-500">当前标准价</p>
          <p className="text-2xl font-bold text-brand-700">{money(s.price)}</p>
          <svg viewBox="0 0 100 44" className="mt-3 h-20 w-full overflow-visible" preserveAspectRatio="none">
            <polyline points={pts} fill="none" stroke="var(--color-brand-500)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        </div>
        <ol className="relative mt-6 space-y-5 border-l border-line pl-6">
          {h.reverse().map((x, i) => (
            <li key={i} className="relative">
              <span className={cn('absolute top-1 -left-[29px] h-3 w-3 rounded-full ring-4 ring-white', i === 0 ? 'bg-brand-600' : 'bg-ink-300')} />
              <p className="text-sm font-semibold">{money(x.price)}</p>
              <p className="mt-0.5 text-xs text-ink-500">{x.note}</p>
              <p className="mt-0.5 text-[11px] text-ink-400">{fmtDate(x.at, true)}</p>
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}

function Check({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} role="checkbox" aria-checked={checked} className={cn('grid h-[18px] w-[18px] place-items-center rounded-[5px] border transition-all duration-200', checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300 bg-white hover:border-brand-400')}>
      {checked && <Icon name="check" size={12} stroke={3.5} className="anim-pop" />}
    </button>
  )
}
