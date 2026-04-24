const Razorpay = require('razorpay');
const crypto   = require('crypto');

const rzp = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID     || 'rzp_test_XXXXXXXX',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_TEST_SECRET'
});

/**
 * Verify Razorpay payment signature (HMAC-SHA256).
 * Call this BEFORE crediting the wallet.
 */
function verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const body    = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'YOUR_TEST_SECRET')
    .update(body)
    .digest('hex');
  return expected === razorpay_signature;
}

/**
 * Verify Razorpay webhook signature.
 */
function verifyWebhookSignature(rawBody, receivedSig) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'WEBHOOK_SECRET')
    .update(rawBody)
    .digest('hex');
  return expected === receivedSig;
}

module.exports = { rzp, verifySignature, verifyWebhookSignature };
