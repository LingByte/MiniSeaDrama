import { Toaster } from './components/ui'
import { AuthProvider } from './lib/auth'
import { AuthPage } from './front/Auth'
import { StoreProvider, useRoute } from './lib/store'
import { FrontLayout } from './front/FrontLayout'
import { Home } from './front/Home'
import { Detail } from './front/Detail'
import { MyOrders } from './front/MyOrders'
import { PayReturn } from './front/PayReturn'
import { AdminApp } from './admin/AdminApp'

function Router() {
  // path 形如 /pay/return?out_trade_no=HM123 —— 先拆出 query 再分段
  const raw = useRoute()
  const [path, search] = raw.split('?')
  const query = new URLSearchParams(search || '')
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'login' || parts[0] === 'register') return <AuthPage mode={parts[0]} />
  if (parts[0] === 'admin') return <AdminApp parts={parts.slice(1)} path={path} />
  let page = <Home />
  if (parts[0] === 'script' && parts[1]) page = <Detail id={parts[1]} />
  else if (parts[0] === 'orders') page = <MyOrders />
  else if (parts[0] === 'pay' && parts[1] === 'return') page = <PayReturn outTradeNo={query.get('out_trade_no') || ''} />
  return <FrontLayout path={path}>{page}</FrontLayout>
}

export default function App() {
  return (
    <StoreProvider>
      <AuthProvider>
        <Router />
        <Toaster />
      </AuthProvider>
    </StoreProvider>
  )
}
