/**
 * 海漫剧本商城 · 后端服务（零依赖 Node.js）
 * - REST API（/api/*）：注册登录、剧本管理、标签、定价、订单、文件上传下载
 * - JSON 文件存储（data/db.json）+ 文件存储（data/files/）
 * - 托管 Vite 构建出的前端（../web）
 * 启动：PORT=3000 node server/server.js
 */
import http from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 3000)
const HOST = '0.0.0.0'
const WEB_DIR = path.resolve(__dirname, '../web')
const DATA_DIR = path.join(__dirname, 'data')
const FILES_DIR = path.join(DATA_DIR, 'files')
const DB_FILE = path.join(DATA_DIR, 'db.json')
const MAX_JSON = 80 * 1024 * 1024 // 封面 base64 可能较大
const MAX_FILE = 200 * 1024 * 1024

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '2286204478@qq.com'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Yu2286204478'

/* ---------- 工具 ---------- */
const nowIso = () => new Date().toISOString()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const scryptHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4',
}

/* ---------- 数据层 ---------- */
let db = null
// 原子写：先写临时文件再 rename，避免并发请求读到写了一半的 JSON
const saveDb = () => {
  const tmp = `${DB_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db))
  fs.renameSync(tmp, DB_FILE)
}

/** 每个请求都从磁盘回读最新数据：部署环境可能多实例/多进程，内存副本不能当唯一真相 */
function reloadDb() {
  try {
    const next = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    if (next && Array.isArray(next.scripts) && Array.isArray(next.orders)) db = next
  } catch { /* 读取失败时沿用当前内存副本 */ }
}

function seedDb() {
  // seed.cjs 由前端 src/lib/data.ts 经 tsc 转译生成，仅用于提供「商品目录」。
  // 订单、销量、评分、文件、调价历史一律从零开始 —— 不允许任何演示用的假交易数据进入生产库。
  const seed = require('./seed.cjs')
  const scripts = seed.seedScripts().map((s) => ({
    ...s,
    sales: 0,
    fileName: undefined,
    fileSize: undefined,
    priceHistory: [{ price: s.price, at: s.createdAt || nowIso(), note: '初始定价' }],
  }))
  const admin = {
    email: ADMIN_EMAIL, role: 'admin', createdAt: nowIso(),
    salt: crypto.randomBytes(16).toString('hex'),
  }
  admin.hash = scryptHash(ADMIN_PASSWORD, admin.salt)
  return {
    users: [admin],
    sessions: {}, // token -> {email, role, at}
    scripts, orders: [],
    tagGroups: structuredClone(seed.DEFAULT_GROUPS),
    fileIndex: {},
    orderSeq: 241000,
  }
}

function loadDb() {
  fs.mkdirSync(FILES_DIR, { recursive: true })
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return } catch { /* 损坏则重建 */ }
  }
  db = seedDb()
  saveDb()
}
loadDb()

/** 管理员账号以 ADMIN_EMAIL / ADMIN_PASSWORD 为唯一事实源：换号/改密后重启即生效，旧管理员一并清理 */
;(function ensureAdmin() {
  db.users = db.users.filter((u) => !(u.role === 'admin' && u.email !== ADMIN_EMAIL))
  const cur = db.users.find((u) => u.email === ADMIN_EMAIL)
  if (cur && cur.role === 'admin' && scryptHash(ADMIN_PASSWORD, cur.salt) === cur.hash) return
  const salt = crypto.randomBytes(16).toString('hex')
  if (cur) {
    cur.role = 'admin'
    cur.salt = salt
    cur.hash = scryptHash(ADMIN_PASSWORD, salt)
  } else {
    db.users.push({ email: ADMIN_EMAIL, role: 'admin', createdAt: nowIso(), salt, hash: scryptHash(ADMIN_PASSWORD, salt) })
  }
  saveDb()
})()

/* ---------- 鉴权 ---------- */
// 无状态签名令牌：不依赖进程内存或共享文件，多实例部署下登录态依然有效
const SESSION_SECRET = process.env.SESSION_SECRET || 'haiman-script-mall-session-secret-v1'
function makeToken(email, role) {
  const payload = Buffer.from(JSON.stringify({ e: email, r: role, t: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  return payload + '.' + sig
}
function parseToken(t) {
  const [p, s] = String(t || '').split('.')
  if (!p || !s) return null
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url')
  if (s.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null
  try {
    const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
    return j.e ? { email: j.e, role: j.r } : null
  } catch { return null }
}
function sessionOf(req) {
  // 注意：托管平台的边缘网关会注入自己的 Authorization 头，不能信任它。
  // 优先读自定义头，其次 URL 参数；Authorization 仅作为本地直连时的兜底。
  const custom = req.headers['x-haiman-token']
  const queryToken = new URL(req.url, 'http://x').searchParams.get('token')
  const h = req.headers['authorization'] || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  const t = (Array.isArray(custom) ? custom[0] : custom) || queryToken || m?.[1]
  if (!t) return null
  const signed = parseToken(t)
  if (signed) return { token: t, ...signed }
  // 兼容旧版本存于 db.sessions 的令牌
  return db.sessions?.[t] ? { token: t, ...db.sessions[t] } : null
}
const userOf = (s) => s ? db.users.find((u) => u.email === s.email) || null : null
const isAdmin = (s) => s?.role === 'admin' || userOf(s)?.role === 'admin'

/* ---------- 业务辅助 ---------- */
const scriptById = (id) => db.scripts.find((s) => s.id === id)
const buyoutSold = (s) => !!s && s.saleType === 'buyout' && db.orders.some((o) => o.scriptId === s.id && o.saleType === 'buyout' && o.status === 'paid')

/** 对外输出的剧本：附上买断是否已售标记 */
const pubScript = (s) => ({ ...s, buyoutSold: buyoutSold(s) })
const visibleScripts = () => db.scripts.filter((s) => s.status === 'on' || s.status === 'off').map(pubScript)

const filePathOf = (id) => {
  const meta = db.fileIndex?.[id]
  return meta ? path.join(FILES_DIR, meta.stored) : null
}
function registerFile(id, name, buf) {
  db.fileIndex ??= {}
  const stored = id + '.bin'
  fs.writeFileSync(path.join(FILES_DIR, stored), buf)
  db.fileIndex[id] = { stored, name, size: buf.length }
}
function dropFile(id) {
  if (db.fileIndex?.[id]) {
    try { fs.unlinkSync(path.join(FILES_DIR, db.fileIndex[id].stored)) } catch {}
    delete db.fileIndex[id]
  }
}
function syncScriptFileMeta(s) {
  const meta = db.fileIndex?.[s.id]
  s.fileName = meta?.name
  s.fileSize = meta?.size
}

/* ---------- 响应 ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status } }
function send(res, status, data, headers = {}) {
  const body = data === null ? '' : typeof data === 'string' ? data : JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 平台边缘网关可能缓存 GET /api/*，一旦缓存，登录态与后台改动都会读到旧响应
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
    ...headers,
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_JSON) return reject(new HttpError(413, '请求体过大')); chunks.push(c) })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new HttpError(400, 'JSON 解析失败')) }
    })
    req.on('error', () => reject(new HttpError(400, '读取请求失败')))
  })
}
function readRaw(req, limit = MAX_FILE) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) return reject(new HttpError(413, '文件过大')); chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => reject(new HttpError(400, '读取文件失败')))
  })
}

/* ---------- 标签辅助（与前端 getVals/setVals 一致） */
function getVals(s, gid) {
  if (gid === 'plot') return s.tags
  if (gid === 'market') return s.markets
  if (gid === 'quality') return s.quality ? [s.quality] : []
  return s.extra?.[gid] ?? []
}
function setVals(s, gid, v) {
  if (gid === 'plot') s.tags = v
  else if (gid === 'market') s.markets = v
  else if (gid === 'quality') s.quality = v[0] ?? ''
  else s.extra = { ...(s.extra ?? {}), [gid]: v }
  return s
}

/* ---------- ZPay（易支付协议）支付网关 ---------- */
const ZPAY_PID = process.env.ZPAY_PID || '2026032608161428'
const ZPAY_KEY = process.env.ZPAY_KEY || 'tPMOy54JqOvUn9Rkrpbo0R558huw9SrA'
const ZPAY_GATEWAY = (process.env.ZPAY_GATEWAY || 'https://zpayz.cn').replace(/\/+$/, '')
// 对外可达的站点地址。平台转发时会把 Host 改成内部沙箱域名，
// 所以线上统一回落到公开分享域名；仅本地预览使用请求自身的 host。
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '')
const FALLBACK_PUBLIC_ORIGIN = 'https://e245aa0004884604adaa43cff8b735b2.app.workbuddy.host'
let currentShareCode = process.env.PUBLIC_SHARECODE || 'CWMMREHP2W'
let currentOrigin = ''
function originFrom(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) return ''
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return `${proto}://${host}`
  return PUBLIC_ORIGIN || FALLBACK_PUBLIC_ORIGIN
}
function publicBase() {
  return currentOrigin || PUBLIC_ORIGIN || FALLBACK_PUBLIC_ORIGIN
}
function extUrl(p) {
  const base = publicBase()
  // 只有平台托管域名需要 sharecode；本地回调地址保持干净，不带任何参数
  return /app\.workbuddy\.host/i.test(base) ? `${base}${p}?sharecode=${currentShareCode}` : `${base}${p}`
}
function siteRoot() {
  const base = publicBase()
  return /app\.workbuddy\.host/i.test(base) ? `${base}/?sharecode=${currentShareCode}` : `${base}/`
}

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')

