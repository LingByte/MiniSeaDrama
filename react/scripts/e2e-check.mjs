import crypto from 'node:crypto'

const API = 'http://127.0.0.1:3000/api'
const KEY = 'tPMOy54JqOvUn9Rkrpbo0R558huw9SrA'
const PID = '2026032608161428'
const TAG = Date.now().toString(36) // 让脚本可重复运行，不与历史测试账号冲突
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')) }
}
async function req(path, { method = 'GET', token, body, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json'
  if (body !== undefined && raw) headers['Content-Type'] = 'application/octet-stream'
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) })
  const text = await r.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* 纯文本应答 */ }
  return { status: r.status, data, text }
}
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
function notifySign(p) {
  const qs = Object.keys(p).filter((k) => p[k] !== '' && k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${p[k]}`).join('&')
  return md5(qs + KEY)
}
function notifyQs(p) {
  return Object.entries(p).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')
}

console.log('\n=== 1. 服务与初始数据（应无任何假订单/假销量） ===')
let r = await fetch('http://127.0.0.1:3000/healthz')
ok('健康检查 200', r.status === 200, 'status=' + r.status)
r = await req('/bootstrap')
ok('前台剧本来自服务端', r.status === 200 && r.data.scripts.length === 8, '共 ' + r.data?.scripts?.length + ' 部（草稿不对外）')
ok('销量全部为 0（无预置假销量）', r.data.scripts.every((s) => s.sales === 0))
ok('无虚假文件名（未上传文件就不声称有）', r.data.scripts.every((s) => !s.fileName))

console.log('\n=== 2. 管理员登录 / 后台全量数据（含草稿） ===')
r = await req('/auth/login', { method: 'POST', body: { email: '2286204478@qq.com', password: 'Yu2286204478' } })
const admin = r.data?.token
ok('管理员登录', !!admin)
r = await req('/admin/all', { token: admin })
ok('后台可见 0 条订单（假订单已清除）', r.status === 200 && r.data.orders.length === 0, '实际 ' + r.data?.orders?.length)
const draftCount = r.data.scripts.filter((s) => s.status === 'draft').length
ok('后台可见草稿剧本', draftCount > 0, '草稿 ' + draftCount + ' 部')
r = await req('/admin/all')
ok('游客访问后台数据被拒', r.status === 401 || r.status === 403, 'status=' + r.status)

console.log('\n=== 3. 新建剧本 → 前台立即可见 ===')
const script = {
  id: 'e2e-new-1', title: '端到端测试剧本', enTitle: 'E2E Test Script',
  logline: '用于验证真实持久化', synopsis: '这是一部由后台真实创建的剧本。',
  cover: '', tags: ['打脸'], markets: ['北美'], audience: '女频', language: '英语',
  totalEpisodes: 10, trialCount: 1, episodes: [{ title: '第1集', text: '测试内容' }],
  price: 12.5, status: 'on', sales: 0, rating: 4.5, quality: 'B 良好',
  saleType: 'wholesale', extra: {}, createdAt: new Date().toISOString(), priceHistory: [],
}
r = await req('/admin/scripts/e2e-new-1', { method: 'PUT', token: admin, body: { script } })
ok('新建剧本（幂等 PUT）成功', r.status === 200, 'status=' + r.status + (r.data?.error ? ' ' + r.data.error : ''))
r = await req('/bootstrap')
ok('前台立刻能看到新剧本', r.data.scripts.some((s) => s.id === 'e2e-new-1'))
r = await req('/scripts/e2e-new-1')
ok('前台详情页可访问且价格正确', r.status === 200 && r.data.script.price === 12.5)

console.log('\n=== 4. 真实上传 Word 文件 → 服务端持久保存 ===')
const fileBody = Buffer.from('E2E-真实剧本文件内容-第1集', 'utf8')
r = await req('/admin/scripts/e2e-new-1/file?filename=' + encodeURIComponent('端到端剧本.docx'), { method: 'POST', token: admin, body: fileBody, raw: true })
ok('文件上传成功', r.status === 200, 'status=' + r.status)
ok('返回真实文件名', r.data?.fileName === '端到端剧本.docx', 'fileName=' + r.data?.fileName)
ok('返回真实文件大小', r.data?.fileSize === fileBody.length, 'size=' + r.data?.fileSize)
r = await req('/admin/all', { token: admin })
ok('后台列表中 fileName 已同步', r.data.scripts.find((s) => s.id === 'e2e-new-1')?.fileName === '端到端剧本.docx')

console.log('\n=== 5. 买家注册 / 下单 / 支付回调（含平台附加参数） ===')
r = await req('/auth/register', { method: 'POST', body: { email: `e2e-buyer-${TAG}@test.com`, password: 'test1234' } })
const buyer = r.data?.token
ok('买家注册', !!buyer)
r = await req('/orders', { method: 'POST', token: buyer, body: { scriptId: 's1', buyer: 'E2E买家', company: '', email: `e2e-buyer-${TAG}@test.com`, type: 'alipay' } })
ok('未上传文件的剧本禁止下单（防真实收款后无货可交）', r.status === 400, 'status=' + r.status + ' ' + (r.data?.error || ''))
r = await req('/orders', { method: 'POST', token: buyer, body: { scriptId: 'e2e-new-1', buyer: 'E2E买家', company: '', email: `e2e-buyer-${TAG}@test.com`, type: 'alipay' } })
const order = r.data?.order
ok('下单成功且为待支付', r.status === 200 && order?.status === 'pending', '单号=' + order?.id)
ok('订单金额由服务端按剧本价格生成', order?.paid === 12.5, 'paid=' + order?.paid)
ok('收银台链接签名有效', (() => {
  const u = new URL(r.data.payUrl); const p = Object.fromEntries(u.searchParams)
  const qs = Object.keys(p).filter((k) => !['sign', 'sign_type'].includes(k) && p[k] !== '').sort().map((k) => `${k}=${p[k]}`).join('&')
  return md5(qs + KEY) === p.sign
})())
ok('本地回调地址不带 sharecode', !r.data.payUrl.includes('sharecode'))

const base = {
  pid: PID, name: '海漫剧本《端到端测试剧本》批发试用 10集', money: '12.50',
  out_trade_no: order.id, trade_no: 'TN' + Date.now(), param: '',
  trade_status: 'TRADE_SUCCESS', type: 'alipay',
}
const good = { ...base, sign: notifySign(base), sign_type: 'MD5' }
// 关键：URL 里额外带上平台边缘网关会附加的 sharecode，验签必须忽略它
r = await req('/pay/notify?' + notifyQs(good) + '&sharecode=CWMMREHP2W')
ok('真实回调（带平台附加参数）验签通过并入账', r.text.trim() === 'success', '应答=' + r.text.trim())
r = await req('/pay/status?out_trade_no=' + order.id, { token: buyer })
ok('订单变为已支付', r.data?.order?.status === 'paid', 'status=' + r.data?.order?.status)
r = await req('/pay/notify?' + notifyQs(good))
ok('重复回调幂等（不应重复加销量）', r.text.trim() === 'success')
const badSign = { ...good, sign: 'deadbeefdeadbeefdeadbeefdeadbeef' }
r = await req('/pay/notify?' + notifyQs(badSign))
ok('错误签名被拒绝', r.text.trim() === 'fail')
const badMoney = { ...base, money: '0.01' }
badMoney.sign = notifySign(badMoney); badMoney.sign_type = 'MD5'
r = await req('/pay/notify?' + notifyQs(badMoney))
ok('金额篡改被拒绝', r.text.trim() === 'fail')

console.log('\n=== 6. 已购下载 / 未购拦截 / 后台真实统计 ===')
const dl = await fetch(API + '/scripts/e2e-new-1/file', { headers: { Authorization: 'Bearer ' + buyer } })
const dlText = await dl.text()
ok('已购买用户可下载真实 Word 文件', dl.status === 200 && dlText === fileBody.toString(), 'status=' + dl.status + ' 内容=' + dlText)
r = await req('/auth/register', { method: 'POST', body: { email: `e2e-stranger-${TAG}@test.com`, password: 'test1234' } })
const noBuy = await fetch(API + '/scripts/e2e-new-1/file', { headers: { Authorization: 'Bearer ' + r.data.token } })
ok('未购买用户下载被拦截 403', noBuy.status === 403, 'status=' + noBuy.status)
r = await req('/admin/all', { token: admin })
const s2 = r.data.scripts.find((s) => s.id === 'e2e-new-1')
ok('销量随真实支付 +1', s2.sales === 1, 'sales=' + s2.sales)
ok('后台订单为真实订单', r.data.orders.length === 1 && r.data.orders[0].status === 'paid', '订单数=' + r.data.orders.length)
r = await req('/admin/stats', { token: admin })
ok('后台营收由真实订单计算', r.data.revenue === 12.5 && r.data.orders === 1, 'revenue=' + r.data.revenue)

console.log('\n=== 7. 调价 / 草稿编辑 / 标签 / 删除 ===')
r = await req('/admin/pricing', { method: 'POST', token: admin, body: { changes: [{ id: 'e2e-new-1', price: 20 }], note: 'E2E 调价' } })
ok('批量调价成功', r.status === 200)
r = await req('/scripts/e2e-new-1')
ok('前台价格同步更新', r.data.script.price === 20)
ok('调价历史留痕', r.data.script.priceHistory.some((h) => h.note === 'E2E 调价'))
const draft = (await req('/admin/all', { token: admin })).data.scripts.find((s) => s.status === 'draft')
r = await req('/admin/scripts/' + draft.id, { method: 'PUT', token: admin, body: { script: { ...draft, title: draft.title + '（已编辑）' } } })
ok('草稿剧本可编辑且不再误报 409', r.status === 200, 'status=' + r.status)
r = await req('/admin/groups/plot/tags', { method: 'POST', token: admin, body: { name: 'E2E标签' } })
ok('新增标签成功', r.status === 200 && r.data.group.tags.includes('E2E标签'))
r = await req('/admin/scripts/e2e-new-1', { method: 'DELETE', token: admin })
ok('删除剧本成功', r.status === 200)
r = await req('/bootstrap')
ok('删除后前台立即不可见', !r.data.scripts.some((s) => s.id === 'e2e-new-1'))

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n')
if (fail) process.exit(1)
