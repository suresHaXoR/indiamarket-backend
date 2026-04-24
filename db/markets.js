// db/markets.js — Markets, Positions, Settlements
const { v4: uuid } = require('uuid');

// ── Tables ────────────────────────────────────────────────────────────────────
const markets    = new Map();   // marketId → Market
const positions  = new Map();   // positionId → Position
const userPositions = new Map();// userId → [positionId, ...]

// ── Seed some IPL + Election markets ─────────────────────────────────────────
const seedMarkets = [
  {
    id: 'mkt_ipl_csk_mi_winner',
    category: 'ipl',
    title: 'Will CSK beat MI in Match 34?',
    description: 'CSK vs MI at Chepauk, Apr 22. Does CSK win?',
    status: 'open',           // open | closed | resolved | cancelled
    outcome: null,            // true (YES won) | false (NO won) | null
    yesPrice: 62,             // cents (out of 100) = 62% probability
    noPrice: 38,
    totalVolume: 0,           // paise
    yesVolume: 0,
    noVolume: 0,
    closesAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2hrs from now
    resolvedAt: null,
    createdBy: 'admin',
    tags: ['ipl', 'csk', 'mi', 'match'],
  },
  {
    id: 'mkt_ipl_2025_winner',
    category: 'ipl',
    title: 'Who wins IPL 2025?',
    description: 'Will CSK lift the trophy this season?',
    status: 'open',
    outcome: null,
    yesPrice: 34,
    noPrice: 66,
    totalVolume: 0,
    yesVolume: 0,
    noVolume: 0,
    closesAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    resolvedAt: null,
    createdBy: 'admin',
    tags: ['ipl', 'season', 'csk'],
  },
  {
    id: 'mkt_rohit_50_today',
    category: 'ipl',
    title: 'Will Rohit Sharma score 50+ today?',
    description: 'MI vs KKR, Apr 23. Rohit scores a fifty?',
    status: 'open',
    outcome: null,
    yesPrice: 41,
    noPrice: 59,
    totalVolume: 0,
    yesVolume: 0,
    noVolume: 0,
    closesAt: new Date(Date.now() + 26 * 60 * 60 * 1000),
    resolvedAt: null,
    createdBy: 'admin',
    tags: ['ipl', 'mi', 'rohit'],
  },
  {
    id: 'mkt_tn_election_dmk',
    category: 'election',
    title: 'Will DMK win 150+ seats in TN 2026?',
    description: 'Tamil Nadu Assembly Elections 2026. DMK majority?',
    status: 'open',
    outcome: null,
    yesPrice: 71,
    noPrice: 29,
    totalVolume: 0,
    yesVolume: 0,
    noVolume: 0,
    closesAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    resolvedAt: null,
    createdBy: 'admin',
    tags: ['election', 'tamilnadu', 'dmk'],
  },
  {
    id: 'mkt_bihar_nda',
    category: 'election',
    title: 'Will NDA win Bihar 2025?',
    description: 'NDA (BJP + JDU) forms government in Bihar?',
    status: 'open',
    outcome: null,
    yesPrice: 68,
    noPrice: 32,
    totalVolume: 0,
    yesVolume: 0,
    noVolume: 0,
    closesAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    resolvedAt: null,
    createdBy: 'admin',
    tags: ['election', 'bihar', 'nda'],
  }
];

seedMarkets.forEach(m => markets.set(m.id, {
  ...m,
  createdAt: new Date(),
  totalVolume: Math.floor(Math.random() * 5000000) + 100000,  // seed volume for realism
  yesVolume:  Math.floor(Math.random() * 3000000),
  noVolume:   Math.floor(Math.random() * 2000000),
}));


// ═══════════════════════════════════════════════════════════════════════════════
// MARKET CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function listMarkets({ category, status = 'open', limit = 20 } = {}) {
  let result = [...markets.values()];
  if (category) result = result.filter(m => m.category === category);
  if (status)   result = result.filter(m => m.status   === status);
  return result
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, limit);
}

function getMarket(marketId) {
  return markets.get(marketId) || null;
}

function createMarket({ title, description, category, closesAt, createdBy = 'admin', tags = [] }) {
  const id = `mkt_${uuid().split('-')[0]}`;
  const market = {
    id, title, description, category,
    status: 'open',
    outcome: null,
    yesPrice: 50, noPrice: 50,
    totalVolume: 0, yesVolume: 0, noVolume: 0,
    closesAt: new Date(closesAt),
    resolvedAt: null,
    createdBy, tags,
    createdAt: new Date(),
  };
  markets.set(id, market);
  return market;
}


