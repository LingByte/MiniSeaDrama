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
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition hover:bg-muted/30"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-muted">
        <img src={s.cover} alt={`${s.title} 封面`} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
        <span className="absolute top-2.5 right-2.5 flex items-center gap-1 rounded-md border border-border bg-card/95 px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
          <Icon name="star" size={11} className="fill-amber-400 text-amber-400" />
          {s.rating.toFixed(1)}
        </span>
        <div className="absolute inset-x-2.5 bottom-2.5">
          <div className="flex flex-wrap gap-1">
            {s.quality && <QualityBadge q={s.quality} />}
            {s.tags.slice(0, 2).map((g) => (
              <Badge key={g} tone="white">
                {g}
              </Badge>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col p-3.5">
        <h3 className="line-clamp-1 text-sm font-semibold text-foreground group-hover:text-primary">{s.title}</h3>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{s.enTitle}</p>
        <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{s.totalEpisodes} 集</span>
          <span className="h-3 w-px bg-border" />
          <span>{s.language}</span>
          <span className="h-3 w-px bg-border" />
          <span>已售 {s.sales}</span>
        </p>
        <div className="mt-auto flex items-end gap-2 pt-3">
          <span className="text-base font-semibold tracking-tight text-foreground">{money(q.total)}</span>
          <span className="ml-auto pb-0.5 text-[11px] text-muted-foreground">{SALE_LABEL[s.saleType]}</span>
        </div>
      </div>
    </button>
  )
}
