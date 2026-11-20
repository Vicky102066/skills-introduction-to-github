/* 钱搭子 - 支付宝 AI 网页应用收款服务端
 * 版本标记：QIANDAZI-V2（支持 index.html 放根目录或 public/ 两种结构）
 *
 * 接口：
 *   POST /api/pay/create   { diamonds, amount, subject }  -> { outTradeNo, paymentHtml }
 *   GET  /api/order/:outTradeNo                            -> 订单状态（前端查单兜底）
 *   POST /alipay/notify                                     -> 异步通知（验签 + 幂等 + success/fail）
 *   GET  /return                                            -> 同步回跳结果页（不直接信任参数）
 *   GET  /api/health                                        -> 健康检查
 *
 * 启动：先配好环境变量，然后 node index.js
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
// alipay-sdk v3.6.x 通过 .default 导出（已按实际安装的 package.json 与运行时验证）
const AlipaySdk = require('alipay-sdk').default;
const { config, validate } = require('./config');
const store = require('./store');

const app = express();

// 异步通知是 application/x-www-form-urlencoded，必须用 urlencoded 解析（不能用 JSON parser）
app.use('/alipay/notify', express.urlencoded({ extended: false }));
app.use(express.json());

// 初始化 SDK（配置缺失时不启动真实支付，但保留只读查询接口）
const missing = validate();
let alipaySdk = null;
if (missing.length === 0) {
  alipaySdk = new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,       // Node.js = PKCS#1 (appPrivatePkcsKey)
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    signType: config.signType
  });
  console.log(`[支付宝] 环境=${config.env} 网关=${config.gateway}`);
} else {
  console.warn(`[支付宝] 配置缺失: ${missing.join(', ')}，支付下单不可用（请先配置环境变量）`);
}

// 钻石套餐（与前端 RECHARGE_TIERS 一致）：价格(元) -> 应发钻石(含赠送)
// key 用"元"字符串，避免浮点
const PACKAGES = {
  '6.00': 60,
  '15.00': 160,   // 150 + 赠送10
  '30.00': 330    // 300 + 赠送30
};

function sdkReady(res) {
  if (alipaySdk) return true;
  res.status(503).json({ ok:false, error:'服务端支付宝配置未完成' });
  return false;
}

/* ---------- 下单（页面跳转支付） ---------- */
app.post('/api/pay/create', (req, res) => {
  if (!sdkReady(res)) return;
  const { amount, subject } = req.body || {};
  // 金额与发放钻石都以后端套餐表为准，前端传的 diamond 不可信
  const amtNorm = store.normalizeAmount(amount);
  const grantDiamonds = PACKAGES[amtNorm];
  if (!grantDiamonds) {
    return res.status(400).json({ ok:false, error:'充值档位不合法' });
  }
  const order = store.createOrder({ diamonds: grantDiamonds, amount: amtNorm, subject: subject || `钱搭子 ${grantDiamonds}钻石` });

  const requestOptions = {
    method: 'POST',                      // 关键：pageExec 第二参数里的 method 指定返回 POST 表单
    returnUrl: config.returnUrl,
    bizContent: {
      out_trade_no: order.outTradeNo,
      total_amount: order.totalAmount,   // 两位小数字符串
      subject: order.subject,
      product_code: 'FAST_INSTANT_TRADE_PAY'
    }
  };
  if (config.notifyUrl) requestOptions.notifyUrl = config.notifyUrl; // 无公网地址时不传

  try {
    // ⚠️ pageExec 只有两个参数：(method, params)，POST 写在 params.method 里
    // 写成 pageExec(method,'POST',{...}) 会把 'POST' 当 params，导致 biz_content 丢失 → INVALID_PARAMETER
    const paymentHtml = alipaySdk.pageExec('alipay.trade.page.pay', requestOptions);
    res.json({ ok:true, outTradeNo: order.outTradeNo, paymentHtml });
  } catch (e) {
    console.error('[下单失败]', e && e.message);
    res.status(500).json({ ok:false, error:'下单失败，请稍后重试' });
  }
});

/* ---------- 订单状态查询（前端主动查单兜底） ---------- */
app.get('/api/order/:outTradeNo', (req, res) => {
  const order = store.findOrder(req.params.outTradeNo);
  if (!order) return res.status(404).json({ ok:false, error:'订单不存在' });
  res.json({
    ok:true,
    status: order.status,
    diamonds: order.diamonds,
    totalAmount: order.totalAmount,
    paidAt: order.paidAt
  });
});

