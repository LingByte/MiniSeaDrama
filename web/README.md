# 海漫剧本商城（HAIMAN）· 技术交接说明

出海漫剧剧本交易站：前台浏览/试读/扫码购买，后台管理剧本、定价、订单与退款。前后端同仓，**零运行时依赖**（后端只用 Node 内置模块），单端口部署。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + Vite + TypeScript + Tailwind CSS 4，hash 路由（无路由库） |
| 后端 | Node.js ≥ 18，单文件 `server/server.js`，**无第三方依赖** |
| 数据 | JSON 文件库 `server/data/db.json` + 磁盘文件 `server/data/files/`（原子写入） |
| 支付 | ZPay（易支付协议）：MD5 签名，`mapi.php` 换取支付宝二维码，`submit.php` 收银台兜底 |
| 鉴权 | scrypt 密码哈希 + 无状态 HMAC 签名 token（`X-Haiman-Token` 头或 `?token=` 传递） |

## 目录结构

```
app/
├─ src/                # 前端源码（front/ 前台、admin/ 后台、lib/ 公共层）
├─ server/
│  ├─ server.js        # 全部后端逻辑（API + 静态托管 + 支付网关）
│  ├─ seed.cjs         # 初始剧本目录数据（由 scripts/gen-seed.mjs 生成）
│  └─ data/            # 运行数据：db.json + files/（上传的 Word 剧本）—— 需持久化
├─ web/                # 前端构建产物（vite build 输出）
├─ scripts/
│  ├─ e2e-check.mjs    # 38 项端到端回归（启动服务后跑）
│  └─ gen-seed.mjs     # 由 src/lib/data.ts 生成 server/seed.cjs
└─ vite.config.ts / tsconfig.json / package.json
```

## 本地运行

```bash
npm install
npm run build          # 构建前端到 web/
npm start              # 启动服务，默认 http://localhost:3000（读 PORT 环境变量）
```

开发模式：`npm run dev`（Vite 热更新，仅前端；接口仍需另起 `npm start`）。

## 环境变量（全部可选，有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 服务端口，**必须监听 0.0.0.0**（反代部署） |
| `ADMIN_EMAIL` | 2286204478@qq.com | 管理员账号，改后重启生效，旧管理员自动清理 |
| `ADMIN_PASSWORD` | Yu2286204478 | 管理员密码（同上） |
| `SESSION_SECRET` | 内置默认 | token 签名密钥，生产环境务必改为随机串 |
| `ZPAY_PID` / `ZPAY_KEY` | 内置商户号/密钥 | ZPay 商户配置 |
| `ZPAY_GATEWAY` | https://zpayz.cn | ZPay 网关地址 |
| `PUBLIC_ORIGIN` / `PUBLIC_SHARECODE` | WorkBuddy 托管域名 | 对外回调基址，自建域名部署时改为自己的域名 |

## 支付链路（重点）

1. 前台下单 `POST /api/orders` → 服务端计算金额、创建 `pending` 订单 → 调 ZPay `mapi.php` 拿**支付宝二维码图片**，直接在页面弹窗内展示扫码（不跳转新页面）。
2. 支付结果三重确认：前端 3 秒轮询 `GET /api/pay/status`（内部限频实时查网关）+ 网关异步回调 `GET /api/pay/notify`（验签 + 金额校验 + 幂等）+ 后端每 30 秒兜底轮询 48h 内 pending 订单，**不会丢单**。
3. 退款走后台 `POST /api/admin/orders/:id/refund`（ZPay 退款 API，需商户后台开启退款开关）。
4. 买断剧本防重复售出；未上传 Word 文件的剧本禁止下单（防止收款后无货可交）。

## 部署要求

- 单端口 HTTP 服务，绑定 `0.0.0.0`，可挂任意反向代理。
- `server/data/` 目录必须可写并持久化（数据库 + 已上传剧本文件都在这）。
- 多实例部署可用（每请求回读磁盘 + 无状态 token），但建议单实例避免文件写竞争。
- 回调地址依赖 `PUBLIC_ORIGIN`；确保网关 `notify_url` / `return_url` 可被公网访问。

## 测试

```bash
npm start              # 先起服务
npm run test:e2e       # 38 项回归：注册/登录/上架/上传/下单/回调/下载/退款数据流等
```

## 运营注意事项

- 初始 8 部目录剧本**未上传 Word 文件**，前台会显示「剧本文件准备中」并禁用下单；需在后台逐部补传并设置真实售价。
- 管理后台入口：`/#/admin`（前台顶栏无入口，为隐藏设计）。
- ZPay 商户中心需开启「退款 API」后退款功能才可用。
