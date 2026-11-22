import { useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Button, Empty, Modal, ModalHeader, QualityBadge, Switch, cn, fmtDate, inputCls } from '../components/ui'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
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
          <Button icon="plus" onClick={() => go('/manage/scripts/new')}>
            上架新剧本
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {TABS.map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={cn('h-8 rounded-lg px-3 text-[13px] transition', tab === k ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {l} <span className="ml-0.5 text-muted-foreground">{count(k)}</span>
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
            <Icon name="search" size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索剧名" className={cn(inputCls, 'h-9 pl-9')} />
          </div>
          </div>
        </div>
        {list.length ? (
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">剧本</TableHead>
                <TableHead>情节标签</TableHead>
                <TableHead>剧本质量</TableHead>
                <TableHead>集数 / 试读</TableHead>
                <TableHead>价格</TableHead>
                <TableHead>销售方式</TableHead>
                <TableHead>销量</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>上架</TableHead>
                <TableHead className="pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody key={tab}>
              {list.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4 whitespace-normal">
                    <div className="flex items-center gap-3">
                      <img src={s.cover} alt="" className="h-12 w-9 rounded-lg border border-border object-cover" />
                      <div className="min-w-0">
                        <p className="max-w-[220px] truncate text-sm font-medium">{s.title}</p>
                        <p className="max-w-[220px] truncate text-xs text-muted-foreground">{s.enTitle}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">创建于 {fmtDate(s.createdAt)}</p>
                        {s.fileName ? (
                          <p className="mt-0.5 max-w-[220px] truncate text-[11px] text-emerald-700">已上传：{s.fileName}</p>
                        ) : (
                          <button onClick={() => go(`/manage/scripts/edit/${s.id}`)} className="mt-0.5 text-[11px] font-medium text-orange-700 hover:underline">
                            未上传 Word 文件 · 去补传
                          </button>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex max-w-[210px] flex-wrap gap-1">
                      {[...s.tags, ...Object.values(s.extra ?? {}).flat()].slice(0, 4).map((t) => (
                        <span key={t} className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground">
                          {t}
                        </span>
                      ))}
                      {!s.tags.length && <span className="text-muted-foreground">—</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <label className="relative inline-flex cursor-pointer items-center" title="点击修改质量等级">
                      {s.quality ? <QualityBadge q={s.quality} /> : <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">未评级</span>}
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
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.totalEpisodes} 集 <span className="text-muted-foreground/70">/ 前 {s.trialCount} 集</span>
                  </TableCell>
                  <TableCell>
                    <PriceCell s={s} />
                  </TableCell>
                  <TableCell>
                    <label className="relative inline-flex cursor-pointer items-center gap-1.5" title="点击切换销售方式">
                      <span className={cn('rounded-md border border-border px-2 py-0.5 text-xs font-medium', s.saleType === 'buyout' ? 'bg-rose-50 text-rose-700' : 'bg-muted text-foreground')}>{SALE_LABEL[s.saleType]}</span>
                      {isBuyoutSold(s) && <span className="text-[11px] text-muted-foreground">已售出</span>}
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
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.sales}</TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} />
                  </TableCell>
                  <TableCell>
                    {s.status === 'draft' ? (
                      <button onClick={() => go(`/manage/scripts/edit/${s.id}`)} className="text-xs font-medium text-primary hover:underline">
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
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1 opacity-70 transition group-hover:opacity-100">
                      <IconBtn icon="edit" label="编辑" onClick={() => go(`/manage/scripts/edit/${s.id}`)} />
                      <IconBtn
                        icon="eye"
                        label={s.status === 'on' ? '前台预览' : '管理员预览'}
                        onClick={() => go(s.status === 'on' ? `/script/${s.id}` : `/manage/scripts/preview/${s.id}`)}
                      />
                      <IconBtn icon="trash" label="删除" danger onClick={() => setDel(s)} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-6">
            <Empty icon="book" title="没有符合条件的剧本" action={<Button onClick={() => go('/manage/scripts/new')}>上架新剧本</Button>} />
          </div>
        )}
      </Card>

      <Modal open={!!del} onClose={() => setDel(null)} width="max-w-sm">
        {del && (
          <>
            <ModalHeader title="删除剧本" onClose={() => setDel(null)} />
            <div className="px-5 py-4 text-sm text-muted-foreground">
              确定删除《{del.title}》吗？删除后前台不可见，已购用户的订单不受影响。如只是暂停销售，建议使用「下架」。
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
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
    <button onClick={onClick} title={label} aria-label={label} className={cn('grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition', danger ? 'hover:bg-rose-50 hover:text-rose-600' : 'hover:bg-muted hover:text-foreground')}>
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
          <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">$</span>
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
            className="h-8 w-24 rounded-lg border border-primary pr-2 pl-6 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
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
      className="group/p -ml-2 flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium transition hover:bg-muted"
      title="点击修改价格"
    >
      {money(s.price)}
      <Icon name="edit" size={13} className="text-muted-foreground opacity-0 transition group-hover/p:opacity-100" />
    </button>
  )
}