/** 易支付 MD5 签名：按参数名 ASCII 升序拼接 a=b&c=d，排除 sign/sign_type/空值，末尾拼商户密钥 */
function zpaySign(params) {
  const qs = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return md5(qs + ZPAY_KEY)
}

/** 生成页面跳转支付链接（收银台）。金额单位：元，与剧本价格数值一致 */
function buildPayUrl(order) {
  const s = scriptById(order.scriptId)
  const p = {
    pid: ZPAY_PID,
    type: order.payChannel,
    out_trade_no: order.id,
    notify_url: extUrl('/api/pay/notify'),
    return_url: extUrl('/pay/return'),
    name: `海漫剧本《${order.scriptTitle}》${order.saleType === 'buyout' ? '买断' : '批发试用'} ${s?.totalEpisodes ?? ''}集`,
    money: order.paid.toFixed(2),
  }
  const sign = zpaySign(p)
  const qs = new URLSearchParams({ ...p, sign, sign_type: 'MD5' }).toString()
  return `${ZPAY_GATEWAY}/submit.php?${qs}`
}

/**
 * API 支付（mapi.php）：直接向网关换取支付宝二维码，前端在当前弹窗内展示，
 * 不再跳转新页面（新窗口容易被浏览器/权限拦截导致用户卡死）。
 * 返回 { img, qrcode, payurl }；网关异常返回 null，前端回退到收银台链接。
 * 实测响应是把 JSON 包了一层字符串，需要二次解析。
 */
