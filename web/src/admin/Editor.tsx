import { useEffect, useRef, useState, type DragEvent, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Icon } from '../components/Icon'
import { Badge, Button, Field, QualityBadge, ScriptText, cn, download, inputCls } from '../components/ui'
import { saveScriptFile } from '../lib/files'
import { clearHandoff, markAiJobListed, peekHandoffFile, readHandoff } from '../lib/aiJobs'
import { GRADE_SUGGEST_PRICE, LANGUAGES, PRICE_LABEL, SALE_LABEL, SALE_NOTE, SAMPLE_TXT, getVals, money, parseEpisodes, quote, setVals, suggestPrice, type SaleType, type Script } from '../lib/data'
import { go, newId, useStore } from '../lib/store'
import { Card, PageHeader } from './parts'

const STEPS = [
  { t: '上传剧本文件', d: '剧本原稿与封面' },
  { t: '基本信息', d: '剧名、简介、集数' },
  { t: '标签与分类', d: '品质、情节标签、市场' },
  { t: '定价与试读', d: '价格与免费集数' },
  { t: '预览并发布', d: '检查后上架' },
]

const blank = (): Script => ({
  id: newId(),
  title: '',
  enTitle: '',
  logline: '',
  synopsis: '',
  cover: '',
  tags: [],
  markets: [],
  quality: '',
  saleType: 'wholesale',
  extra: {},
  audience: '女频',
  language: '英语',
  totalEpisodes: 60,
  trialCount: 3,
  episodes: [],
  price: 199,
  status: 'draft',
  sales: 0,
  rating: 4.8,
  createdAt: new Date().toISOString(),
  priceHistory: [],
})

