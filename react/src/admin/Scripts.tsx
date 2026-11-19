import { useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Button, Empty, Modal, ModalHeader, QualityBadge, Switch, cn, fmtDate, inputCls } from '../components/ui'
import { SALE_LABEL, isBuyoutSold, money, type Script } from '../lib/data'
import { go, useStore } from '../lib/store'
import { Card, PageHeader, StatusBadge } from './parts'

const TABS = [
  ['all', '全部'],
  ['on', '在售'],
  ['off', '已下架'],
  ['draft', '草稿'],
] as const

export function Scripts() {
  const { state, setStatus, deleteScript, saveScript, toast } = useStore()
  const [qf, setQf] = useState('全部')
  const qualityTags = state.tagGroups.find((g) => g.id === 'quality')?.tags ?? []
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('all')
  const [kw, setKw] = useState('')
  const [del, setDel] = useState<Script | null>(null)

  const list = state.scripts.filter((s) => (tab === 'all' || s.status === tab) && (qf === '全部' || (qf === '未评级' ? !s.quality : s.quality === qf)) && (!kw || (s.title + s.enTitle).toLowerCase().includes(kw.toLowerCase())))
  const count = (t: string) => (t === 'all' ? state.scripts.length : state.scripts.filter((s) => s.status === t).length)

  return (
    <>
      <PageHeader
        title="剧本管理"
        sub="管理所有剧本的上下架、价格与内容。点击价格可直接修改，修改即时同步到前台。"
        actions={
          <Button icon="plus" onClick={() => go('/admin/scripts/new')}>
            上架新剧本
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="flex gap-1 rounded-xl bg-slate-100/80 p-1">
            {TABS.map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={cn('h-8 rounded-lg px-3.5 text-[13px] transition-all duration-200', tab === k ? 'bg-white font-semibold text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800')}>
                {l} <span className="ml-0.5 text-ink-400">{count(k)}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
          <select value={qf} onChange={(e) => setQf(e.target.value)} className={cn(inputCls, 'h-9 w-40 cursor-pointer')} aria-label="按剧本质量筛选">
            {['全部', ...qualityTags, '未评级'].map((o) => (
              <option key={o} value={o}>
                {o === '全部' ? '全部质量' : o}
              </option>
            ))}
          </select>
          <div className="relative w-56">
            <Icon name="search" size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
            <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索剧名" className={cn(inputCls, 'h-9 pl-9')} />
          </div>
          </div>
        </div>
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-400">
                  <th className="py-3 pl-5 font-medium">剧本</th>
                  <th className="py-3 font-medium">情节标签</th>
                  <th className="py-3 font-medium">剧本质量</th>
                  <th className="py-3 font-medium">集数 / 试读</th>
                  <th className="py-3 font-medium">价格</th>
                  <th className="py-3 font-medium">销售方式</th>
                  <th className="py-3 font-medium">销量</th>
                  <th className="py-3 font-medium">状态</th>
                  <th className="py-3 font-medium">上架</th>
                  <th className="py-3 pr-5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody key={tab} className="stagger divide-y divide-line">
                {list.map((s) => {
                  return (
                    <tr key={s.id} className="group transition-colors hover:bg-brand-50/30">
                      <td className="py-3 pl-5">
                        <div className="flex items-center gap-3">
                          <img src={s.cover} alt="" className="h-14 w-11 rounded-lg object-cover ring-1 ring-line" />
                          <div className="min-w-0">
                            <p className="max-w-[220px] truncate font-semibold">{s.title}</p>
                            <p className="max-w-[220px] truncate text-xs text-ink-400">{s.enTitle}</p>
                            <p className="mt-0.5 text-[11px] text-ink-400">创建于 {fmtDate(s.createdAt)}</p>
                            {s.fileName ? (
                              <p className="mt-0.5 max-w-[220px] truncate text-[11px] text-emerald-600">已上传：{s.fileName}</p>
                            ) : (
                              <button onClick={() => go(`/admin/scripts/edit/${s.id}`)} className="mt-0.5 text-[11px] font-medium text-orange-600 hover:underline">
                                未上传 Word 文件 · 去补传
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex max-w-[210px] flex-wrap gap-1">
                          {[...s.tags, ...Object.values(s.extra ?? {}).flat()].slice(0, 4).map((t) => (
                            <span key={t} className="rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
                              {t}
                            </span>
                          ))}
                          {!s.tags.length && <span className="text-ink-400">—</span>}
                        </div>
                      </td>
                      <td className="py-3">
                        <label className="relative inline-flex cursor-pointer items-center" title="点击修改质量等级">
                          {s.quality ? <QualityBadge q={s.quality} /> : <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-ink-400 ring-1 ring-slate-200 ring-inset">未评级</span>}
                          <select
                            value={s.quality}
                            onChange={(e) => {
                              saveScript({ ...s, quality: e.target.value })
                              toast(`《${s.title}》质量已设为「${e.target.value || '未评级'}」`)
                            }}
                            className="absolute inset-0 cursor-pointer opacity-0"
                            aria-label="修改剧本质量"
                          >
                            <option value="">未评级</option>
                            {qualityTags.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                      </td>
                      <td className="py-3 text-ink-600">
                        {s.totalEpisodes} 集 <span className="text-ink-400">/ 前 {s.trialCount} 集</span>
                      </td>
                      <td className="py-3">
                        <PriceCell s={s} />
                      </td>
                      <td className="py-3">
                        <label className="relative inline-flex cursor-pointer items-center gap-1.5" title="点击切换销售方式">
                          <span className={cn('rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', s.saleType === 'buyout' ? 'bg-rose-50 text-rose-600 ring-rose-200' : 'bg-sky-50 text-sky-700 ring-sky-200')}>{SALE_LABEL[s.saleType]}</span>
                          {isBuyoutSold(s) && <span className="text-[11px] text-ink-400">已售出</span>}
                          <select
                            value={s.saleType}
                            onChange={(e) => {
                              saveScript({ ...s, saleType: e.target.value as Script['saleType'] })
                              toast(`《${s.title}》已设为${SALE_LABEL[e.target.value as Script['saleType']]}剧本`)
                            }}
                            className="absolute inset-0 cursor-pointer opacity-0"
                            aria-label="修改销售方式"
                          >
                            <option value="wholesale">批发</option>
                            <option value="buyout">买断</option>
                          </select>
                        </label>
                      </td>
                      <td className="py-3 text-ink-600">{s.sales}</td>
                      <td className="py-3">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="py-3">
                        {s.status === 'draft' ? (
                          <button onClick={() => go(`/admin/scripts/edit/${s.id}`)} className="text-xs font-medium text-brand-700 hover:underline">
                            去完善
                          </button>
                        ) : (
                          <Switch
                            label="上架状态"
                            checked={s.status === 'on'}
                            onChange={(v) => {
                              setStatus(s.id, v ? 'on' : 'off')
                              toast(v ? `《${s.title}》已上架，前台可见` : `《${s.title}》已下架`, v ? 'success' : 'info')
                            }}
                          />
                        )}
                      </td>
                      <td className="py-3 pr-5">
                        <div className="flex justify-end gap-1 opacity-60 transition group-hover:opacity-100">
                          <IconBtn icon="edit" label="编辑" onClick={() => go(`/admin/scripts/edit/${s.id}`)} />
                          <IconBtn icon="eye" label="前台预览" onClick={() => (s.status === 'on' ? go(`/script/${s.id}`) : toast('剧本未上架，前台不可见', 'info'))} />
                          <IconBtn icon="trash" label="删除" danger onClick={() => setDel(s)} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6">
            <Empty icon="book" title="没有符合条件的剧本" action={<Button onClick={() => go('/admin/scripts/new')}>上架新剧本</Button>} />
          </div>
        )}
      </Card>

      <Modal open={!!del} onClose={() => setDel(null)} width="max-w-sm">
        {del && (
          <>
            <ModalHeader title="删除剧本" onClose={() => setDel(null)} />
            <div className="px-6 py-5 text-sm text-ink-600">
              确定删除《{del.title}》吗？删除后前台不可见，已购用户的订单不受影响。如只是暂停销售，建议使用「下架」。
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
              <Button variant="secondary" onClick={() => setDel(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  // 服务端删除剧本时会一并删除已上传的文件，无需再单独调用
                  deleteScript(del.id)
                  toast(`已删除《${del.title}》`, 'info')
                  setDel(null)
                }}
              >
                确认删除
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  )
}

function IconBtn({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={cn('grid h-8 w-8 place-items-center rounded-lg text-ink-500 transition', danger ? 'hover:bg-rose-50 hover:text-rose-600' : 'hover:bg-brand-50 hover:text-brand-700')}>
      <Icon name={icon} size={16} />
    </button>
  )
}

/** 行内改价：点击 → 输入 → 回车保存 / Esc 取消 */
export function PriceCell({ s }: { s: Script }) {
  const { setPrices, toast } = useStore()
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(String(s.price))
  const ref = useRef<HTMLInputElement>(null)
  const save = () => {
    const n = Math.round(Number(val))
    setEditing(false)
    if (!n || n <= 0) return toast('请输入有效价格', 'error')
    if (n === s.price) return
    setPrices([{ id: s.id, price: n }], '剧本列表快速改价')
    toast(`《${s.title}》价格已改为 ${money(n)}，前台已同步`)
  }
  if (editing)
    return (
      <div className="anim-scale-in flex items-center gap-1">
        <div className="relative">
          <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-400">$</span>
          <input
            ref={ref}
            autoFocus
            type="number"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={save}
            className="h-8 w-24 rounded-lg border border-brand-400 pr-2 pl-6 text-sm ring-4 ring-brand-100 outline-none"
          />
        </div>
      </div>
    )
  return (
    <button
      onClick={() => {
        setVal(String(s.price))
        setEditing(true)
      }}
      className="group/p flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 font-semibold transition hover:bg-brand-50 hover:text-brand-700"
      title="点击修改价格"
    >
      {money(s.price)}
      <Icon name="edit" size={13} className="text-ink-300 opacity-0 transition group-hover/p:opacity-100" />
    </button>
  )
}