async function zpayCreateSession(order) {
  const s = scriptById(order.scriptId)
  const p = {
    pid: ZPAY_PID,
    type: 'alipay',
    out_trade_no: order.id,
    notify_url: extUrl('/api/pay/notify'),
    return_url: extUrl('/pay/return'),
    name: `海漫剧本《${order.scriptTitle}》${order.saleType === 'buyout' ? '买断' : '批发试用'} ${s?.totalEpisodes ?? ''}集`,
    money: order.paid.toFixed(2),
  }
  const sign = zpaySign(p)
  const body = new URLSearchParams({ ...p, sign, sign_type: 'MD5' }).toString()
  const r = await fetch(`${ZPAY_GATEWAY}/mapi.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch { j = null }
  if (typeof j === 'string') {
    try { j = JSON.parse(j) } catch { j = null }
  }
  if (!j || j.code !== 1) return null
  return { img: String(j.img || ''), qrcode: String(j.qrcode || j.payurl || ''), payurl: String(j.payurl || '') }
}

/** 查询单个订单（GET api.php?act=order）。返回解析后的 JSON，网络/解析失败抛错 */
async function zpayQuery(outTradeNo) {
  const u = `${ZPAY_GATEWAY}/api.php?act=order&pid=${encodeURIComponent(ZPAY_PID)}&key=${encodeURIComponent(ZPAY_KEY)}&out_trade_no=${encodeURIComponent(outTradeNo)}`
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => null)
  if (!j || typeof j.code === 'undefined') throw new Error('查单响应异常')
  return j
}

/** 提交网关退款 */
async function zpayRefund(order) {
  const body = new URLSearchParams({ pid: ZPAY_PID, key: ZPAY_KEY, out_trade_no: order.id, money: order.paid.toFixed(2) })
  const r = await fetch(`${ZPAY_GATEWAY}/api.php?act=refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  })
  return await r.json().catch(() => ({ code: -1, msg: '退款响应异常' }))
}

/** 订单标记已支付（幂等）：pending → paid，销量 +1 */
function markPaid(o, info = {}) {
  // 轮询是异步的，期间可能有请求触发 reloadDb；按 id 重新取当前 db 里的对象再改
  o = db.orders.find((x) => x.id === o.id) || o
  if (o.status !== 'pending') return false
  // 买断剧本被别人先支付：本单关闭并尝试原路退款
  const s = scriptById(o.scriptId)
  if (s && s.saleType === 'buyout') {
    const first = db.orders.find((x) => x.id !== o.id && x.scriptId === o.scriptId && x.saleType === 'buyout' && x.status === 'paid')
    if (first) {
      o.status = 'closed'; o.closedNote = '买断剧本已被他人购买，订单自动关闭'
      saveDb()
      zpayRefund(o).catch(() => undefined) // 尽力退款
      return false
    }
  }
  o.status = 'paid'
  o.tradeNo = info.trade_no || o.tradeNo
  o.buyerAccount = info.buyer || o.buyerAccount
  o.paidAt = nowIso()
  if (s) s.sales = (s.sales || 0) + 1
  saveDb()
  console.log(`[pay] 订单 ${o.id} 已支付（${o.tradeNo || '网关'}）`)
  return true
}