export function Editor({ id }: { id?: string }) {
  const { state, saveScript, refresh, toast } = useStore()
  const existing = id ? state.scripts.find((s) => s.id === id) : undefined
  const [f, setF] = useState<Script>(() => (existing ? structuredClone(existing) : blank()))
  const [step, setStep] = useState(existing ? 1 : 0)
  const [showErr, setShowErr] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const aiJobId = useRef<string>('')
  const set = <K extends keyof Script>(k: K, v: Script[K]) => setF((x) => ({ ...x, [k]: v }))

  // AI 页「填入上架表单」交接：Word + 封面 + 基本信息 + 标签 + 定价一次灌入
  useEffect(() => {
    if (id || existing) return
    const handoff = readHandoff()
    if (!handoff) return
    aiJobId.current = handoff.jobId
    const cached = handoff.file || peekHandoffFile(handoff.jobId)
    setF((x) => ({
      ...x,
      ...handoff.fields,
      cover: handoff.cover || handoff.fields.cover || x.cover,
      fileName: handoff.fileName || handoff.fields.fileName || x.fileName,
      fileSize: handoff.fileSize || handoff.fields.fileSize || x.fileSize,
      id: x.id,
      createdAt: x.createdAt,
      sales: 0,
      rating: x.rating || 4.8,
    }))
    if (cached) setFile(cached)
    setStep(4)
    clearHandoff()
    toast('已填入 AI 生成结果（文件 / 封面 / 信息 / 标签 / 定价），请核对后上架')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (id && !existing) return <p className="text-muted-foreground">剧本不存在。</p>

  const errors: Record<number, string[]> = {
    0: [!f.fileName && '请上传剧本文件', !f.cover && '请上传封面图'].filter(Boolean) as string[],
    1: [!f.title.trim() && '请填写中文剧名', !f.enTitle.trim() && '请填写英文剧名', !f.logline.trim() && '请填写一句话卖点', !f.synopsis.trim() && '请填写剧情简介', f.totalEpisodes < 1 && '请填写总集数'].filter(Boolean) as string[],
    2: [!f.tags.length && '至少选择 1 个情节标签', !f.markets.length && '至少选择 1 个目标市场', !f.quality && '请选择剧本质量等级'].filter(Boolean) as string[],
    3: [!(f.price > 0) && '请设置价格', f.episodes.filter((e) => e.text.trim()).length < f.trialCount && `试读 ${f.trialCount} 集，需填写对应的试读内容`].filter(Boolean) as string[],
  }
  const allErrors = [0, 1, 2, 3].flatMap((i) => errors[i])
  const stepDone = (i: number) => i < 4 && !errors[i]?.length

  const next = () => {
    if (errors[step]?.length) return setShowErr(true)
    setShowErr(false)
    setStep(step + 1)
  }

  /** 保存剧本 → 真实上传 Word → 回读服务端。任一步失败都不跳转，让用户能当场重试 */
  const persist = async (status: Script['status']): Promise<boolean> => {
    const isNew = !existing
    const priceChanged = existing && existing.price !== f.price
    const history = isNew || !f.priceHistory.length
      ? [{ price: f.price, at: new Date().toISOString(), note: '首次上架定价' }]
      : priceChanged
        ? [...f.priceHistory, { price: f.price, at: new Date().toISOString(), note: '编辑剧本时调价' }]
        : f.priceHistory
    try {
      await saveScript({ ...f, status, priceHistory: history, trialCount: Math.min(f.trialCount, f.episodes.length || f.trialCount) })
    } catch {
      return false // saveScript 内部已提示错误
    }
    if (file) {
      try {
        await saveScriptFile(f.id, file)
        await refresh()
      } catch (e) {
        toast(`剧本已保存，但 Word 文件上传失败：${e instanceof Error ? e.message : '未知错误'}`, 'error')
        return false
      }
    }
    // 来自 AI 任务的新剧本：保存草稿或正式上架后都打「已上架」标记，避免任务列表重复「填入」
    if (aiJobId.current) {
      markAiJobListed(aiJobId.current, f.id)
    }
    return true
  }

  return (
    <>
      <PageHeader
        title={existing ? `编辑剧本 · ${existing.title}` : '上架新剧本'}
        sub={existing ? '修改后点击「保存」即时生效；在售剧本的价格变动会记录到调价历史' : '按步骤上传剧本、填写信息、设置价格，完成后即可在前台售卖'}
        actions={
          <>
            <Button variant="ghost" onClick={() => go('/manage/scripts')}>
              取消
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                if (!f.title.trim()) return toast('至少填写中文剧名后再保存草稿', 'error')
                const ok = await persist(existing && existing.status !== 'draft' ? existing.status : 'draft')
                if (!ok) return
                toast(existing && existing.status !== 'draft' ? '修改已保存' : '已保存为草稿')
                go('/manage/scripts')
              }}
            >
              {existing && existing.status !== 'draft' ? '保存修改' : '保存草稿'}
            </Button>
          </>
        }
      />

      {/* 步骤条 */}
      <Card className="mb-5 px-3 py-3">
        <ol className="grid grid-cols-5 gap-1">
          {STEPS.map((s, i) => {
            const done = stepDone(i) && i !== step
            return (
              <li key={s.t}>
                <button
                  onClick={() => {
                    setShowErr(false)
                    setStep(i)
                  }}
                  className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition', i === step ? 'bg-muted' : 'hover:bg-muted/50')}
                >
                  <span
                    className={cn(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold transition',
                      i === step ? 'bg-primary text-primary-foreground' : done ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {done ? <Icon name="check" size={15} stroke={3} /> : i + 1}
                  </span>
                  <span className="hidden min-w-0 md:block">
                    <span className={cn('block truncate text-sm', i === step ? 'font-semibold text-foreground' : 'font-medium text-foreground')}>{s.t}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.d}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card className="min-w-0">
          <div key={step} className="anim-scale-in p-6 md:p-8">
            {step === 0 && (
              <>
                {!existing && (
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium text-foreground">用 AI 生成整部剧本</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        去「AI 生成」页提交任务；完成后点「填入上架表单」，会自动带上 Word、封面、信息、标签与定价。
                      </p>
                    </div>
                    <Button variant="secondary" onClick={() => go('/manage/ai')}>
                      <Icon name="sparkle" size={15} className="mr-1.5" />
                      打开 AI 生成
                    </Button>
                  </div>
                )}
                <StepUpload f={f} set={set} setF={setF} onFile={setFile} pending={!!file} />
              </>
            )}
            {step === 1 && <StepBasic f={f} set={set} />}
            {step === 2 && <StepGenre f={f} setF={setF} />}
            {step === 3 && <StepPricing f={f} set={set} />}
            {step === 4 && <StepReview f={f} errors={allErrors} goStep={setStep} />}

            {showErr && errors[step]?.length > 0 && (
              <div className="anim-scale-in mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                {errors[step].map((e) => (
                  <p key={e} className="flex items-center gap-2">
                    <Icon name="info" size={14} /> {e}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border px-6 py-4 md:px-8">
            <Button variant="ghost" icon="arrowLeft" disabled={step === 0} onClick={() => setStep(step - 1)}>
              上一步
            </Button>
            {step < 4 ? (
              <Button onClick={next}>
                下一步：{STEPS[step + 1].t} <Icon name="arrowRight" size={15} />
              </Button>
            ) : (
              <Button
                icon="upload"
                disabled={allErrors.length > 0}
                onClick={async () => {
                  const ok = await persist('on')
                  if (!ok) return
                  toast(`《${f.title}》已上架，前台已可购买`)
                  go('/manage/scripts')
                }}
              >
                {existing?.status === 'on' ? '保存并保持在售' : '立即上架销售'}
              </Button>
            )}
          </div>
        </Card>

        {/* 实时预览 */}
        <aside className="xl:sticky xl:top-24 xl:self-start">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon name="eye" size={14} /> 前台卡片实时预览
          </p>
          <PreviewCard f={f} />
        </aside>
      </div>
    </>
  )
}

type StepProps = { f: Script; set: <K extends keyof Script>(k: K, v: Script[K]) => void }

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="mb-8 last:mb-0">
      <h3 className="font-semibold">{title}</h3>
      {sub && <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>}
      <div className="mt-4">{children}</div>
    </div>
  )
}

function Dropzone({ accept, onFile, children, className }: { accept: string; onFile: (f: File) => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) onFile(file)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-300',
        over ? 'scale-[1.01] border-primary bg-muted' : 'border-border bg-muted/30 hover:border-primary hover:bg-muted',
        className,
      )}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
      {children}
    </div>
  )
}

const fmtSize = (n?: number) => (!n ? '' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB')

function StepUpload({ f, set, setF, onFile, pending }: StepProps & { setF: (fn: (s: Script) => Script) => void; onFile: (f: File) => void; pending: boolean }) {
  const { toast } = useStore()
  const [parsed, setParsed] = useState<number | null>(null)

  // 先在编辑器里暂存选中的文件；真正上传发生在保存剧本成功之后（避免假进度条 / 假「已上传」状态）
  const onScript = (file: File) => {
    if (!/\.docx?$/i.test(file.name)) return toast('请上传 Word 文件（.doc / .docx）', 'error')
    onFile(file)
    setF((x) => ({ ...x, fileName: file.name, fileSize: file.size }))
    toast('已选择文件，保存剧本时上传到服务器', 'info')
  }

  // 可选：用 TXT 版本一键拆分试读集
  const onTrial = (file: File) => {
    if (!/\.txt$/i.test(file.name)) return toast('试读导入仅支持 TXT 文件', 'error')
    file.text().then((txt) => {
      const eps = parseEpisodes(txt)
      setParsed(eps.length)
      setF((x) => ({ ...x, episodes: eps, trialCount: Math.min(x.trialCount, eps.length) || 1 }))
      toast(`已识别 ${eps.length} 集，已填入试读内容`)
    })
  }

  const onCover = (file: File) => {
    if (!file.type.startsWith('image/')) return toast('请上传图片文件', 'error')
    void (async () => {
      try {
        const { uploadCoverFile } = await import('../lib/files')
        const { url, key } = await uploadCoverFile(file)
        // 预览用签名 URL；保存时服务端会抽出 object key 入库（禁止 base64）
        set('cover', url || key)
        toast('封面已上传到对象存储')
      } catch (e) {
        toast(e instanceof Error ? e.message : '封面上传失败', 'error')
      }
    })()
  }

  return (
    <>
      <Section title="剧本文件（Word）" sub="买家购买后下载的就是这份文件。选中文件后需保存剧本，才会真正上传到服务器（.doc / .docx）。">
        {f.fileName ? (
          <div className="anim-scale-in flex items-center gap-4 rounded-2xl border border-border p-4">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-muted text-primary">
              <Icon name="file" size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{f.fileName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {fmtSize(f.fileSize)} · {pending ? '待上传：保存剧本后写入服务器' : '已上传至服务器，买家购买后可下载'}
              </p>
            </div>
            <Badge tone={pending ? 'orange' : 'green'}>
              <Icon name={pending ? 'upload' : 'check'} size={12} /> {pending ? '待上传' : '已上传'}
            </Badge>
            <Dropzone accept=".doc,.docx" onFile={onScript} className="!rounded-lg !border !border-solid !border-border !bg-white px-3 py-1.5 text-[13px] font-medium text-foreground">
              替换文件
            </Dropzone>
          </div>
        ) : (
          <Dropzone accept=".doc,.docx" onFile={onScript} className="px-6 py-10 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white text-primary shadow-sm ring-1 ring-ring/30">
              <Icon name="upload" size={24} />
            </span>
            <p className="mt-4 font-medium">
              拖拽 Word 文件到此处，或 <span className="text-primary">点击选择文件</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">支持 .doc / .docx，保存剧本时上传</p>
          </Dropzone>
        )}
      </Section>

      <Section title="试读内容导入（可选）" sub="有 TXT 版本时，可按「第 N 集」自动拆分并填入试读内容；也可以稍后在第 4 步手动填写。">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <Dropzone accept=".txt" onFile={onTrial} className="!rounded-xl px-4 py-2.5 text-sm font-medium text-primary">
              <Icon name="upload" size={15} className="mr-1.5 inline -translate-y-px" />
              导入 TXT 并自动分集
            </Dropzone>
          </div>
          {parsed !== null && (
            <span className="anim-scale-in flex items-center gap-1 text-sm text-emerald-600">
              <Icon name="check" size={14} /> 已识别 {parsed} 集
            </span>
          )}
          <button onClick={() => download('海漫剧本模板.txt', SAMPLE_TXT)} className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
            <Icon name="download" size={13} /> 下载 TXT 分集模板
          </button>
        </div>
      </Section>

      <Section title="剧本封面" sub="建议竖版 3:4，最小 900×1200 像素，JPG / PNG 格式">
        <div className="flex flex-wrap items-start gap-5">
          <Dropzone accept="image/*" onFile={onCover} className="group relative grid aspect-[3/4] w-40 place-items-center overflow-hidden">
            {f.cover ? (
              <>
                <img src={f.cover} alt="封面" className="anim-fade-in absolute inset-0 h-full w-full object-cover" />
                <span className="absolute inset-0 grid place-items-center bg-foreground/50 text-sm font-medium text-white opacity-0 transition group-hover:opacity-100">更换封面</span>
              </>
            ) : (
              <span className="text-center text-xs text-muted-foreground">
                <Icon name="image" size={26} className="mx-auto mb-2 text-muted-foreground" />
                上传封面
              </span>
            )}
          </Dropzone>
          <ul className="space-y-2 pt-1 text-[13px] text-muted-foreground">
            {['人物主体居中，面部清晰', '避免大面积文字，系统会自动叠加题材标签', '封面将用于前台列表、详情页与订单'].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <Icon name="check" size={14} className="text-primary" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </>
  )
}

function StepBasic({ f, set }: StepProps) {
  return (
    <>
      <Section title="剧名与卖点">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="中文剧名" required>
            <input className={inputCls} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="如：总裁的契约新娘" />
          </Field>
          <Field label="英文剧名" required hint="海外买家主要通过英文名检索">
            <input className={inputCls} value={f.enTitle} onChange={(e) => set('enTitle', e.target.value)} placeholder="The CEO's Contract Bride" />
          </Field>
          <div className="md:col-span-2">
            <Field label="一句话卖点" required hint={`${f.logline.length}/40 字，展示在详情页标题下方`}>
              <input className={inputCls} maxLength={40} value={f.logline} onChange={(e) => set('logline', e.target.value)} placeholder="用一句话抓住买家：冲突 + 反转" />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="剧情简介" required hint={`${f.synopsis.length}/300 字`}>
              <textarea rows={5} maxLength={300} className={cn(inputCls, 'h-auto py-3 leading-relaxed')} value={f.synopsis} onChange={(e) => set('synopsis', e.target.value)} placeholder="主角是谁、遇到什么困境、核心冲突与看点……" />
            </Field>
          </div>
        </div>
      </Section>
      <Section title="剧本规格">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="总集数" required>
            <Stepper value={f.totalEpisodes} min={1} max={300} onChange={(v) => set('totalEpisodes', v)} suffix="集" />
          </Field>
          <Field label="剧本语言">
            <select className={inputCls} value={f.language} onChange={(e) => set('language', e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="受众频道">
            <div className="flex h-10 gap-1 rounded-xl bg-slate-100/80 p-1">
              {(['女频', '男频'] as const).map((a) => (
                <button key={a} type="button" onClick={() => set('audience', a)} className={cn('flex-1 rounded-lg text-sm transition-all', f.audience === a ? 'bg-white font-semibold shadow-sm' : 'text-muted-foreground')}>
                  {a}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Section>
    </>
  )
}

function StepGenre({ f, setF }: { f: Script; setF: Dispatch<SetStateAction<Script>> }) {
  const { state, addTag, toast } = useStore()
  const [draft, setDraft] = useState<Record<string, string>>({})

  const toggle = (gid: string, mode: 'single' | 'multi', name: string) =>
    setF((x) => {
      const v = getVals(x, gid)
      let next = x
      if (mode === 'single') next = setVals(x, gid, v[0] === name ? [] : [name])
      else if (v.includes(name)) next = setVals(x, gid, v.filter((t) => t !== name))
      else next = setVals(x, gid, [...v, name])
      // 选中质量等级时，自动填入建议价（仍可在定价步手动改）
      if (gid === 'quality' && next.quality) {
        next = { ...next, price: suggestPrice(next.quality) }
      }
      return next
    })
  const addNew = (gid: string) => {
    const n = (draft[gid] ?? '').trim()
    if (!n) return
    const g = state.tagGroups.find((x) => x.id === gid)!
    if (!g.tags.includes(n)) addTag(gid, n)
    setF((x) => (getVals(x, gid).includes(n) ? x : setVals(x, gid, [...getVals(x, gid), n])))
    setDraft({ ...draft, [gid]: '' })
    toast(`标签「${n}」已添加到「${g.name}」并选中`)
  }

  return (
    <>
      <p className="mb-6 flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-[13px] text-foreground">
        <Icon name="info" size={15} />
        标签按分类管理，一部剧本可以同时拥有多个分类下的多个标签。想增删分类或改名，请到「标签管理」。
      </p>
      {state.tagGroups.map((g) => {
        const vals = getVals(f, g.id)
        const required = g.id === 'plot' || g.id === 'quality' || g.id === 'market'
        return (
          <Section
            key={g.id}
            title={`${g.name}${required ? ' *' : ''}`}
            sub={`${g.mode === 'single' ? '单选' : '多选'} · 已选 ${vals.length}。${g.desc ?? ''}`}
          >
            <div className="flex flex-wrap gap-2">
              {g.tags.map((t) => {
                const on = vals.includes(t)
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggle(g.id, g.mode, t)}
                    className={cn(
                      'flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-all duration-200 active:scale-95 disabled:opacity-40',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {on && <Icon name="check" size={14} stroke={3} className="anim-pop" />}
                    {t}
                  </button>
                )
              })}
              {!g.tags.length && <span className="text-sm text-muted-foreground">这个分类下还没有标签</span>}
            </div>
            {g.id !== 'quality' && (
              <div className="mt-3 flex max-w-sm gap-2">
                <input
                  value={draft[g.id] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [g.id]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && addNew(g.id)}
                  placeholder={`新增「${g.name}」标签，回车添加`}
                  className={cn(inputCls, 'h-9')}
                />
                <Button variant="secondary" size="sm" className="h-9" onClick={() => addNew(g.id)} disabled={!(draft[g.id] ?? '').trim()}>
                  添加
                </Button>
              </div>
            )}
          </Section>
        )
      })}
    </>
  )
}

function StepPricing({ f, set }: StepProps) {
  const { state } = useStore()
  const [active, setActive] = useState(0)
  const eps = f.episodes
  const ensure = (n: number) => {
    if (eps.length >= n) return eps
    return [...eps, ...Array.from({ length: n - eps.length }, (_, i) => ({ title: `第${eps.length + i + 1}集`, text: '' }))]
  }
  const setTrial = (n: number) => {
    set('trialCount', n)
    set('episodes', ensure(n))
    setActive(Math.min(active, n - 1))
  }
  const shown = ensure(f.trialCount).slice(0, f.trialCount)
  const updateEp = (i: number, patch: Partial<{ title: string; text: string }>) => {
    const list = ensure(f.trialCount).map((e, k) => (k === i ? { ...e, ...patch } : e))
    set('episodes', list)
  }

  return (
    <>
      <Section title="销售方式" sub="决定这部剧本怎么卖。设置后可在「定价中心」或剧本列表中随时更改。">
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['wholesale', SALE_LABEL.wholesale, SALE_NOTE.wholesale.long + ' 可重复出售。'],
              ['buyout', SALE_LABEL.buyout, SALE_NOTE.buyout.long + ' 被买走后前台标记「已买断」。'],
            ] as [SaleType, string, string][]
          ).map(([k, l, d]) => (
            <button
              key={k}
              type="button"
              onClick={() => set('saleType', k)}
              className={cn('relative rounded-xl border p-4 text-left transition', f.saleType === k ? 'border-primary bg-muted' : 'border-border hover:bg-muted/40')}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon name={k === 'buyout' ? 'lock' : 'layers'} size={17} className={f.saleType === k ? 'text-primary' : 'text-muted-foreground'} />
                {l}
              </span>
              <span className="mt-1.5 block text-[13px] leading-relaxed text-muted-foreground">{d}</span>
              {f.saleType === k && (
                <span className="anim-pop absolute top-3 right-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Icon name="check" size={12} stroke={3.5} />
                </span>
              )}
            </button>
          ))}
        </div>
      </Section>

      <Section title={PRICE_LABEL[f.saleType]} sub="单位：元（¥），即真实收款金额。上架后可在「定价中心」随时调整，调价会自动留痕。">
        <div className="grid gap-5 md:grid-cols-[1fr_1.1fr]">
          <div>
            <Field label={`${PRICE_LABEL[f.saleType]}（元 ¥）`} required>
              <div className="relative">
                <span className="absolute top-1/2 left-4 -translate-y-1/2 text-lg font-semibold text-muted-foreground">¥</span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={f.price || ''}
                  onChange={(e) => set('price', Math.round(Number(e.target.value) * 10) / 10)}
                  className={cn(inputCls, 'h-14 pl-9 text-2xl font-bold tracking-tight')}
                />
              </div>
            </Field>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(Object.entries(GRADE_SUGGEST_PRICE) as [string, number][]).map(([g, p]) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => set('price', p)}
                  className={cn('rounded-lg px-2.5 py-1 text-xs font-medium transition', f.price === p ? 'bg-primary text-white' : 'bg-slate-100 text-muted-foreground hover:bg-muted hover:text-primary')}
                >
                  {g} {money(p)}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              建议按评级定价（可改）。在售{SALE_LABEL[f.saleType]}均价 {money(avgPrice(state.scripts, f))}
              {f.quality ? ` · 当前评级建议 ${money(suggestPrice(f.quality))}` : ''}
            </p>
          </div>
          <div className="rounded-2xl bg-background p-4 text-sm">
            <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground">前台展示</p>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs text-muted-foreground">{PRICE_LABEL[f.saleType]}</p>
                <b key={f.price + f.saleType} className="anim-fade-in text-3xl font-bold tracking-tight text-primary">
                  {money(f.price)}
                </b>
              </div>
              <Badge tone={f.saleType === 'buyout' ? 'orange' : 'brand'}>{SALE_LABEL[f.saleType]}剧本</Badge>
            </div>
            <p className="mt-3 border-t border-dashed border-border pt-3 text-xs leading-relaxed text-muted-foreground">
              {f.saleType === 'buyout' ? '买断剧本售出后自动标记「已买断」。如需重新开放，在订单管理中对该订单办理退款即可。' : '批发试用剧本可重复出售，每笔订单都会计入销量。'}
            </p>
          </div>
        </div>
      </Section>

      <Section title="免费试读" sub="前台用户可免费阅读的集数，建议 2–3 集并以「卡点」结尾，提升转化">
        <div className="flex items-center gap-4">
          <input type="range" min={1} max={6} value={f.trialCount} onChange={(e) => setTrial(Number(e.target.value))} className="h-1.5 w-56 cursor-pointer accent-primary" />
          <span className="rounded-lg bg-muted px-3 py-1 text-sm font-semibold text-primary">前 {f.trialCount} 集</span>
        </div>
        <div className="mt-5 overflow-hidden rounded-2xl border border-border">
          <div className="flex gap-1 overflow-x-auto border-b border-border bg-slate-50/70 p-1.5">
            {shown.map((e, i) => (
              <button key={i} onClick={() => setActive(i)} className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] transition', active === i ? 'bg-white font-semibold text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                EP{i + 1}
                {e.text.trim() ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />}
              </button>
            ))}
          </div>
          {shown[active] && (
            <div key={active} className="anim-fade-in grid gap-0 md:grid-cols-2">
              <div className="space-y-3 border-border p-4 md:border-r">
                <input value={shown[active].title} onChange={(e) => updateEp(active, { title: e.target.value })} className={inputCls} placeholder="本集标题" />
                <textarea
                  rows={11}
                  value={shown[active].text}
                  onChange={(e) => updateEp(active, { text: e.target.value })}
                  className={cn(inputCls, 'h-auto py-3 font-mono text-[13px] leading-relaxed')}
                  placeholder={'# 内景 · 地点 · 时间\n动作描写……\n角色名：台词\n【卡点】结尾悬念'}
                />
                <p className="text-[11px] text-muted-foreground">格式：「#」开头为场景，「角色：台词」为对白，「【卡点】」为集末悬念</p>
              </div>
              <div className="max-h-[400px] overflow-y-auto bg-white p-5">
                <p className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground">前台阅读效果</p>
                {shown[active].text.trim() ? <ScriptText text={shown[active].text} /> : <p className="text-sm text-muted-foreground">在左侧输入内容后，这里会实时显示排版效果</p>}
              </div>
            </div>
          )}
        </div>
      </Section>
    </>
  )
}

function avgPrice(all: Script[], f: Script) {
  const same = all.filter((s) => s.id !== f.id && s.status === 'on' && s.saleType === f.saleType)
  return same.length ? same.reduce((a, s) => a + s.price, 0) / same.length : f.saleType === 'buyout' ? 8000 : 2700
}

function StepReview({ f, errors, goStep }: { f: Script; errors: string[]; goStep: (n: number) => void }) {
  const checks = [
    { ok: !!f.fileName, t: '剧本 Word 文件已上传', step: 0 },
    { ok: !!f.cover, t: '封面已设置', step: 0 },
    { ok: !!(f.title && f.enTitle && f.logline && f.synopsis), t: '剧名、卖点与简介已填写', step: 1 },
    { ok: f.tags.length > 0, t: `情节标签：${f.tags.join('、') || '未选择'}`, step: 2 },
    { ok: f.markets.length > 0, t: `目标市场：${f.markets.join('、') || '未选择'}`, step: 2 },
    { ok: !!f.quality, t: `剧本质量：${f.quality || '未选择'}`, step: 2 },
    { ok: f.price > 0, t: `${SALE_LABEL[f.saleType]} · ${PRICE_LABEL[f.saleType]} ${money(f.price)}`, step: 3 },
    { ok: f.episodes.slice(0, f.trialCount).every((e) => e.text.trim()) && f.episodes.length >= f.trialCount, t: `试读内容：前 ${f.trialCount} 集`, step: 3 },
  ]
  return (
    <>
      <Section title="发布前检查" sub={errors.length ? `还有 ${errors.length} 项需要完善` : '全部检查通过，可以上架销售'}>
        <ul className="stagger space-y-2">
          {checks.map((c, i) => (
            <li key={c.t} style={{ ['--i' as string]: i }} className={cn('flex items-center gap-3 rounded-xl px-4 py-3 ring-1', c.ok ? 'bg-emerald-50/50 ring-emerald-100' : 'bg-orange-50/50 ring-orange-100')}>
              <span className={cn('grid h-6 w-6 place-items-center rounded-full text-white', c.ok ? 'bg-emerald-500' : 'bg-orange-400')}>
                <Icon name={c.ok ? 'check' : 'info'} size={13} stroke={3} />
              </span>
              <span className="flex-1 text-sm">{c.t}</span>
              {!c.ok && (
                <button onClick={() => goStep(c.step)} className="text-xs font-medium text-primary hover:underline">
                  去完善
                </button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="上架后会发生什么">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['grid', '出现在前台剧本库', '按题材与市场可被筛选'],
            ['users', '买家试读后直接下单', '前台可免费阅读试读集'],
            ['tag', '随时可调价或下架', '调价记录自动留存'],
          ].map(([i, t, d]) => (
            <div key={t} className="rounded-xl border border-border p-4">
              <Icon name={i} className="text-primary" />
              <p className="mt-2 text-sm font-medium">{t}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}

function PreviewCard({ f }: { f: Script }) {
  const { state } = useStore()
  const q = quote(f)
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-[3/4] bg-muted">
        {f.cover ? (
          <img key={f.cover.slice(-30)} src={f.cover} alt="" className="anim-fade-in h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Icon name="image" size={40} stroke={1.4} />
          </span>
        )}
        {q.base > q.total && <span className="absolute top-3 left-3 rounded-lg bg-orange-600 px-2 py-1 text-[11px] font-semibold text-white">立省 {money(q.base - q.total)}</span>}
        <div className="absolute inset-x-3 bottom-3 flex flex-wrap gap-1.5">
          {f.quality && <QualityBadge q={f.quality} />}
          {f.tags.slice(0, 2).map((g) => (
            <Badge key={g} tone="white">
              {g}
            </Badge>
          ))}
        </div>
      </div>
      <div className="p-4">
        <p className={cn('truncate font-semibold', !f.title && 'text-muted-foreground')}>{f.title || '中文剧名'}</p>
        <p className="truncate text-xs text-muted-foreground">{f.enTitle || 'English Title'}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {f.totalEpisodes} 集 · {f.language} · 试读 {f.trialCount} 集
        </p>
        <div className="mt-3 flex items-end gap-2">
          <span className="text-lg font-bold text-primary">{money(q.total)}</span>
          {q.base > q.total && <span className="pb-0.5 text-xs text-muted-foreground line-through">{money(q.base)}</span>}
        </div>
      </div>
    </div>
  )
}

function Stepper({ value, onChange, min, max, suffix }: { value: number; onChange: (v: number) => void; min: number; max: number; suffix: string }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v || min))
  return (
    <div className="flex h-10 items-center overflow-hidden rounded-xl border border-border bg-white transition focus-within:border-primary focus-within:ring-3 focus-within:ring-ring/40">
      <button type="button" onClick={() => onChange(clamp(value - 5))} className="grid h-full w-10 place-items-center text-muted-foreground transition hover:bg-slate-50" aria-label="减少">
        <Icon name="minus" size={15} />
      </button>
      <input type="number" value={value} onChange={(e) => onChange(clamp(Number(e.target.value)))} className="h-full w-full min-w-0 text-center text-sm font-semibold outline-none" />
      <span className="pr-2 text-xs text-muted-foreground">{suffix}</span>
      <button type="button" onClick={() => onChange(clamp(value + 5))} className="grid h-full w-10 place-items-center text-muted-foreground transition hover:bg-slate-50" aria-label="增加">
        <Icon name="plus" size={15} />
      </button>
    </div>
  )
}
