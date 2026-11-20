import { Toaster } from './components/ui'
import { ThemeProvider } from './context/theme-provider'
import { AuthProvider } from './lib/auth'
import { AuthPage } from './front/Auth'
import { StoreProvider, useRoute } from './lib/store'
import { AppShell, RequireAdmin } from './components/layout/AppShell'
import { Home } from './front/Home'
import { Detail } from './front/Detail'
import { MyOrders } from './front/MyOrders'
import { PayReturn } from './front/PayReturn'
import { Scripts } from './admin/Scripts'
import { Editor } from './admin/Editor'
import { Pricing } from './admin/Pricing'
import { Tags } from './admin/Tags'
import { AdminOrders } from './admin/AdminOrders'
import { AiPage } from './admin/AiPage'
import { go } from './lib/store'
import { useEffect } from 'react'

function ManageRouter({ parts }: { parts: string[] }) {
  const key = parts.join('/')
  if (key === '' || key === 'scripts') return <Scripts />
  if (key === 'scripts/new') return <Editor />
  if (parts[0] === 'scripts' && parts[1] === 'edit') return <Editor id={parts[2]} />
  if (key === 'pricing') return <Pricing />
  if (key === 'tags') return <Tags />
  if (key === 'orders') return <AdminOrders />
  if (key === 'ai' || key.startsWith('ai/')) return <AiPage />
  return <Scripts />
}

function Router() {
  const raw = useRoute()
  const [path, search] = raw.split('?')
  const query = new URLSearchParams(search || '')
  const parts = path.split('/').filter(Boolean)

  // Legacy /admin/* → /manage/*
  useEffect(() => {
    if (parts[0] === 'admin') {
      const rest = parts.slice(1).join('/')
      go(rest ? `/manage/${rest}` : '/manage/scripts')
    }
  }, [path])

  if (parts[0] === 'login' || parts[0] === 'register') return <AuthPage mode={parts[0]} />
  if (parts[0] === 'pay' && parts[1] === 'return') {
    return (
      <AppShell path={path}>
        <PayReturn outTradeNo={query.get('out_trade_no') || ''} />
      </AppShell>
    )
  }

  if (parts[0] === 'manage' || parts[0] === 'admin') {
    return (
      <AppShell path={path.startsWith('/manage') ? path : path.replace(/^\/admin/, '/manage')}>
        <RequireAdmin>
          <ManageRouter parts={parts.slice(1)} />
        </RequireAdmin>
      </AppShell>
    )
  }

  let page = <Home />
  if (parts[0] === 'script' && parts[1]) page = <Detail id={parts[1]} />
  else if (parts[0] === 'orders') page = <MyOrders />

  return <AppShell path={path}>{page}</AppShell>
}

export default function App() {
  return (
    <ThemeProvider>
      <StoreProvider>
        <AuthProvider>
          <Router />
          <Toaster />
        </AuthProvider>
      </StoreProvider>
    </ThemeProvider>
  )
}