/** 保底轮询：即使 notify 回调被网络/网关拦截，也能通过主动查单把支付状态补回来 */
let pollingBusy = false
async function pollPendingOrders() {
  if (pollingBusy) return
  pollingBusy = true
  try {
    const pend = db.orders.filter((o) => o.status === 'pending' && Date.now() - +new Date(o.createdAt) < 48 * 3600e3)
    for (const o of pend) {
      try {
        const j = await zpayQuery(o.id)
        if (Number(j.code) === 1 && Number(j.status) === 1) markPaid(o, j)
      } catch { /* 网络失败，下一轮再试 */ }
    }
  } finally {
    pollingBusy = false
  }
}
setInterval(pollPendingOrders, 30_000).unref?.()

/** /pay/status 实时查单限频表（订单号 → 上次查询时间） */
const lastLiveQuery = new Map()

/* ---------- 路由 ---------- */
async function api(req, res, pathname, query) {
  reloadDb() // 多实例部署：每个请求都读磁盘最新状态，写入才能被其它实例看到
  // 回调地址跟随当前站点：本地用 localhost，线上用公开分享域名（含访问参数）
  const origin = originFrom(req)
  if (origin) currentOrigin = origin
  const sc = query.get('sharecode')
  if (sc) currentShareCode = sc
  const sess = sessionOf(req)
  const me = userOf(sess)
  const method = req.method
  const seg = pathname.split('/').filter(Boolean) // ['scripts', 's1', ...]
  const R = (x) => [x]

  const needAuth = () => { if (!sess) throw new HttpError(401, '请先登录') ; return sess }
  const needAdmin = () => { if (!sess) throw new HttpError(401, '请先登录'); if (!isAdmin(sess)) throw new HttpError(403, '需要管理员权限') ; return sess }

  /* ===== 认证 ===== */
  if (pathname === '/auth/register' && method === 'POST') {
    const { email, password } = await readJson(req)
    const mail = String(email || '').trim().toLowerCase()
    if (!EMAIL_RE.test(mail)) throw new HttpError(400, '请输入有效的邮箱地址')
    if (!password || String(password).length < 6) throw new HttpError(400, '密码至少 6 位')
    if (db.users.some((u) => u.email === mail)) throw new HttpError(409, '该邮箱已注册，请直接登录')
    const u = { email: mail, role: 'buyer', salt: crypto.randomBytes(16).toString('hex'), createdAt: nowIso() }
    u.hash = scryptHash(password, u.salt)
    db.users.push(u)
    const t = makeToken(mail, 'buyer')
    db.sessions[t] = { email: mail, role: 'buyer', at: nowIso() }
    saveDb()
    return R(send(res, 200, { token: t, user: { email: mail, role: 'buyer' } }))
  }
  if (pathname === '/auth/login' && method === 'POST') {
    const { email, password } = await readJson(req)
    const mail = String(email || '').trim().toLowerCase()
    const u = db.users.find((x) => x.email === mail)
    if (!u) throw new HttpError(404, '该邮箱尚未注册')
    if (scryptHash(String(password ?? ''), u.salt) !== u.hash) throw new HttpError(401, '密码不正确')
    const t = makeToken(mail, u.role)
    db.sessions[t] = { email: mail, role: u.role, at: nowIso() }
    saveDb()
    return R(send(res, 200, { token: t, user: { email: mail, role: u.role } }))
  }
  if (pathname === '/auth/logout' && method === 'POST') {
    if (sess) { delete db.sessions[sess.token]; saveDb() }
    return R(send(res, 200, { ok: true }))
  }
  if (pathname === '/auth/me' && method === 'GET') {
    if (!sess) return R(send(res, 200, { user: null }))
    return R(send(res, 200, { user: { email: sess.email, role: userOf(sess)?.role ?? sess.role } }))
  }

  /* ===== 公共数据 ===== */
  if (pathname === '/bootstrap' && method === 'GET') {
    return R(send(res, 200, { scripts: visibleScripts(), tagGroups: db.tagGroups }))
  }
  if (seg[0] === 'scripts' && seg.length === 1 && method === 'GET') {
    return R(send(res, 200, { scripts: visibleScripts() }))
  }
  if (seg[0] === 'scripts' && seg.length === 2 && method === 'GET') {
    const s = scriptById(seg[1])
    if (!s || s.status === 'draft') throw new HttpError(404, '剧本不存在或未上架')
    return R(send(res, 200, { script: pubScript(s) }))
  }

  /* ===== 我的订单 ===== */
  if (pathname === '/orders' && method === 'GET') {
    needAuth()
    const orders = db.orders.filter((o) => o.account === sess.email).map((o) => ({ ...o, mine: true }))
    return R(send(res, 200, { orders }))
  }
  if (pathname === '/orders' && method === 'POST') {
    needAuth()
    const body = await readJson(req)
    const s = scriptById(body.scriptId)
    if (!s || s.status !== 'on') throw new HttpError(400, '剧本不存在或已下架')
    if (buyoutSold(s)) throw new HttpError(409, '该剧本已被买断，无法再次购买')
    // 真实收款场景：没有可交付的剧本文件就不允许下单，避免付款后无货可交
    const fp = filePathOf(s.id)
    if (!fp || !fs.existsSync(fp)) throw new HttpError(400, '该剧本尚未上传完整剧本文件，暂时无法购买，请联系客服')
    if (!String(body.buyer || '').trim()) throw new HttpError(400, '请填写联系人')
    if (!EMAIL_RE.test(String(body.email || ''))) throw new HttpError(400, '请填写有效邮箱')
    // 仅支持支付宝（微信支付已下线）
    const channel = 'alipay'
    // 网关按「元、最多两位小数」收款，必须与后台设置的售价完全一致，不能四舍五入成整数
    const price = Math.round(Number(s.price || 0) * 100) / 100
    // 同一买家对同一剧本存在未支付订单时直接复用（避免重复占用订单号）
    let order = db.orders.find(
      (o) => o.status === 'pending' && o.scriptId === s.id && o.account === sess.email,
    )
    if (!order) {
      order = {
        id: 'HM' + (++db.orderSeq),
        scriptId: s.id, scriptTitle: s.title, cover: s.cover, saleType: s.saleType,
        account: sess.email,
        original: price, paid: price, discounts: [],
        buyer: String(body.buyer).trim(), company: String(body.company || '').trim(),
        email: String(body.email).trim(), country: body.country,
        payChannel: channel,
        payMethod: '支付宝',
        createdAt: nowIso(), status: 'pending', mine: true,
      }
      db.orders.unshift(order)
    } else {
      order.buyer = String(body.buyer).trim()
      order.company = String(body.company || '').trim()
      order.email = String(body.email).trim()
      order.payChannel = channel
      order.payMethod = '支付宝'
    }
    saveDb()
    // 创建订单后直接向网关换取支付二维码；失败回退收银台链接
    const qr = await zpayCreateSession(order).catch(() => null)
    return R(send(res, 200, { order: { ...order, script: pubScript(s) }, payUrl: buildPayUrl(order), qr }))
  }
  // 继续支付：为已有待支付订单重新生成收银台链接
  if (seg[0] === 'orders' && seg.length === 3 && seg[2] === 'pay' && method === 'POST') {
    needAuth()
    const o = db.orders.find((x) => x.id === seg[1])
    if (!o || o.account !== sess.email) throw new HttpError(404, '订单不存在')
    if (o.status !== 'pending') throw new HttpError(400, '该订单当前状态不可支付')
    const fp = filePathOf(o.scriptId)
    if (!fp || !fs.existsSync(fp)) throw new HttpError(400, '剧本文件尚未上传或已移除，暂时无法支付')
    const qr = await zpayCreateSession(o).catch(() => null)
    return R(send(res, 200, { payUrl: buildPayUrl(o), qr }))
  }
  // 支付状态查询：前端轮询用；待支付时顺带向网关实时查单（限频 2 秒）
  if (pathname === '/pay/status' && method === 'GET') {
    needAuth()
    const out = query.get('out_trade_no')
    const o = db.orders.find((x) => x.id === out)
    if (!o || (o.account !== sess.email && !isAdmin(sess))) throw new HttpError(404, '订单不存在')
    if (o.status === 'pending') {
      const last = lastLiveQuery.get(o.id) || 0
      if (Date.now() - last > 2000) {
        lastLiveQuery.set(o.id, Date.now())
        try {
          const j = await zpayQuery(o.id)
          if (Number(j.code) === 1 && Number(j.status) === 1) markPaid(o, j)
        } catch { /* 查单失败不影响返回本地状态 */ }
      }
    }
    return R(send(res, 200, { order: { ...o } }))
  }
  // 异步通知：网关服务端 GET 回调，验签 + 校验金额后标记支付，需应答纯文本 success
  if (pathname === '/pay/notify' && method === 'GET') {
    // 只取网关协议字段参与验签：平台边缘网关附加的 sharecode 等参数不在网关签名里，
    // 若一并参与会导致真实回调永远验签失败。
    const all = {}
    for (const [k, v] of query.entries()) all[k] = v
    const p = {}
    for (const k of ['pid', 'name', 'money', 'out_trade_no', 'trade_no', 'param', 'trade_status', 'type', 'sign', 'sign_type']) {
      if (all[k] !== undefined) p[k] = all[k]
    }
    const fail = (msg) => { console.warn(`[notify] 拒绝: ${msg}`); res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' }); return R(res.end('fail')) }
    if (!p.sign || p.sign !== zpaySign(p)) return fail('签名校验失败')
    if (p.pid !== ZPAY_PID) return fail('商户号不匹配')
    if (p.trade_status !== 'TRADE_SUCCESS') return R((res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' }), res.end('success')))
    const o = db.orders.find((x) => x.id === p.out_trade_no)
    if (!o) return fail('订单不存在')
    if (Math.round(Number(p.money) * 100) !== Math.round(o.paid * 100)) return fail('金额不一致')
    markPaid(o, p)
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' })
    return R(res.end('success'))
  }

  /* ===== 剧本文件下载（需登录 + 已购或管理员） ===== */
  if (seg[0] === 'scripts' && seg[2] === 'file' && method === 'GET') {
    needAuth()
    const s = scriptById(seg[1])
    if (!s) throw new HttpError(404, '剧本不存在')
    const bought = db.orders.some((o) => o.scriptId === s.id && o.account === sess.email && o.status === 'paid')
    if (!bought && !isAdmin(sess)) throw new HttpError(403, '购买后才能下载完整剧本')
    const fp = filePathOf(s.id)
    if (!fp || !fs.existsSync(fp)) throw new HttpError(404, 'NO_FILE')
    const name = encodeURIComponent(db.fileIndex[s.id].name)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(db.fileIndex[s.id].name)] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      'Content-Length': fs.statSync(fp).size,
      'Cache-Control': 'no-store, private',
    })
    fs.createReadStream(fp).pipe(res)
    return R(null)
  }

  /* ===== 以下为管理端接口 ===== */
  if (pathname === '/admin/all' && method === 'GET') {
    needAdmin()
    return R(send(res, 200, { scripts: db.scripts.map(pubScript), orders: db.orders, tagGroups: db.tagGroups }))
  }
  if (seg[0] === 'admin' && seg[1] === 'scripts') {
    needAdmin()
    // 新建 / 整体保存
    if (seg.length === 2 && method === 'POST') {
      const body = await readJson(req)
      const s = body.script ?? body
      if (!s || !s.id || !s.title) throw new HttpError(400, '剧本数据不完整')
      if (db.scripts.some((x) => x.id === s.id)) throw new HttpError(409, '剧本 ID 已存在')
      const clean = { ...s, createdAt: s.createdAt || nowIso() }
      db.scripts.unshift(clean); syncScriptFileMeta(clean)
      saveDb()
      return R(send(res, 200, { script: pubScript(clean) }))
    }
    if (seg.length === 3 && method === 'PUT') {
      // 幂等 upsert：存在则更新，不存在则创建。前端无需判断「新建还是编辑」，
      // 避免草稿剧本在列表里不可见时被误判成新建而返回 409。
      const body = (await readJson(req)).script ?? {}
      let s = scriptById(seg[2])
      if (!s) {
        if (!body.title) throw new HttpError(400, '剧本数据不完整')
        s = { ...body, id: seg[2], createdAt: body.createdAt || nowIso() }
        db.scripts.unshift(s)
      } else {
        Object.assign(s, body, { id: s.id })
      }
      syncScriptFileMeta(s)
      saveDb()
      return R(send(res, 200, { script: pubScript(s) }))
    }
    if (seg.length === 3 && method === 'PATCH') {
      const s = scriptById(seg[2]); if (!s) throw new HttpError(404, '剧本不存在')
      const body = await readJson(req)
      Object.assign(s, body, { id: s.id }); syncScriptFileMeta(s)
      saveDb()
      return R(send(res, 200, { script: pubScript(s) }))
    }
    if (seg.length === 3 && method === 'DELETE') {
      const i = db.scripts.findIndex((x) => x.id === seg[2])
      if (i < 0) throw new HttpError(404, '剧本不存在')
      db.scripts.splice(i, 1); dropFile(seg[2]); saveDb()
      return R(send(res, 200, { ok: true }))
    }
    // 上传剧本文件（raw body，文件名放 query 或 header）
    if (seg[3] === 'file' && method === 'POST') {
      const s = scriptById(seg[2]); if (!s) throw new HttpError(404, '剧本不存在')
      // URLSearchParams.get 已解码一次，不要再 decodeURIComponent（文件名含 % 会出错）
      const fromQuery = query.get('filename')
      const fromHeader = req.headers['x-filename']
      let name = fromQuery || ''
      if (!name && fromHeader) {
        try { name = decodeURIComponent(String(fromHeader)) } catch { name = String(fromHeader) }
      }
      name = name.split(/[\\/]/).pop() || `${s.title}.docx`
      const buf = await readRaw(req)
      if (!buf.length) throw new HttpError(400, '文件内容为空')
      registerFile(s.id, name, buf); syncScriptFileMeta(s); saveDb()
      return R(send(res, 200, { script: pubScript(s), fileName: s.fileName, fileSize: s.fileSize }))
    }
    if (seg[3] === 'file' && method === 'DELETE') {
      const s = scriptById(seg[2]); if (!s) throw new HttpError(404, '剧本不存在')
      dropFile(s.id); syncScriptFileMeta(s); saveDb()
      return R(send(res, 200, { ok: true, script: pubScript(s) }))
    }
  }
  if (pathname === '/admin/pricing' && method === 'POST') {
    needAdmin()
    const { changes, note } = await readJson(req)
    const at = nowIso(); const updated = []
    for (const c of changes || []) {
      const s = scriptById(c.id); if (!s || c.price === s.price) continue
      s.price = Math.round(Number(c.price || 0) * 100) / 100
      s.priceHistory = [...(s.priceHistory || []), { price: s.price, at, note: note || '调价' }]
      updated.push(pubScript(s))
    }
    saveDb()
    return R(send(res, 200, { scripts: updated }))
  }
  if (seg[0] === 'admin' && seg[1] === 'orders') {
    needAdmin()
    if (seg.length === 2 && method === 'GET') return R(send(res, 200, { orders: db.orders }))
    if (seg.length === 3 && seg[3] === 'refund' && method === 'POST') { /* 占位防误路由 */ }
    if (seg.length === 4 && seg[3] === 'refund' && method === 'POST') {
      const o = db.orders.find((x) => x.id === seg[2]); if (!o) throw new HttpError(404, '订单不存在')
      if (o.status === 'refunded') return R(send(res, 200, { order: o }))
      if (o.status !== 'paid') throw new HttpError(400, '只有已支付订单可以退款')
      // 经网关支付的订单先走网关退款（大多数通道要求金额与原订单一致）
      if (o.payChannel && o.status === 'paid') {
        const j = await zpayRefund(o).catch((e) => ({ code: -1, msg: e.message }))
        if (Number(j.code) !== 1) throw new HttpError(400, `网关退款失败：${j.msg || '未知错误'}`)
        o.refundAt = nowIso()
      }
      o.status = 'refunded'; saveDb()
      return R(send(res, 200, { order: o }))
    }
  }
  /* 标签分组管理 */
  if (seg[0] === 'admin' && seg[1] === 'groups') {
    needAdmin()
    if (seg.length === 2 && method === 'POST') { // 新建分组（saveGroup 传入的可能是新组）
      const body = (await readJson(req)).group ?? {}
      if (!body.name?.trim()) throw new HttpError(400, '请填写分组名称')
      const grp = { id: body.id || crypto.randomBytes(4).toString('hex'), name: body.name.trim(), mode: body.mode === 'single' ? 'single' : 'multi', system: false, desc: body.desc, tags: body.tags ?? [] }
      db.tagGroups.push(grp); saveDb()
      return R(send(res, 200, { group: grp }))
    }
    if (seg.length === 3 && (method === 'PUT' || method === 'PATCH')) { // saveGroup：新建或更新
      const body = await readJson(req)
      const g = body.group ?? body
      let grp = db.tagGroups.find((x) => x.id === seg[2] || x.id === g.id)
      if (!grp) {
        if (!g.name?.trim()) throw new HttpError(400, '请填写分组名称')
        grp = { id: g.id || seg[2] || crypto.randomBytes(4).toString('hex'), name: '', mode: 'multi', tags: [] }
        db.tagGroups.push(grp)
      }
      Object.assign(grp, { name: g.name?.trim() || grp.name, mode: g.mode || grp.mode, desc: g.desc, tags: g.tags ?? grp.tags })
      // 删除分类时同步清理剧本上的 extra
      saveDb()
      return R(send(res, 200, { group: grp }))
    }
    if (seg.length === 3 && method === 'DELETE') {
      const gid = seg[2]
      db.tagGroups = db.tagGroups.filter((g) => g.id !== gid)
      for (const s of db.scripts) if (s.extra?.[gid]) { const { [gid]: _drop, ...rest } = s.extra; s.extra = rest }
      saveDb()
      return R(send(res, 200, { tagGroups: db.tagGroups, scripts: db.scripts.map(pubScript) }))
    }
    if (seg.length === 4 && seg[3] === 'tags' && method === 'POST') { // 添加标签
      const { name } = await readJson(req)
      const grp = db.tagGroups.find((g) => g.id === seg[2]); if (!grp) throw new HttpError(404, '分组不存在')
      if (name?.trim() && !grp.tags.includes(name.trim())) grp.tags.push(name.trim())
      saveDb()
      return R(send(res, 200, { group: grp }))
    }
    if (seg.length === 4 && seg[3] === 'tags' && method === 'PATCH') { // 重命名标签（同步剧本）
      const { from, to } = await readJson(req)
      const grp = db.tagGroups.find((g) => g.id === seg[2]); if (!grp) throw new HttpError(404, '分组不存在')
      const to2 = String(to || '').trim(); if (!to2) throw new HttpError(400, '标签名不能为空')
      grp.tags = grp.tags.map((t) => (t === from ? to2 : t))
      for (const s of db.scripts) {
        const v = getVals(s, grp.id)
        if (v.includes(from)) setVals(s, grp.id, [...new Set(v.map((t) => (t === from ? to2 : t)))])
      }
      saveDb()
      return R(send(res, 200, { group: grp, scripts: db.scripts.map(pubScript) }))
    }
    if (seg.length === 4 && seg[3] === 'tags' && method === 'DELETE') { // 删除标签（同步剧本）
      const name = query.get('name')
      const grp = db.tagGroups.find((g) => g.id === seg[2]); if (!grp) throw new HttpError(404, '分组不存在')
      grp.tags = grp.tags.filter((t) => t !== name)
      for (const s of db.scripts) {
        const v = getVals(s, grp.id)
        if (v.includes(name)) setVals(s, grp.id, v.filter((t) => t !== name))
      }
      saveDb()
      return R(send(res, 200, { group: grp, scripts: db.scripts.map(pubScript) }))
    }
    if (seg.length === 4 && seg[3] === 'tag-scripts' && method === 'POST') { // 标签关联剧本
      const { name, scriptIds } = await readJson(req)
      const grp = db.tagGroups.find((g) => g.id === seg[2]); if (!grp) throw new HttpError(404, '分组不存在')
      for (const s of db.scripts) {
        const v = getVals(s, grp.id)
        const want = scriptIds.includes(s.id)
        if (want && !v.includes(name)) setVals(s, grp.id, grp.mode === 'single' ? [name] : [...v, name])
        if (!want && v.includes(name)) setVals(s, grp.id, v.filter((t) => t !== name))
      }
      saveDb()
      return R(send(res, 200, { scripts: db.scripts.map(pubScript) }))
    }
  }
  if (pathname === '/admin/reset' && method === 'POST') {
    needAdmin()
    const users = db.users, sessions = db.sessions
    db = seedDb()
    db.users = users; db.sessions = sessions
    fs.rmSync(FILES_DIR, { recursive: true, force: true }); fs.mkdirSync(FILES_DIR, { recursive: true })
    saveDb()
    return R(send(res, 200, { scripts: db.scripts.map(pubScript), orders: db.orders, tagGroups: db.tagGroups }))
  }
  if (pathname === '/admin/stats' && method === 'GET') {
    needAdmin()
    const paid = db.orders.filter((o) => o.status === 'paid')
    return R(send(res, 200, {
      scripts: db.scripts.length, on: db.scripts.filter((s) => s.status === 'on').length,
      orders: paid.length, revenue: paid.reduce((a, o) => a + o.paid, 0), users: db.users.length,
    }))
  }

  throw new HttpError(404, '接口不存在: ' + method + ' ' + pathname)
}

