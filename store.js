/* 订单与通知事件仓储（内存版）
 * 演示/参赛用内存存储，重启后订单记录清空，但支付与查单流程完整可用。
 * 生产环境必须换成数据库（订单表 + 通知事件表 + 事务 + 幂等）。
 * 金额一律用"元"为单位的两位小数字符串，禁止浮点比较。
 */
const crypto = require('crypto');

const orders = Object.create(null);
const events = Object.create(null);

function normalizeAmount(value) {
  const m = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return `${BigInt(m[1]).toString()}.${(m[2] || '').padEnd(2, '0')}`;
}

module.exports = {
  createOrder({ diamonds, amount, subject, buyerHint }) {
    const outTradeNo = 'TT' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
    const order = {
      outTradeNo,
      diamonds,
      totalAmount: normalizeAmount(amount),
      subject,
      buyerHint: buyerHint || '',
      status: 'WAIT_PAY',       // WAIT_PAY | PAID | CLOSED
      tradeNo: '',
      createdAt: new Date().toISOString(),
      paidAt: ''
    };
    orders[outTradeNo] = order;
    return order;
  },

  findOrder(outTradeNo) { return orders[outTradeNo] || null; },

  // 幂等：同一 notify_id / out_trade_no+trade_no 只处理一次
  insertNotifyEvent({ notifyId, tradeNo, outTradeNo, tradeStatus, rawParams }) {
    const key = notifyId || `${outTradeNo}_${tradeNo}_${tradeStatus}`;
    if (events[key]) return false;
    events[key] = { key, tradeNo, outTradeNo, tradeStatus, rawParams, at: new Date().toISOString() };
    return true;
  },

  // 校验通知业务字段：app_id / 订单号 / 金额 / 卖家
  businessFieldsMatch(order, params, config) {
    const amountOk = normalizeAmount(params.total_amount) === order.totalAmount;
    const appOk = !params.app_id || params.app_id === config.appId;
    const sellerOk = !config.sellerId || !params.seller_id || params.seller_id === config.sellerId;
    return amountOk && appOk && sellerOk;
  },

  isPaidNotification(params) {
    const paid = params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED';
    return paid && !params.out_biz_no && !params.gmt_refund && !params.refund_fee;
  },

  markPaid(outTradeNo, tradeNo) {
    const order = orders[outTradeNo];
    if (!order) return null;
    if (order.status === 'PAID') return order; // 幂等
    order.status = 'PAID';
    order.tradeNo = tradeNo || order.tradeNo;
    order.paidAt = new Date().toISOString();
    return order;
  },

  markEvent(outTradeNo, tradeStatus) {
    const order = orders[outTradeNo];
    if (order) order.lastTradeStatus = tradeStatus;
  },

  normalizeAmount
};
