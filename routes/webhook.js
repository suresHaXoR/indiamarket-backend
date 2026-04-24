const router = require('express').Router();
const { verifyWebhookSignature } = require('../config/razorpay');
const db = require('../db');

// ── POST /api/webhook ────────────────────────────────────────────────────────
// Razorpay sends events here automatically.
// This is your BACKUP — if the user closes the browser before /verify runs,
// the webhook still credits the wallet. Never rely only on frontend callback.
//
// Setup in Razorpay Dashboard → Settings → Webhooks → Add URL
// Events to enable: payment.captured, payment.failed, refund.processed
router.post('/', (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = req.body; // raw Buffer (registered before express.json)

    // ✅ Verify webhook signature
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn('⚠️  Webhook signature mismatch — ignoring');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());
    console.log(`📡 Webhook: ${event.event}`);

    switch (event.event) {

      case 'payment.captured': {
        const payment = event.payload.payment.entity;
        const orderId = payment.order_id;
        const order   = db.getOrder(orderId);

        if (!order) {
          console.warn(`Webhook: order ${orderId} not found`);
          break;
        }

        if (order.paid) {
          console.log(`Webhook: order ${orderId} already paid — skipping`);
          break;
        }

        // Credit wallet
        db.markOrderPaid(orderId, payment.id);
        db.creditWallet(order.userId, order.amountPaise, `Deposit — ${payment.id}`);
        console.log(`✅ Wallet credited ₹${order.amountPaise / 100} for user ${order.userId}`);
        break;
      }

      case 'payment.failed': {
        const payment = event.payload.payment.entity;
        console.warn(`❌ Payment failed: ${payment.id} — ${payment.error_description}`);
        // Notify user via push notification / websocket if needed
        break;
      }

      case 'refund.processed': {
        const refund = event.payload.refund.entity;
        console.log(`💸 Refund processed: ${refund.id} — ₹${refund.amount / 100}`);
        break;
      }

      default:
        console.log(`Unhandled webhook event: ${event.event}`);
    }

    // Always respond 200 so Razorpay doesn't retry
    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