// ═══════════════════════════════════════════════════════════════════════════════
// BETTING ENGINE — Constant Product AMM
//
// Price model: yesPrice = yesPool / (yesPool + noPool) * 100
// When user buys YES:  noPool grows, yesPrice rises
// When user buys NO:   yesPool grows, noPrice rises
//
// This is similar to how Polymarket works internally.
// ═══════════════════════════════════════════════════════════════════════════════

// Each market has a liquidity pool
const liquidityPools = new Map(); // marketId → { yesPool, noPool }

function _getPool(marketId) {
  if (!liquidityPools.has(marketId)) {
    // Initial pool = 10000 each side (balanced 50/50 start)
    liquidityPools.set(marketId, { yesPool: 10000, noPool: 10000 });
  }
  return liquidityPools.get(marketId);
}

/**
 * Calculate how many shares you get for a given paise amount.
 * Uses constant product formula: x * y = k
 */
function calcShares(marketId, side, amountPaise) {
  const pool     = _getPool(marketId);
  const inPool   = side === 'yes' ? pool.noPool  : pool.yesPool;
  const outPool  = side === 'yes' ? pool.yesPool : pool.noPool;
  const k        = inPool * outPool;

  const newInPool  = inPool + amountPaise;
  const newOutPool = k / newInPool;
  const shares     = outPool - newOutPool;

  // Average price = amount / shares
  const avgPrice = amountPaise / shares;

  return {
    shares:       Math.floor(shares),
    avgPriceCents: Math.round(avgPrice * 100),   // 0-100
    newYesPrice:  Math.round((side === 'yes'
      ? newOutPool / (newOutPool + newInPool)
      : newInPool  / (newInPool  + newOutPool)) * 100)
  };
}

/**
 * Place a bet. Deducts from wallet, creates position.
 * Returns the position.
 */
