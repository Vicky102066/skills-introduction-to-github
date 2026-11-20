/* 一键把支付宝沙箱密钥写入 .env
 * 用法：把控制台"配置沙箱密钥"区块整段复制存成 keys.txt，运行： node setup-env.js keys.txt
 *
 * 支付宝控制台给的 5 个字段（命名有点坑，注意）：
 *   ALIPAY_APP_ID=...                    应用ID
 *   ALIPAY_PUBLIC_KEY=MIIBIjANBg...      沙箱应用公钥（我们上传给支付宝的）
 *   ALIPAY_PRIVATE_KEY=MIIEvQIBADAN...   JAVA 私钥 = PKCS#8（Node.js 不能用）
 *   ALIPAY_PRIVATE_PKCS8_KEY=MIIEowIBAAK...  非JAVA私钥 = 其实是 PKCS#1（Node.js 用这个！名字叫PKCS8但值是PKCS#1）
 *   SANDBOX_ALIPAY_PUBLIC_KEY=MIIBIjANBg...  沙箱支付宝公钥（我们验签用这个！）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = process.argv[2];
if (!file) {
  console.error('用法: node setup-env.js <密钥文本文件>');
  console.error('示例: node setup-env.js keys.txt');
  process.exit(1);
}

let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error('读取失败:', e.message); process.exit(1); }

function grab(...labels) {
  // 依次尝试多个可能的字段名（控制台有 AIPAY_ / ALIPAY_ 两种前缀写法）
  for (const label of labels) {
    const re = new RegExp(label + '\\s*=\\s*([^\\s\\r\\n]+)', 'i');
    const m = raw.match(re);
    if (m) return m[1].trim();
  }
  return '';
}
function stripPem(s) {
  return s.replace(/[^A-Za-z0-9+/=]/g, '');
}

const appId = grab('AIPAY_APP_ID', 'ALIPAY_APP_ID');
const appPublicKey = stripPem(grab('AIPAY_PUBLIC_KEY', 'ALIPAY_PUBLIC_KEY'));
// 非JAVA私钥优先（MIIEowIBAAK = PKCS#1）；没有则用 JAVA 私钥（MIIEv... = PKCS#8）再转换
let privateKey = stripPem(grab('AIPAY_PRIVATE_PKCS_KEY', 'ALIPAY_PRIVATE_PKCS8_KEY', 'AIPAY_PRIVATE_PKCS8_KEY'));
let privateSource = '控制台「非 JAVA 语言私钥」';
if (!privateKey) {
  privateKey = stripPem(grab('AIPAY_PRIVATE_KEY', 'ALIPAY_PRIVATE_KEY'));
  privateSource = '控制台「JAVA 语言私钥」';
}
// 验签公钥：优先沙箱支付宝公钥；没有就用应用公钥（部分环境两者通用）
let alipayPublicKey = stripPem(grab('AIPAY_ALIPAY_PUBLIC_KEY', 'SANDBOX_ALIPAY_PUBLIC_KEY', 'ALIPAY_ALIPAY_PUBLIC_KEY'));
let publicSource = '沙箱支付宝公钥';
if (!alipayPublicKey) {
  alipayPublicKey = appPublicKey;
  publicSource = '应用公钥（未找到沙箱支付宝公钥）';
}

if (!appId || !privateKey || !alipayPublicKey) {
  console.error('没有完整提取到密钥。请确认文件里有这些行（整段复制控制台那块即可）：');
  console.error('  ALIPAY_APP_ID=...');
  console.error('  ALIPAY_PUBLIC_KEY=...  或  SANDBOX_ALIPAY_PUBLIC_KEY=...');
  console.error('  ALIPAY_PRIVATE_PKCS8_KEY=...  或  ALIPAY_PRIVATE_KEY=...');
  process.exit(1);
}

// 如果拿到的是 PKCS#8（MIIEv...），转成 Node.js 需要的 PKCS#1
if (/^MIIEv/.test(privateKey)) {
  console.log('私钥是 PKCS#8，正在转为 Node.js 用的 PKCS#1…');
  try {
    const pem8 = '-----BEGIN PRIVATE KEY-----\n' + privateKey.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
    privateKey = stripPem(crypto.createPrivateKey(pem8).export({ type: 'pkcs1', format: 'pem' }));
    console.log('转换完成。');
  } catch (e) {
    console.error('转换失败：' + e.message);
    console.error('请直接复制控制台那行「非 JAVA 语言私钥」(MIIEowIBAAK 开头)。');
    process.exit(1);
  }
}

const isPkcs1 = /^MIIE(o|p)w?IBAAK/.test(privateKey) || /^MIIEowIBAAK/.test(privateKey);
const env = `# 由 setup-env.js 自动生成（沙箱）
ALIPAY_ENV=sandbox
ALIPAY_APP_ID=${appId}
ALIPAY_PRIVATE_KEY=${privateKey}
ALIPAY_PUBLIC_KEY=${alipayPublicKey}
ALIPAY_RETURN_URL=http://localhost:3000/return
PORT=3000
`;
fs.writeFileSync(path.join(__dirname, '.env'), env, 'utf8');
console.log('已生成 .env ✔');
console.log('APP_ID:', appId);
console.log('私钥来源:', privateSource);
console.log('私钥格式:', isPkcs1 ? 'PKCS#1 (Node.js 正确)' : '未能确认，请检查');
console.log('验签公钥来源:', publicSource);
console.log('下一步: npm start 然后打开 http://localhost:3000/api/health');
