import { useEffect, useState, type FormEvent } from 'react'
import { Logo } from '@/assets/logo'
import { Button, Field, inputCls } from '@/components/ui'
import { EMAIL_RE, takeNext, useAuth } from '@/lib/auth'
import { SERVER_UNAVAILABLE } from '@/lib/api'
import { go, useStore } from '@/lib/store'

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, login, register } = useAuth()
  const { toast } = useStore()
  const isLogin = mode === 'login'
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (user) go(takeNext() ?? (user.role === 'admin' ? '/manage/scripts' : '/'))
  }, [user])
  useEffect(() => {
    setError('')
    setTouched(false)
  }, [mode])

  const emailErr = touched && !EMAIL_RE.test(email.trim()) ? '请输入有效的邮箱地址' : undefined
  const pwErr = touched && pw.length < 6 ? '密码至少 6 位' : undefined

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    setError('')
    if (!EMAIL_RE.test(email.trim()) || pw.length < 6) return
    setBusy(true)
    const err = await (isLogin ? login : register)(email, pw)
    setBusy(false)
    if (err) {
      // 502 / 断连等统一 toast，不把「请求失败（502）」塞进表单错误
      if (err === SERVER_UNAVAILABLE) {
        toast(SERVER_UNAVAILABLE, 'error')
        return
      }
      return setError(err)
    }
    toast(isLogin ? '登录成功' : '注册成功')
  }

  return (
    <div className="grid min-h-svh place-items-center bg-background px-4">
      <div className="anim-scale-in w-full max-w-[400px] rounded-xl border border-border bg-card p-8 text-card-foreground shadow-sm">
        <button type="button" onClick={() => go('/')} className="w-fit">
          <Logo />
        </button>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{isLogin ? '登录' : '注册'}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {isLogin ? '使用邮箱登录至简海漫' : '创建账号后即可浏览与购买剧本'}
        </p>
        <form onSubmit={submit} noValidate className="mt-7 space-y-4">
          <Field label="邮箱" error={emailErr || error || undefined} required>
            <input
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
            />
          </Field>
          <Field label="密码" error={pwErr} required>
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                className={inputCls}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="至少 6 位"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShow((v) => !v)}
              >
                {show ? '隐藏' : '显示'}
              </button>
            </div>
          </Field>
          <Button type="submit" className="h-10 w-full" disabled={busy}>
            {busy ? '请稍候…' : isLogin ? '登录' : '注册'}
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-muted-foreground">
          {isLogin ? (
            <>
              还没有账号？{' '}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => go('/register')}>
                注册
              </button>
            </>
          ) : (
            <>
              已有账号？{' '}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => go('/login')}>
                登录
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