/* ---------- 静态资源 ---------- */
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
  const fp = path.normalize(path.join(WEB_DIR, p))
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); return res.end() }
  fs.stat(fp, (err, st) => {
    const file = err || !st.isFile() ? path.join(WEB_DIR, 'index.html') : fp // SPA 回退
    const cache = file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache })
    fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end('Not Found') }).pipe(res)
  })
}

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const pathname = u.pathname
  if (pathname.startsWith('/api/')) {
    try {
      const r = await api(req, res, pathname.slice(4), u.searchParams)
      if (r === undefined) send(res, 404, { error: '接口不存在' })
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message })
      else { console.error(e); send(res, 500, { error: '服务器内部错误' }) }
    }
    return
  }
  if (pathname === '/healthz') { res.writeHead(200); return res.end('ok') }
  // 支付完成后的浏览器回跳：网关 GET /pay/return?out_trade_no=...&pid=...
  // 302 到带 sharecode 的 SPA 路由（# 前必须带 sharecode，否则边缘网关 403）
  if (pathname === '/pay/return') {
    const out = u.searchParams.get('out_trade_no') || ''
    // 回跳到当前站点（# 之前必须带 sharecode，否则平台边缘网关会 403）
    res.writeHead(302, { Location: `${siteRoot()}#/pay/return?out_trade_no=${encodeURIComponent(out)}` })
    return res.end()
  }
  serveStatic(req, res, pathname)
})

server.listen(PORT, HOST, () => {
  console.log(`海漫剧本商城已启动: http://${HOST}:${PORT}`)
  console.log(`管理员账号: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`)
})
