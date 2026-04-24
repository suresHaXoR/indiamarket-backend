const router    = require('express').Router();
const { auth }  = require('../middleware/auth');
const { rzp, verifySignature } = require('../config/razorpay');
const db        = require('../db');
const { v4: uuid } = require('uuid');

// ── POST /api/payment/create-order ───────────────────────────────────────────
// Step 1: Frontend calls this → gets order_id → opens Razorpay checkout
router.post('/create-order', auth, async (req, res, next) => {
  try {
    const { amount } = req.body;  // amount in ₹

    // Validate amount
    if (!amount || amount < 10)
      return res.status(400).json({ error: 'Minimum deposit is ₹10' });

    if (amount > 100000)
      return res.status(400).json({ error: 'Maximum deposit is ₹1,00,000' });

    // Check KYC wallet limit
    const user   = db.getUser(req.userId);
    const wallet = db.getWallet(req.userId);
    const limit  = { pending: 0, basic: 1000000, verified: 10000000 }[user?.kycStatus] || 0;

    if (wallet.balance + rupeesToPaise(amount) > limit)
      return res.status(400).json({
        error: `Wallet limit exceeded. Your KYC allows max ₹${limit/100} balance.`,
        kycStatus: user?.kycStatus
      });

    const amountPaise = rupeesToPaise(amount);
    const receiptId   = `rcpt_${uuid().split('-')[0]}`;

    // ── Create Razorpay order ─────────────────────────────────────────────
    const order = await rzp.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  receiptId,
      notes: {
        userId:  req.userId,
        purpose: 'wallet_topup'
      }
    });

    // Save order to DB
    db.saveOrder({ ...order, userId: req.userId, amountPaise });

    // Return to frontend
    res.json({
      orderId:  order.id,
      amount:   order.amount,      // in paise
      currency: order.currency,
      receipt:  order.receipt,
      keyId:    process.env.RAZORPAY_KEY_ID || 'rzp_test_XXXXXXXX',
      // Pre-fill user details in Razorpay checkout
      prefill: {
        name:    user?.name  || '',
        contact: user?.phone || '',
      }
    });

  } catch (err) { next(err); }
});

// ── POST /api/payment/verify ─────────────────────────────────────────────────
// Step 2: Called by frontend AFTER user completes payment in Razorpay popup
// Verifies signature → credits wallet
router.post('/verify', auth, (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment details' });

    // ✅ Verify HMAC signature — prevents fake payments
    const valid = verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
    if (!valid)
      return res.status(400).json({ error: 'Payment verification failed. Do not tamper.' });

    // Get order from DB
    const order = db.getOrder(razorpay_order_id);
    if (!order)
      return res.status(404).json({ error: 'Order not found' });

    if (order.paid)
      return res.status(400).json({ error: 'Order already processed' });

    // Verify this order belongs to this user
    if (order.userId !== req.userId)
      return res.status(403).json({ error: 'Order user mismatch' });

    // ✅ Mark paid + credit wallet
    db.markOrderPaid(razorpay_order_id, razorpay_payment_id);
    const wallet = db.creditWallet(
      req.userId,
      order.amountPaise,
      `Deposit via Razorpay — ${razorpay_payment_id}`
    );

    res.json({
      success:    true,
      paymentId:  razorpay_payment_id,
      credited:   paiseToRupees(order.amountPaise),
      newBalance: paiseToRupees(wallet.balance),
      message:    `₹${paiseToRupees(order.amountPaise)} added to your wallet 🎉`
    });

  } catch (err) { next(err); }
});

// ── GET /api/payment/status/:orderId ────────────────────────────────────────
router.get('/status/:orderId', auth, (req, res) => {
  const order = db.getOrder(req.params.orderId);
  if (!order || order.userId !== req.userId)
    return res.status(404).json({ error: 'Order not found' });

  res.json({
    orderId:   order.id,
    amount:    paiseToRupees(order.amountPaise),
    paid:      order.paid,
    paymentId: order.paymentId || null,
    paidAt:    order.paidAt || null
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function rupeesToPaise(r) { return Math.round(r * 100); }
function paiseToRupees(p) { return +(p / 100).toFixed(2); }

module.exports = router;