/* ---------- 异步通知 ---------- */
app.post('/alipay/notify', async (req, res) => {
  const params = { ...req.body };
  try {
    if (!alipaySdk) return res.type('text/plain').send('fail');
    // 验签：以当前 SDK 实际 API 为准（v3.6.2 只有 checkNotifySign）
    let signOk = false;
    if (typeof alipaySdk.checkNotifySignV2 === 'function') {
      signOk = await Promise.resolve(alipaySdk.checkNotifySignV2(params));
    } else if (typeof alipaySdk.checkNotifySign === 'function') {
      signOk = await Promise.resolve(alipaySdk.checkNotifySign(params));
    }
    if (!signOk) {
      console.warn('[通知验签失败]');
      return res.type('text/plain').send('fail');
    }

    const order = store.findOrder(params.out_trade_no);
    if (!order || !store.businessFieldsMatch(order, params, config)) {
      console.warn('[通知业务校验失败]', params.out_trade_no);
      return res.type('text/plain').send('fail');
    }

    // 幂等：同一通知只处理一次
    const inserted = store.insertNotifyEvent({
      notifyId: params.notify_id,
      tradeNo: params.trade_no,
      outTradeNo: params.out_trade_no,
      tradeStatus: params.trade_status,
      rawParams: params
    });
    if (!inserted) return res.type('text/plain').send('success');

    if (store.isPaidNotification(params)) {
      store.markPaid(params.out_trade_no, params.trade_no);
      console.log(`[支付成功] 订单=${params.out_trade_no} 钻石=${order.diamonds}`);
      // TODO(生产): 在此处把钻石发放到用户账户（需用户身份绑定 + 事务 + 幂等）
    } else {
      store.markEvent(params.out_trade_no, params.trade_status);
    }
    return res.type('text/plain').send('success');
  } catch (e) {
    console.error('[通知异常]', e && e.message);
    return res.type('text/plain').send('fail');
  }
});

/* ---------- 同步回跳结果页（不直接信任参数） ---------- */
app.get('/return', (req, res) => {
  // 同步参数可伪造，仅展示"确认中"，真实结果以后端查单/异步通知为准
  const outTradeNo = req.query.out_trade_no || '';
  res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付结果 - 钱搭子</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#fff5f9;text-align:center;padding:60px 20px;color:#3a2f38}
.card{background:#fff;border-radius:20px;padding:36px;max-width:420px;margin:0 auto;box-shadow:0 12px 40px rgba(200,120,160,.18)}
.ic{font-size:56px}.t{font-size:20px;font-weight:700;margin:12px 0}.s{color:#6d5d69;font-size:14px;line-height:1.7}
button{background:#c2185b;color:#fff;border:none;border-radius:12px;padding:12px 28px;font-size:15px;margin-top:18px;cursor:pointer}</style></head>
<body><div class="card"><div class="ic">🐷</div><div class="t">正在确认支付结果…</div>
<div class="s">桃桃正在向支付宝核实这笔充值，请稍候。<br>支付是否成功以服务端查询结果为准。</div>
<button onclick="location.href='/'">返回存钱屋</button></div>
<script>
var no=${JSON.stringify(outTradeNo)};
if(no){setTimeout(function(){fetch('/api/order/'+encodeURIComponent(no)).then(function(r){return r.json()}).then(function(d){
  var t=document.querySelector('.t'),s=document.querySelector('.s'),ic=document.querySelector('.ic');
  if(d.ok&&d.status==='PAID'){ic.textContent='🎉';t.textContent='充值成功！';s.innerHTML='已到账 <b>'+d.diamonds+'</b> 钻石，回到存钱屋继续存钱吧～';}
  else if(d.ok&&d.status==='CLOSED'){ic.textContent='😢';t.textContent='订单已关闭';s.textContent='这笔充值未支付成功。';}
  else {ic.textContent='⏳';t.textContent='等待支付确认';s.textContent='如果刚刚完成付款，请稍等几秒再刷新；也可返回应用查看钻石余额。';}
}).catch(function(){})},800);}
</script></body></html>`);
});

app.get('/api/health', (req, res) => res.json({ ok:true, env:config.env, sdkReady:!!alipaySdk }));

// 托管前端：优先 public/ 目录，其次项目根目录的 index.html
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_INDEX = path.join(__dirname, 'index.html');
if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  app.use(express.static(PUBLIC_DIR));
} else if (fs.existsSync(ROOT_INDEX)) {
  // 只单独提供 index.html，绝不静态暴露整个目录（避免泄露 config.js / .env）
  app.get('/', (req, res) => res.sendFile(ROOT_INDEX));
  app.get('/index.html', (req, res) => res.sendFile(ROOT_INDEX));
}

// 统一 JSON 错误响应（避免 Express 默认把异常渲染成 HTML）
app.use((err, req, res, next) => {
  console.error('[服务异常]', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok:false, error: (err && err.message) || '服务内部错误' });
});

app.listen(config.port, () => {
  console.log(`[钱搭子支付服务] http://localhost:${config.port}`);
});
