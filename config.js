/* 钱搭子 - 支付宝收款配置
 * 密钥只从环境变量读取，禁止写入代码或提交到版本库。
 * 沙箱网关: https://openapi-sandbox.dl.alipaydev.com/gateway.do
 * 生产网关: https://openapi.alipay.com/gateway.do
 */
// 轻量加载 .env（无需额外依赖）：只填未被环境变量覆盖的键
try {
  const fs = require('fs');
  const path = require('path');
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    });
  }
} catch (e) {}

const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const PROD_GATEWAY = 'https://openapi.alipay.com/gateway.do';

// ALIPAY_ENV=sandbox(默认) | production
const ENV = (process.env.ALIPAY_ENV || 'sandbox').toLowerCase();
const isProd = ENV === 'production';

// 应用配置：Node.js 使用 PKCS#1 私钥（对应沙箱 appPrivatePkcsKey）
const config = {
  env: ENV,
  gateway: isProd ? PROD_GATEWAY : SANDBOX_GATEWAY,
  appId: process.env.ALIPAY_APP_ID || '',
  privateKey: process.env.ALIPAY_PRIVATE_KEY || '',       // PKCS#1，原始字符串，不加 PEM 头尾
  alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY || '',
  signType: 'RSA2',
  // 公网站点根地址（云端部署时设置，如 https://taotao.onrender.com）
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  // 回跳地址优先级：显式 ALIPAY_RETURN_URL > 公网地址推导 > 本地 localhost
  returnUrl: process.env.ALIPAY_RETURN_URL
    || (process.env.PUBLIC_BASE_URL ? (process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/return') : 'http://localhost:3000/return'),
  // 异步通知地址：显式 > 公网推导 > 空
  notifyUrl: (process.env.ALIPAY_NOTIFY_URL
    || ((process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') ? (process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/alipay/notify') : '')).trim(),
  port: Number(process.env.PORT || 3000)
};

function validate() {
  const missing = [];
  if (!config.appId) missing.push('ALIPAY_APP_ID');
  if (!config.privateKey) missing.push('ALIPAY_PRIVATE_KEY');
  if (!config.alipayPublicKey) missing.push('ALIPAY_PUBLIC_KEY');
  return missing;
}

module.exports = { config, validate, isProd };
