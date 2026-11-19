import { Icon } from '../components/Icon'
import { Badge, QualityBadge, idx } from '../components/ui'
import { SALE_LABEL, money, quote, type Script } from '../lib/data'
import { go } from '../lib/store'

export function ScriptCard({ s, i = 0 }: { s: Script; i?: number }) {
  const q = quote(s)
  return (
    <button
      onClick={() => go(`/script/${s.id}`)}
      style={idx(i)}
      className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-white text-left transition-all duration-500 ease-[var(--ease-smooth)] hover:-translate-y-1.5 hover:border-brand-200 hover:shadow-[0_24px_48px_-24px_rgba(26,107,240,.45)]"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-brand-50">
        <img src={s.cover} alt={`${s.title} 封面`} loading="lazy" className="h-full w-full object-cover transition-transform duration-[900ms] ease-[var(--ease-smooth)] group-hover:scale-[1.06]" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-900/75 via-ink-900/0 to-ink-900/0" />
        <span className="absolute top-3 right-3 flex items-center gap-1 rounded-lg bg-white/90 px-1.5 py-1 text-[11px] font-semibold text-ink-800 backdrop-blur">
          <Icon name="star" size={11} className="fill-amber-400 text-amber-400" />
          {s.rating.toFixed(1)}
        </span>
        <div className="absolute inset-x-3 bottom-3">
          <div className="flex flex-wrap gap-1.5">
            {s.quality && <QualityBadge q={s.quality} />}
            {s.tags.slice(0, 2).map((g) => (
              <Badge key={g} tone="white">
                {g}
              </Badge>
            ))}
          </div>
          <div className="mt-2.5 flex translate-y-3 items-center justify-center gap-1.5 rounded-xl bg-white py-2 text-[13px] font-semibold text-brand-700 opacity-0 transition-all duration-300 ease-[var(--ease-smooth)] group-hover:translate-y-0 group-hover:opacity-100">
            <Icon name="book" size={15} />
            免费试读前 {s.trialCount} 集
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-1 font-semibold text-ink-900 transition-colors group-hover:text-brand-700">{s.title}</h3>
        <p className="mt-0.5 line-clamp-1 text-xs text-ink-400">{s.enTitle}</p>
        <p className="mt-2.5 flex items-center gap-2 text-xs text-ink-500">
          <span>{s.totalEpisodes} 集</span>
          <span className="h-3 w-px bg-line" />
          <span>{s.language}</span>
          <span className="h-3 w-px bg-line" />
          <span>已售 {s.sales}</span>
        </p>
        <div className="mt-auto flex items-end gap-2 pt-3">
          <span className="text-lg font-bold tracking-tight text-brand-700">{money(q.total)}</span>
          <span className="ml-auto pb-0.5 text-[11px] text-ink-400">{SALE_LABEL[s.saleType]}</span>
        </div>
      </div>
    </button>
  )
}
