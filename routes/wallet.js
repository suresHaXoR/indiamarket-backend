const router  = require('express').Router();
const { auth } = require('../middleware/auth');
const db = process.env.SUPABASE_URL ? require('../db/supabase') : require('../db');

// ── GET /api/wallet ──────────────────────────────────────────────────────────
// Returns wallet balance + recent transactions
router.get('/', auth, (req, res) => {
  const wallet = db.getWallet(req.userId);
  const user   = db.getUser(req.userId);
  const txs    = db.getTxHistory(req.userId, 20);

  res.json({
    balance:       paiseToRupees(wallet.balance),       // ₹ float
    balancePaise:  wallet.balance,
    locked:        paiseToRupees(wallet.locked),
    lockedPaise:   wallet.locked,
    available:     paiseToRupees(wallet.balance),
    kyc:           user?.kycStatus || 'pending',
    limit:         kycLimit(user?.kycStatus),
    transactions:  txs.map(formatTx)
  });
});

// ── POST /api/wallet/withdraw ────────────────────────────────────────────────
// Initiate withdrawal to UPI
router.post('/withdraw', auth, (req, res, next) => {
  try {
    const { amount, upiId } = req.body;

    if (!amount || amount < 100)
      return res.status(400).json({ error: 'Minimum withdrawal is ₹100' });

    if (!upiId || !isValidUPI(upiId))
      return res.status(400).json({ error: 'Invalid UPI ID. Format: name@bank' });

    const user = db.getUser(req.userId);
    if (!user || user.kycStatus === 'pending')
      return res.status(403).json({ error: 'Complete KYC before withdrawing' });

    const amountPaise = rupeesToPaise(amount);
    const wallet      = db.getWallet(req.userId);

    if (wallet.balance < amountPaise)
      return res.status(400).json({ error: 'Insufficient balance' });

    // Debit wallet and create withdrawal record
    db.debitWallet(req.userId, amountPaise, `Withdrawal to ${upiId}`);
    const withdrawal = db.createWithdrawal(req.userId, amountPaise, upiId);

    // 🔥 In production: call Razorpay Payout API here
    // await rzp.payouts.create({ account_number: VIRTUAL_ACCOUNT, fund_account_id: ..., amount: amountPaise, ... })

    res.json({
      success:      true,
      withdrawalId: withdrawal.id,
      amount,
      upiId,
      status:       'pending',
      eta:          'Instant — within 30 seconds',
      message:      `₹${amount} withdrawal initiated to ${upiId}`
    });

  } catch (err) { next(err); }
});

// ── GET /api/wallet/transactions ─────────────────────────────────────────────
router.get('/transactions', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const txs   = db.getTxHistory(req.userId, limit);
  res.json({ transactions: txs.map(formatTx), count: txs.length });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function paiseToRupees(p) { return +(p / 100).toFixed(2); }
function rupeesToPaise(r) { return Math.round(r * 100); }

function isValidUPI(id) {
  return /^[\w.\-]{3,}@[a-zA-Z]{3,}$/.test(id);
}

function kycLimit(status) {
  return { pending: 0, basic: 10000, verified: 100000 }[status] || 0;
}

function formatTx(tx) {
  return {
    id:        tx.id,
    type:      tx.type,
    amount:    paiseToRupees(tx.amount),
    note:      tx.note,
    status:    tx.status,
    createdAt: tx.createdAt
  };
}

module.exports = router;