function placeBet(userId, marketId, side, amountPaise, walletOps) {
  const market = getMarket(marketId);
  if (!market)              throw Object.assign(new Error('Market not found'), { status: 404 });
  if (market.status !== 'open') throw Object.assign(new Error('Market is not open for betting'), { status: 400 });
  if (amountPaise < 1000)   throw Object.assign(new Error('Minimum bet is ₹10'), { status: 400 });
  if (amountPaise > 500000) throw Object.assign(new Error('Maximum bet is ₹5000 per position'), { status: 400 });
  if (!['yes','no'].includes(side)) throw Object.assign(new Error('Side must be yes or no'), { status: 400 });

  // Calculate shares using AMM
  const { shares, avgPriceCents, newYesPrice } = calcShares(marketId, side, amountPaise);

  // Deduct from user wallet
  walletOps.debitWallet(userId, amountPaise, `Bet on "${market.title}" — ${side.toUpperCase()}`);

  // Update liquidity pool
  const pool = _getPool(marketId);
  if (side === 'yes') { pool.noPool  += amountPaise; pool.yesPool = (pool.noPool * pool.yesPool) / (pool.noPool); }
  else                { pool.yesPool += amountPaise; pool.noPool  = (pool.yesPool * pool.noPool) / (pool.yesPool); }
  // Recalculate properly
  const k = pool.yesPool * pool.noPool;
  if (side === 'yes') {
    pool.noPool  += amountPaise;
    pool.yesPool  = k / pool.noPool;
  } else {
    pool.yesPool += amountPaise;
    pool.noPool   = k / pool.yesPool;
  }

  // Update market price + volume
  market.yesPrice   = Math.round(pool.yesPool / (pool.yesPool + pool.noPool) * 100);
  market.noPrice    = 100 - market.yesPrice;
  market.totalVolume += amountPaise;
  if (side === 'yes') market.yesVolume += amountPaise;
  else                market.noVolume  += amountPaise;

  // Create position record
  const position = {
    id:           `pos_${uuid().split('-')[0]}`,
    userId,
    marketId,
    marketTitle:  market.title,
    side,
    amountPaise,  // amount spent
    shares,       // shares received
    avgPriceCents,
    status:       'open',   // open | won | lost | cancelled
    payout:       null,     // filled on settlement
    createdAt:    new Date(),
  };

  positions.set(position.id, position);

  // Index by user
  if (!userPositions.has(userId)) userPositions.set(userId, []);
  userPositions.get(userId).push(position.id);

  return { position, newYesPrice: market.yesPrice, newNoPrice: market.noPrice };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SETTLEMENT ENGINE
// Called by admin when real-world outcome is known (match ends, votes counted)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a market. outcome = true (YES wins) | false (NO wins)
 * Pays out all winning positions. Losers get nothing.
 * Returns settlement summary.
 */
function resolveMarket(marketId, outcome, walletOps) {
  const market = getMarket(marketId);
  if (!market)                  throw Object.assign(new Error('Market not found'), { status: 404 });
  if (market.status === 'resolved') throw Object.assign(new Error('Already resolved'), { status: 400 });

  market.status     = 'resolved';
  market.outcome    = outcome;
  market.resolvedAt = new Date();

  const winningSide = outcome ? 'yes' : 'no';
  const summary = { marketId, outcome: winningSide, winners: 0, losers: 0, totalPayout: 0, positions: [] };

  // Find all positions for this market
  const mktPositions = [...positions.values()].filter(p => p.marketId === marketId && p.status === 'open');

  // Total pool for payout calculation
  const winningVolume = outcome ? market.yesVolume : market.noVolume;
  const totalVolume   = market.totalVolume;

  for (const pos of mktPositions) {
    if (pos.side === winningSide) {
      // Payout = proportional share of total pool
      // Winner gets their money back + their share of loser pool
      // payout = (pos.amountPaise / winningVolume) * totalVolume * 0.97  (3% platform fee)
      const grossPayout  = Math.floor((pos.amountPaise / winningVolume) * totalVolume);
      const platformFee  = Math.floor(grossPayout * 0.03);  // 3% fee
      const netPayout    = grossPayout - platformFee;

      pos.status = 'won';
      pos.payout = netPayout;

      walletOps.creditWallet(pos.userId, netPayout, `Won: "${market.title}" — ${winningSide.toUpperCase()} ✅`);

      summary.winners++;
      summary.totalPayout += netPayout;
      summary.positions.push({ userId: pos.userId, payout: netPayout, side: pos.side });
    } else {
      pos.status = 'lost';
      pos.payout = 0;
      summary.losers++;
      summary.positions.push({ userId: pos.userId, payout: 0, side: pos.side });
    }
  }

  return summary;
}

/**
 * Cancel a market (e.g. match abandoned). Refund everyone.
 */
function cancelMarket(marketId, walletOps) {
  const market = getMarket(marketId);
  if (!market) throw Object.assign(new Error('Market not found'), { status: 404 });

  market.status = 'cancelled';

  const mktPositions = [...positions.values()].filter(p => p.marketId === marketId && p.status === 'open');

  for (const pos of mktPositions) {
    pos.status = 'cancelled';
    pos.payout = pos.amountPaise;
    walletOps.creditWallet(pos.userId, pos.amountPaise, `Refund: "${market.title}" cancelled`);
  }

  return { cancelled: mktPositions.length };
}


// ═══════════════════════════════════════════════════════════════════════════════
// POSITIONS / PORTFOLIO
// ═══════════════════════════════════════════════════════════════════════════════

function getUserPositions(userId) {
  const ids = userPositions.get(userId) || [];
  return ids.map(id => positions.get(id)).filter(Boolean);
}

function getMarketPositions(marketId) {
  return [...positions.values()].filter(p => p.marketId === marketId);
}

function getUserPortfolio(userId) {
  const pos = getUserPositions(userId);

  const portfolio = {
    openPositions:   pos.filter(p => p.status === 'open'),
    wonPositions:    pos.filter(p => p.status === 'won'),
    lostPositions:   pos.filter(p => p.status === 'lost'),
    totalInvested:   pos.reduce((s, p) => s + p.amountPaise, 0),
    totalWon:        pos.filter(p => p.status === 'won').reduce((s, p) => s + (p.payout || 0), 0),
    totalLost:       pos.filter(p => p.status === 'lost').reduce((s, p) => s + p.amountPaise, 0),
  };

  portfolio.pnl      = portfolio.totalWon - portfolio.totalInvested;
  portfolio.winRate  = pos.length ? Math.round(portfolio.wonPositions.length / pos.length * 100) : 0;
  return portfolio;
}

function calcPreviewPayout(marketId, side, amountPaise) {
  const market = getMarket(marketId);
  if (!market) return null;

  const { shares, avgPriceCents } = calcShares(marketId, side, amountPaise);
  const potentialPayout = Math.floor(shares * 0.97); // 3% fee estimate

  return {
    amountPaise,
    shares,
    avgPriceCents,
    potentialPayout,
    potentialProfit: potentialPayout - amountPaise,
    roi: Math.round((potentialPayout - amountPaise) / amountPaise * 100),
  };
}


module.exports = {
  listMarkets, getMarket, createMarket,
  placeBet, resolveMarket, cancelMarket,
  getUserPositions, getMarketPositions, getUserPortfolio,
  calcPreviewPayout,
};
