import { useEffect, useState, type FormEvent } from 'react'
import { Icon, Logo } from '../components/Icon'
import { Field, cn, inputCls } from '../components/ui'
import { EMAIL_RE, takeNext, useAuth } from '../lib/auth'
import { go, useStore } from '../lib/store'

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, login, register } = useAuth()
  const { state, toast } = useStore()
  const isLogin = mode === 'login'
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (user) go(takeNext() ?? '/')
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
    if (err) return setError(err)
    toast(isLogin ? '登录成功，欢迎回来' : '注册成功，已自动登录')
  }

  const covers = state.scripts.filter((s) => s.status === 'on').slice(0, 5)

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* 品牌面板 */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-100 via-brand-50 to-white lg:block">
        <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_80%)]" />
        <div className="absolute -top-32 -left-24 h-[420px] w-[420px] rounded-full bg-brand-200/60 blur-3xl" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <button onClick={() => go('/')} aria-label="返回首页" className="w-fit">
            <Logo />
          </button>
          <div>
            <div className="relative mb-10 flex h-[260px] items-end justify-center gap-4">
              {covers.map((s, i) => (
                <img
                  key={s.id}
                  src={s.cover}
                  alt=""
                  style={{ animationDelay: `${i * -1.2}s`, height: `${200 + (i % 3) * 22}px` }}
                  className="anim-float w-[100px] rounded-r-md rounded-l-[3px] object-cover shadow-[8px_14px_24px_-10px_rgba(15,27,45,.55)]"
                />
              ))}
              <div className="absolute inset-x-6 bottom-0 h-3.5 rounded-sm bg-gradient-to-b from-white via-brand-200 to-brand-300 shadow-[0_10px_20px_-6px_rgba(26,107,240,.35)]" />
            </div>
            <h2 className="text-[32px] leading-tight font-bold tracking-tight text-ink-900">
              把好故事，
              <br />
              放上你的片单
            </h2>
            <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-ink-500">注册后即可试读全部在售剧本，一键下单，已购内容随时在「我的订单」重新下载。</p>
          </div>
          <p className="text-xs text-ink-400">至简海漫 HAIMAN</p>
        </div>
      </aside>

      {/* 表单 */}
      <main className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center justify-between lg:justify-end">
          <button onClick={() => go('/')} className="lg:hidden" aria-label="返回首页">
            <Logo />
          </button>
          <button onClick={() => go('/')} className="group flex items-center gap-1.5 text-sm text-ink-500 transition hover:text-brand-700">
            <Icon name="arrowLeft" size={16} className="transition-transform group-hover:-translate-x-0.5" />
            返回书架
          </button>
        </div>

        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <div key={mode} className="anim-scale-in">
            <h1 className="text-[28px] font-bold tracking-tight">{isLogin ? '欢迎回来' : '创建账号'}</h1>
            <p className="mt-2 text-sm text-ink-500">{isLogin ? '登录后即可购买剧本、查看订单' : '只需邮箱和密码，10 秒完成注册'}</p>

            <form onSubmit={submit} noValidate className="mt-8 space-y-5">
              <Field label="邮箱" error={emailErr}>
                <input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className={cn(inputCls, 'h-11', emailErr && 'border-rose-300 focus:border-rose-400 focus:ring-rose-100')}
                />
              </Field>
              <Field label="密码" error={pwErr} hint={!isLogin ? '至少 6 位' : undefined}>
                <div className="relative">
                  <input
                    type={show ? 'text' : 'password'}
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder={isLogin ? '请输入密码' : '设置登录密码'}
                    className={cn(inputCls, 'h-11 pr-11', pwErr && 'border-rose-300 focus:border-rose-400 focus:ring-rose-100')}
                  />
                  <button type="button" onClick={() => setShow(!show)} className="absolute top-1/2 right-2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-ink-400 transition hover:bg-slate-100 hover:text-ink-700" aria-label={show ? '隐藏密码' : '显示密码'}>
                    <Icon name={show ? 'lock' : 'eye'} size={17} />
                  </button>
                </div>
              </Field>

              {error && (
                <p className="anim-scale-in flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-600">
                  <Icon name="info" size={15} /> {error}
                  {error.includes('尚未注册') && (
                    <button type="button" onClick={() => go('/register')} className="ml-auto font-medium underline">
                      去注册
                    </button>
                  )}
                  {error.includes('已注册') && (
                    <button type="button" onClick={() => go('/login')} className="ml-auto font-medium underline">
                      去登录
                    </button>
                  )}
                </p>
              )}

              <button
                disabled={busy}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-[15px] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(26,107,240,.8)] transition-all duration-200 hover:bg-brand-700 active:scale-[.98] disabled:opacity-70"
              >
                {busy ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    {isLogin ? '登录中' : '注册中'}
                  </>
                ) : isLogin ? (
                  '登录'
                ) : (
                  '注册并登录'
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-ink-500">
              {isLogin ? '还没有账号？' : '已有账号？'}
              <button onClick={() => go(isLogin ? '/register' : '/login')} className="ml-1 font-semibold text-brand-700 hover:underline">
                {isLogin ? '立即注册' : '去登录'}
              </button>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
