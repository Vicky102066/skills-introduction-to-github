# 钱搭子 · 支付宝 AI 网页应用收款服务端

把"充值钻石"从模拟支付改成真实的支付宝网页收款（AI 网页应用收款，`alipay.trade.page.pay`）。

## 目录

```
server/
├── index.js          # Express 服务：下单 / 回跳 / 异步通知 / 查单 / 订单状态
├── config.js         # 沙箱/生产配置（密钥只从环境变量读）
├── store.js          # 订单与通知事件仓储（演示用 JSON，生产换数据库）
├── package.json
├── .env.example      # 配置模板
└── public/           # 把前端单文件放这里，同源访问避免跨域
```

## 已实现的接口（网页收款必备）

| 接口 | 作用 |
|---|---|
| `POST /api/pay/create` | 创建订单 + `pageExec` 生成支付表单（后端定价，前端无法篡改金额） |
| `POST /alipay/notify` | 异步通知：验签 + 订单/金额校验 + 幂等 + `success`/`fail` 应答 |
| `GET  /return` | 同步回跳结果页：展示"确认中"，前端再查单，**不信任同步参数** |
| `GET  /api/order/:no` | 订单状态查询（未配 notify_url 时的主动查单兜底） |
| `GET  /api/health` | 健康检查 |

服务端用 `alipay.trade.query` 主动查单的能力已在依赖中就绪；如需在 notify 之外增加"补偿查单"定时任务，可基于 `/api/order/:no` 扩展。

## 关键防坑点（已按官方文档处理）

- Node.js SDK 用 `pageExec()` 下单，**不用** `exec()`（否则拿不到支付表单）
- 私钥为 PKCS#1（`appPrivatePkcsKey`），原始字符串不加 PEM 头尾
- 验签用当前版本实际存在的 `checkNotifySign`（v3.6.2 无 `checkNotifySignV2`）
- `setup-env.js` 兼容控制台的 `AIPAY_` / `ALIPAY_` 两种前缀，并自动选对「非JAVA私钥」和「沙箱支付宝公钥」
- 订单数据写在 `data-v2/`（避开某些 Windows 环境下旧 data 目录被锁的 EPERM 问题）
- 时间戳 `yyyy-MM-dd HH:mm:ss`（SDK 内部已处理，业务未用 ISO 格式）
- 金额用"元"两位小数字符串，不用浮点比较
- 异步通知用 urlencoded 解析，不用 JSON parser
- SDK 引入用 `require('alipay-sdk').default`（v3.6.2 实测）

## 启动步骤（推荐用一键配置）

1. 安装依赖：`npm install`
2. **一键配置密钥**（最省事）：
   - 在支付宝控制台「技术集成 → 配置沙箱密钥」把三行密钥整段复制，存成 `keys.txt`（放在本目录）
   - 运行：`node setup-env.js keys.txt`
   - 脚本会自动提取 APP_ID / 公钥 / 私钥，并**自动把 JAVA 的 PKCS#8 私钥转成 Node.js 需要的 PKCS#1**，生成 `.env`
   - 用完可删除 `keys.txt`（含私钥，请勿外传）
3. 把前端单文件复制到 `public/`：`cp ../钱搭子-单文件版.html public/index.html`
4. 启动：`npm start`，访问 `http://localhost:3000`
5. 健康检查：`curl http://localhost:3000/api/health`，`sdkReady:true` 即配置成功

> 也可以手动：复制 `.env.example` 为 `.env` 自己填。若控制台只给 JAVA(PKCS#8) 私钥，用上面的脚本转换，或点控制台里 Non-Java / PKCS#1 那行复制。

## 沙箱 → 生产

- 改 `ALIPAY_ENV=production`，并把 AppID、私钥、支付宝公钥换成**同一套生产应用**的
- 生产私钥格式仍为 PKCS#1（Node.js）
- 配置公网 `ALIPAY_NOTIFY_URL`，并在支付宝控制台开通"AI 网页应用收款"产品、完成签约
- `return_url` 改为你实际部署的域名

## 本地联调（无真实密钥也能验证链路）

已用测试密钥验证过以下链路（下单→支付表单→通知验签→查单），你可以复现：

```bash
# 1. 生成测试 RSA 密钥（PKCS#1 私钥）
openssl genrsa -traditional -out app_private.pem 2048
openssl rsa -in app_private.pem -pubout -out app_public.pem

# 2. 读成单行（去掉 PEM 头尾）作为环境变量
ALIPAY_APP_ID=2026000000000000 \
ALIPAY_PRIVATE_KEY="$(tr -d '\n' < app_private.pem | sed 's/-----[^-]*-----//g')" \
ALIPAY_PUBLIC_KEY="$(tr -d '\n' < app_public.pem | sed 's/-----[^-]*-----//g')" \
PORT=3000 node index.js

# 3. 下单（返回 paymentHtml 即成功，action 指向沙箱网关）
curl -s -X POST http://localhost:3000/api/pay/create \
  -H "Content-Type: application/json" -d '{"amount":6}'
```

**真实沙箱付款**仍需：在 aipay.alipay.com 开通产品 → 拿沙箱 AppID/密钥 → 填环境变量 → 用沙箱买家账号在收银台付款。

## 安全提醒

- 私钥绝不写进前端代码、不进日志、不提交版本库
- 本 demo 的订单/幂等用 JSON 文件，**生产必须换数据库 + 事务**
- 钻石发放目前只标记订单 PAID；生产需在 `markPaid` 处绑定用户账户并发放权益（TODO 已标注）
