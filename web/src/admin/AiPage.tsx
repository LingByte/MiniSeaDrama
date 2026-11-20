import { AiGenerate } from './AiGenerate'
import { AiJobTray } from './AiJobTray'
import { useStore } from '../lib/store'
import { PageHeader } from './parts'

export function AiPage() {
  const { toast } = useStore()
  return (
    <div className="space-y-6">
      <PageHeader
        title="AI 剧本生成"
        sub="提交后进后台队列，可同时跑多部；完成后在上方点「填入上架表单」，自动带上 Word / 封面 / 信息 / 标签 / 定价"
      />
      <AiJobTray />
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <AiGenerate
          onApply={() => {
            toast('请到上方任务列表点「填入上架表单」')
          }}
        />
      </div>
    </div>
  )
}
