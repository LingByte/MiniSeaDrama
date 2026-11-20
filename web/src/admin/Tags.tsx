import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Field, Modal, ModalHeader, QualityBadge, cn, inputCls } from '../components/ui'
import { getVals, uid, type Script, type TagGroup } from '../lib/data'
import { useStore } from '../lib/store'
import { Card, PageHeader, StatusBadge } from './parts'

export function Tags() {
  const { state, saveGroup, deleteGroup, addTag, renameTag, removeTag, toast } = useStore()
  const [gid, setGid] = useState('quality')
  const [newTag, setNewTag] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')
  const [assign, setAssign] = useState<string | null>(null)
  const [delTag, setDelTag] = useState<string | null>(null)
  const [delGroup, setDelGroup] = useState(false)
  const [newGroup, setNewGroup] = useState<TagGroup | null>(null)
  const [renamingGroup, setRenamingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')

  const group = state.tagGroups.find((g) => g.id === gid) ?? state.tagGroups[0]
  const scripts = state.scripts
  const usage = (name: string) => scripts.filter((s) => getVals(s, group.id).includes(name))
  const maxUse = Math.max(1, ...group.tags.map((t) => usage(t).length))
  const tagged = scripts.filter((s) => getVals(s, group.id).length > 0).length

  const submitNew = () => {
    const n = newTag.trim()
    if (!n) return
    if (group.tags.includes(n)) return toast('该分类下已有同名标签', 'error')
    addTag(group.id, n)
    setNewTag('')
    toast(`已添加标签「${n}」`)
  }
  const submitRename = (from: string) => {
    const to = editVal.trim()
    setEditing(null)
    if (!to || to === from) return
    if (group.tags.includes(to)) return toast('该分类下已有同名标签', 'error')
    renameTag(group.id, from, to)
    toast(`已改名为「${to}」，关联剧本同步更新`)
  }

  return (
    <>
      <PageHeader
        title="标签管理"
        sub="按分类管理标签。一部剧本可同时拥有多个分类下的多个标签；「剧本质量」是单选分级，每部剧本只能有一个等级。"
        actions={
          <Button icon="plus" onClick={() => setNewGroup({ id: uid('g'), name: '', mode: 'multi', desc: '', tags: [] })}>
            新建标签分类
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[270px_1fr]">
        {/* 分类列表 */}
        <Card className="self-start p-2">
          <ul className="stagger space-y-1">
            {state.tagGroups.map((g, i) => (
              <li key={g.id} style={{ ['--i' as string]: i }}>
                <button
                  onClick={() => {
                    setGid(g.id)
                    setEditing(null)
                    setRenamingGroup(false)
                  }}
                  className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition', g.id === group.id ? 'bg-muted' : 'hover:bg-muted/50')}
                >
                  <span className={cn('grid h-8 w-8 place-items-center rounded-lg transition', g.id === group.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                    <Icon name={g.id === 'quality' ? 'sparkle' : 'hash'} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{g.name}</span>
                      {g.system && <span className="rounded border border-border bg-card px-1 text-[10px] font-medium text-muted-foreground">内置</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {g.tags.length} 个标签 · {g.mode === 'single' ? '单选' : '多选'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        {/* 分类详情 */}
        <div key={group.id} className="anim-scale-in min-w-0 space-y-5">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div className="min-w-0">
                {renamingGroup ? (
                  <input
                    autoFocus
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    onBlur={() => {
                      setRenamingGroup(false)
                      if (groupName.trim() && groupName.trim() !== group.name) saveGroup({ ...group, name: groupName.trim() })
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    className={cn(inputCls, 'h-9 w-52 text-base font-semibold')}
                  />
                ) : (
                  <h2 className="flex items-center gap-2 text-lg font-bold">
                    {group.name}
                    <button
                      onClick={() => {
                        setGroupName(group.name)
                        setRenamingGroup(true)
                      }}
                      className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-primary"
                      aria-label="重命名分类"
                    >
                      <Icon name="edit" size={14} />
                    </button>
                  </h2>
                )}
                <p className="mt-1 text-sm text-muted-foreground">{group.desc || '自定义标签分类，可在上架剧本时为剧本打标签'}</p>
              </div>
              <div className="flex items-center gap-2">
                {group.id === 'quality' ? (
                  <Badge tone="brand">固定单选</Badge>
                ) : (
                  <div className="flex h-9 gap-1 rounded-xl bg-slate-100/80 p-1">
                    {(
                      [
                        ['multi', '多选'],
                        ['single', '单选'],
                      ] as const
                    ).map(([m, l]) => (
                      <button key={m} onClick={() => saveGroup({ ...group, mode: m })} className={cn('rounded-lg px-3 text-[13px] transition', group.mode === m ? 'bg-white font-semibold shadow-sm' : 'text-muted-foreground')}>
                        {l}
                      </button>
                    ))}
                  </div>
                )}
                {!group.system && (
                  <Button variant="danger" size="sm" icon="trash" onClick={() => setDelGroup(true)}>
                    删除分类
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 divide-x divide-border border-t border-border text-center">
              {[
                ['标签数', group.tags.length],
                ['已打标签的剧本', `${tagged} / ${scripts.length}`],
                ['未打标签', scripts.length - tagged],
              ].map(([l, v]) => (
                <div key={l as string} className="py-3.5">
                  <p className="text-lg font-bold">{v}</p>
                  <p className="text-xs text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card title="标签列表" extra={<span className="text-xs text-muted-foreground">点击名称可改名 · 改名后关联剧本自动同步</span>}>
            <ul className="divide-y divide-border">
              {group.tags.map((t) => {
                const used = usage(t)
                return (
                  <li key={t} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40">
                    <div className="w-44 shrink-0">
                      {editing === t ? (
                        <input
                          autoFocus
                          value={editVal}
                          onChange={(e) => setEditVal(e.target.value)}
                          onBlur={() => submitRename(t)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename(t)
                            if (e.key === 'Escape') setEditing(null)
                          }}
                          className={cn(inputCls, 'h-8')}
                        />
                      ) : (
                        <button
                          onClick={() => {
                            setEditing(t)
                            setEditVal(t)
                          }}
                          className="text-left"
                          title="点击改名"
                        >
                          {group.id === 'quality' ? <QualityBadge q={t} /> : <span className="rounded-lg border border-border bg-muted px-2.5 py-1 text-sm font-medium text-foreground">#{t}</span>}
                        </button>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(used.length / maxUse) * 100}%` }} />
                      </div>
                      <p className="mt-1.5 truncate text-xs text-muted-foreground">{used.length ? used.map((s) => s.title).join('、') : '暂无剧本使用'}</p>
                    </div>
                    <span className="w-14 text-right text-sm font-semibold tabular-nums">{used.length} 部</span>
                    <div className="flex gap-1">
                      <Button variant="soft" size="sm" onClick={() => setAssign(t)}>
                        关联剧本
                      </Button>
                      <button onClick={() => setDelTag(t)} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-rose-50 hover:text-rose-600" aria-label={`删除 ${t}`}>
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </li>
                )
              })}
              {!group.tags.length && <li className="px-5 py-10 text-center text-sm text-muted-foreground">还没有标签，在下方添加第一个</li>}
            </ul>
            <div className="flex gap-2 border-t border-border p-4">
              <input value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitNew()} placeholder={group.id === 'quality' ? '新增质量等级，如：S+ 年度爆款' : `在「${group.name}」下新增标签，回车添加`} className={inputCls} />
              <Button icon="plus" onClick={submitNew} disabled={!newTag.trim()}>
                添加
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {/* 关联剧本抽屉 */}
      <Modal open={!!assign} onClose={() => setAssign(null)} side>
        {assign && <AssignPanel group={group} tag={assign} onClose={() => setAssign(null)} />}
      </Modal>

      {/* 删除标签确认 */}
      <Modal open={!!delTag} onClose={() => setDelTag(null)} width="max-w-sm">
        {delTag && (
          <>
            <ModalHeader title="删除标签" onClose={() => setDelTag(null)} />
            <div className="px-6 py-5 text-sm text-muted-foreground">
              确定删除「{delTag}」吗？
              {usage(delTag).length > 0 ? <span className="text-rose-600">它正被 {usage(delTag).length} 部剧本使用，删除后会从这些剧本上移除。</span> : '目前没有剧本使用它。'}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button variant="secondary" onClick={() => setDelTag(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  removeTag(group.id, delTag)
                  toast(`已删除标签「${delTag}」`, 'info')
                  setDelTag(null)
                }}
              >
                确认删除
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* 删除分类确认 */}
      <Modal open={delGroup} onClose={() => setDelGroup(false)} width="max-w-sm">
        <ModalHeader title="删除标签分类" onClose={() => setDelGroup(false)} />
        <div className="px-6 py-5 text-sm text-muted-foreground">删除分类「{group.name}」会同时移除其下全部 {group.tags.length} 个标签及剧本上的关联，且无法恢复。</div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="secondary" onClick={() => setDelGroup(false)}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              deleteGroup(group.id)
              toast(`已删除分类「${group.name}」`, 'info')
              setDelGroup(false)
              setGid('quality')
            }}
          >
            确认删除
          </Button>
        </div>
      </Modal>

      {/* 新建分类 */}
      <Modal open={!!newGroup} onClose={() => setNewGroup(null)} width="max-w-md">
        {newGroup && (
          <>
            <ModalHeader title="新建标签分类" sub="例如「受众画像」「改编难度」「制作成本」" onClose={() => setNewGroup(null)} />
            <div className="space-y-4 px-6 py-5">
              <Field label="分类名称" required>
                <input autoFocus className={inputCls} value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} placeholder="如：改编难度" />
              </Field>
              <Field label="选择方式">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['multi', '多选', '一部剧本可打多个标签'],
                      ['single', '单选', '一部剧本只能选一个'],
                    ] as const
                  ).map(([m, l, d]) => (
                    <button key={m} onClick={() => setNewGroup({ ...newGroup, mode: m })} className={cn('rounded-xl border p-3 text-left transition', newGroup.mode === m ? 'border-primary bg-muted' : 'border-border hover:bg-muted/50')}>
                      <p className="text-sm font-semibold">{l}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{d}</p>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="说明（选填）">
                <input className={inputCls} value={newGroup.desc} onChange={(e) => setNewGroup({ ...newGroup, desc: e.target.value })} placeholder="这个分类用来做什么" />
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button variant="secondary" onClick={() => setNewGroup(null)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  const n = newGroup.name.trim()
                  if (!n) return toast('请填写分类名称', 'error')
                  if (state.tagGroups.some((g) => g.name === n)) return toast('已存在同名分类', 'error')
                  saveGroup({ ...newGroup, name: n })
                  setGid(newGroup.id)
                  setNewGroup(null)
                  toast(`分类「${n}」已创建，现在添加标签吧`)
                }}
              >
                创建分类
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  )
}

function AssignPanel({ group, tag, onClose }: { group: TagGroup; tag: string; onClose: () => void }) {
  const { state, setTagScripts, toast } = useStore()
  const initial = state.scripts.filter((s) => getVals(s, group.id).includes(tag)).map((s) => s.id)
  const [sel, setSel] = useState<string[]>(initial)
  const changed = sel.length !== initial.length || sel.some((i) => !initial.includes(i))
  const toggle = (id: string) => setSel((x) => (x.includes(id) ? x.filter((i) => i !== id) : [...x, id]))

  return (
    <>
      <ModalHeader title={`关联剧本 · ${tag}`} sub={`${group.name}${group.mode === 'single' ? '（单选：选中后会替换剧本原有等级）' : ''}`} onClose={onClose} />
      <ul className="divide-y divide-border">
        {state.scripts.map((s: Script) => {
          const on = sel.includes(s.id)
          const other = group.mode === 'single' ? getVals(s, group.id).find((v) => v !== tag) : undefined
          return (
            <li key={s.id}>
              <button onClick={() => toggle(s.id)} className={cn('flex w-full items-center gap-3 px-6 py-3 text-left transition-colors', on ? 'bg-muted' : 'hover:bg-slate-50')}>
                <span className={cn('grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border transition-all', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card')}>{on && <Icon name="check" size={12} stroke={3.5} className="anim-pop" />}</span>
                <img src={s.cover} alt="" className="h-11 w-9 rounded-md object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.title}</span>
                  <span className="text-xs text-muted-foreground">{s.tags.slice(0, 3).join(' · ') || '未设置情节标签'}</span>
                </span>
                {other && !on && <span className="text-[11px] text-muted-foreground">当前：{other}</span>}
                <StatusBadge status={s.status} />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="sticky bottom-0 flex items-center justify-between border-t border-border bg-white/95 px-6 py-4 backdrop-blur">
        <span className="text-sm text-muted-foreground">已选 {sel.length} 部</span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!changed}
            onClick={() => {
              setTagScripts(group.id, tag, sel)
              toast(`「${tag}」已关联 ${sel.length} 部剧本`)
              onClose()
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </>
  )
}
