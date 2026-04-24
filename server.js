require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const walletRoutes  = require('./routes/wallet');
const paymentRoutes = require('./routes/payment');
const webhookRoutes = require('./routes/webhook');
const marketsRoutes = require('./routes/markets');

const app = express();

// ─── Security ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));

// Webhook must get raw body — register BEFORE express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json());

// Rate limiting — 100 requests per 15 min per IP
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, try again later.' }
}));

// Stricter limit on payment creation — 10 per 15 min
app.use('/api/payment/create-order', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts.' }
}));

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/wallet',  walletRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/markets', marketsRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 IndiaMarket API running on port ${PORT}`);
  console.log(`   Razorpay: ${process.env.RAZORPAY_KEY_ID ? '✅ Connected' : '⚠️  No key set'}`);
  console.log(`   DB:       ${process.env.DATABASE_URL ? '✅ Connected' : '⚠️  Using in-memory'}\n`);
});

module.exports = app;
