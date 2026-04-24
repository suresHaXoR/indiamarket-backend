// routes/markets.js
const router   = require('express').Router();
const { auth } = require('../middleware/auth');
const db       = require('../db');
const mdb      = require('../db/markets');

// ── GET /api/markets ─────────────────────────────────────────────────────────
// List all open markets. Filter by ?category=ipl or ?category=election
router.get('/', (req, res) => {
  const { category, status = 'open', limit } = req.query;
  const list = mdb.listMarkets({ category, status, limit: parseInt(limit) || 20 });
  res.json({ markets: list.map(fmtMarket), count: list.length });
});

// ── GET /api/markets/:id ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const market = mdb.getMarket(req.params.id);
  if (!market) return res.status(404).json({ error: 'Market not found' });
  res.json(fmtMarket(market));
});

// ── POST /api/markets/preview ─────────────────────────────────────────────────
// Preview payout before placing bet (call this when user types amount)
router.post('/preview', auth, (req, res) => {
  const { marketId, side, amount } = req.body;
  if (!marketId || !side || !amount)
    return res.status(400).json({ error: 'marketId, side, amount required' });

  const preview = mdb.calcPreviewPayout(marketId, side, rupeesToPaise(amount));
  if (!preview) return res.status(404).json({ error: 'Market not found' });

  res.json({
    amount,
    side,
    shares:          preview.shares,
    avgPrice:        preview.avgPriceCents,
    potentialPayout: paiseToRupees(preview.potentialPayout),
    potentialProfit: paiseToRupees(preview.potentialProfit),
    roi:             preview.roi,
  });
});

// ── POST /api/markets/:id/bet ─────────────────────────────────────────────────
// Place a bet on a market
router.post('/:id/bet', auth, (req, res, next) => {
  try {
    const { side, amount } = req.body;

    if (!side || !amount)
      return res.status(400).json({ error: 'side (yes/no) and amount (₹) required' });

    const amountPaise = rupeesToPaise(amount);
    const wallet      = db.getWallet(req.userId);

    if (wallet.balance < amountPaise)
      return res.status(400).json({
        error:      'Insufficient wallet balance',
        balance:    paiseToRupees(wallet.balance),
        required:   amount
      });

    const result = mdb.placeBet(req.userId, req.params.id, side, amountPaise, db);

    res.json({
      success:     true,
      position:    fmtPosition(result.position),
      newYesPrice: result.newYesPrice,
      newNoPrice:  result.newNoPrice,
      message:     `Bet placed! ₹${amount} on ${side.toUpperCase()} 🎯`
    });

  } catch (err) { next(err); }
});

// ── GET /api/markets/:id/positions ───────────────────────────────────────────
// All positions on a market (for order book display)
router.get('/:id/positions', (req, res) => {
  const positions = mdb.getMarketPositions(req.params.id);
  const summary = {
    total:      positions.length,
    yesCount:   positions.filter(p => p.side === 'yes').length,
    noCount:    positions.filter(p => p.side === 'no').length,
    yesVolume:  paiseToRupees(positions.filter(p => p.side === 'yes').reduce((s,p) => s+p.amountPaise, 0)),
    noVolume:   paiseToRupees(positions.filter(p => p.side === 'no').reduce((s,p) => s+p.amountPaise, 0)),
  };
  res.json(summary);
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES (protected — add admin middleware in production)
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/markets (admin) ─────────────────────────────────────────────────
router.post('/', auth, (req, res, next) => {
  try {
    const { title, description, category, closesAt, tags } = req.body;
    if (!title || !category || !closesAt)
      return res.status(400).json({ error: 'title, category, closesAt required' });

    const market = mdb.createMarket({ title, description, category, closesAt, tags, createdBy: req.userId });
    res.status(201).json(fmtMarket(market));
  } catch (err) { next(err); }
});

// ── POST /api/markets/:id/resolve (admin) ─────────────────────────────────────
// Resolve a market: outcome = true (YES wins) | false (NO wins)
router.post('/:id/resolve', auth, (req, res, next) => {
  try {
    const { outcome } = req.body;
    if (typeof outcome !== 'boolean')
      return res.status(400).json({ error: 'outcome must be true (YES) or false (NO)' });

    const summary = mdb.resolveMarket(req.params.id, outcome, db);

    res.json({
      success: true,
      result:  outcome ? 'YES won' : 'NO won',
      summary: {
        marketId:     summary.marketId,
        outcome:      summary.outcome,
        winners:      summary.winners,
        losers:       summary.losers,
        totalPayout:  paiseToRupees(summary.totalPayout),
      },
      message: `Market resolved. ${summary.winners} winners paid out ✅`
    });
  } catch (err) { next(err); }
});

// ── POST /api/markets/:id/cancel (admin) ─────────────────────────────────────
router.post('/:id/cancel', auth, (req, res, next) => {
  try {
    const result = mdb.cancelMarket(req.params.id, db);
    res.json({ success: true, refunded: result.cancelled, message: 'Market cancelled. All bets refunded.' });
  } catch (err) { next(err); }
});


// ── GET /api/markets/portfolio/me ─────────────────────────────────────────────
router.get('/portfolio/me', auth, (req, res) => {
  const portfolio = mdb.getUserPortfolio(req.userId);
  res.json({
    openPositions:  portfolio.openPositions.map(fmtPosition),
    wonPositions:   portfolio.wonPositions.map(fmtPosition),
    lostPositions:  portfolio.lostPositions.map(fmtPosition),
    totalInvested:  paiseToRupees(portfolio.totalInvested),
    totalWon:       paiseToRupees(portfolio.totalWon),
    totalLost:      paiseToRupees(portfolio.totalLost),
    pnl:            paiseToRupees(portfolio.pnl),
    winRate:        portfolio.winRate,
  });
});


// ── Formatters ────────────────────────────────────────────────────────────────
function fmtMarket(m) {
  return {
    id:           m.id,
    category:     m.category,
    title:        m.title,
    description:  m.description,
    status:       m.status,
    outcome:      m.outcome,
    yesPrice:     m.yesPrice,
    noPrice:      m.noPrice,
    totalVolume:  paiseToRupees(m.totalVolume),
    yesVolume:    paiseToRupees(m.yesVolume),
    noVolume:     paiseToRupees(m.noVolume),
    closesAt:     m.closesAt,
    resolvedAt:   m.resolvedAt,
    tags:         m.tags,
    createdAt:    m.createdAt,
  };
}

function fmtPosition(p) {
  return {
    id:           p.id,
    marketId:     p.marketId,
    marketTitle:  p.marketTitle,
    side:         p.side,
    amount:       paiseToRupees(p.amountPaise),
    shares:       p.shares,
    avgPrice:     p.avgPriceCents,
    status:       p.status,
    payout:       p.payout != null ? paiseToRupees(p.payout) : null,
    profit:       p.payout != null ? paiseToRupees(p.payout - p.amountPaise) : null,
    createdAt:    p.createdAt,
  };
}

function paiseToRupees(p) { return +(p / 100).toFixed(2); }
function rupeesToPaise(r) { return Math.round(r * 100); }

module.exports = router;
