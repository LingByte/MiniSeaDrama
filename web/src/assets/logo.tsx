import { type ImgHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/** Brand mark copied from lingpan (`public/logo.png`). */
export function BrandMark({ className, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      src="/logo.png"
      alt="Logo"
      width={36}
      height={36}
      className={cn('size-9 rounded-[11px] object-cover', className)}
      {...props}
    />
  )
}

export function Logo({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <BrandMark />
      {!compact && (
        <span className="leading-none">
          <span className="block text-[17px] font-bold tracking-tight text-foreground">至简海漫</span>
          <span className="mt-0.5 block text-[10px] font-semibold tracking-[0.2em] text-primary">HAIMAN</span>
        </span>
      )}
    </span>
  )
}
