// db/supabase.js
// Drop-in replacement for db/index.js + db/markets.js
// Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env to activate

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service key for backend only — never expose to frontend
);

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET OPS
// ═══════════════════════════════════════════════════════════════════════════════

async function getWallet(userId) {
  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return data;
}

async function creditWallet(userId, amountPaise, note = '', refId = null) {
  const { data: wallet, error: wErr } = await supabase.rpc('credit_wallet', {
    p_user_id: userId, p_amount: amountPaise, p_note: note, p_ref_id: refId
  });
  if (wErr) throw wErr;
  return wallet;
}

async function debitWallet(userId, amountPaise, note = '') {
  const { data, error } = await supabase
    .from('wallets')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  if (data.balance < amountPaise) throw Object.assign(new Error('Insufficient balance'), { status: 400 });

  const { error: updateErr } = await supabase
    .from('wallets')
    .update({ balance: data.balance - amountPaise, updated_at: new Date() })
    .eq('user_id', userId);
  if (updateErr) throw updateErr;

  await supabase.from('transactions').insert({
    user_id: userId, type: 'debit', amount: amountPaise, note, status: 'success'
  });
}

async function getTxHistory(userId, limit = 20) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MARKETS
// ═══════════════════════════════════════════════════════════════════════════════

async function listMarkets({ category, status = 'open', limit = 20 } = {}) {
  let q = supabase.from('markets').select('*').eq('status', status).order('total_volume', { ascending: false }).limit(limit);
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function getMarket(marketId) {
  const { data, error } = await supabase.from('markets').select('*').eq('id', marketId).single();
  if (error) return null;
  return data;
}

async function createMarket({ title, description, category, closesAt, createdBy, tags = [] }) {
  const { data, error } = await supabase.from('markets').insert({
    title, description, category, tags,
    closes_at:  closesAt,
    created_by: createdBy,
    yes_price:  50, no_price: 50,
    yes_pool:   1000000, no_pool: 1000000,
  }).select().single();
  if (error) throw error;
  return data;
}


// ═══════════════════════════════════════════════════════════════════════════════
// BETTING — uses atomic SQL function place_bet()
// ═══════════════════════════════════════════════════════════════════════════════

async function placeBet(userId, marketId, side, amountPaise) {
  // Calls the atomic PostgreSQL function in schema.sql
  // Handles: balance check, wallet debit, pool update, position insert — all in one transaction
  const { data, error } = await supabase.rpc('place_bet', {
    p_user_id:   userId,
    p_market_id: marketId,
    p_side:      side,
    p_amount:    amountPaise,
  });
  if (error) throw Object.assign(new Error(error.message), { status: 400 });

  const market = await getMarket(marketId);
  return {
    position: {
      id:           data.position_id,
      userId,
      marketId,
      side,
      amountPaise,
      shares:       data.shares,
      avgPriceCents: data.avg_price,
      status:       'open',
    },
    newYesPrice: market.yes_price,
    newNoPrice:  market.no_price,
  };
}

async function calcPreviewPayout(marketId, side, amountPaise) {
  const market = await getMarket(marketId);
  if (!market) return null;

  const inPool  = side === 'yes' ? market.no_pool  : market.yes_pool;
  const outPool = side === 'yes' ? market.yes_pool : market.no_pool;
  const k       = inPool * outPool;
  const newIn   = inPool + amountPaise;
  const newOut  = Math.floor(k / newIn);
  const shares  = outPool - newOut;
  const payout  = Math.floor(shares * 0.97);

  return {
    amountPaise, shares,
    avgPriceCents: Math.round(amountPaise / shares * 100),
    potentialPayout: payout,
    potentialProfit: payout - amountPaise,
    roi: Math.round((payout - amountPaise) / amountPaise * 100),
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SETTLEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveMarket(marketId, outcome) {
  const { data, error } = await supabase.rpc('resolve_market', {
    p_market_id: marketId,
    p_outcome:   outcome,
  });
  if (error) throw Object.assign(new Error(error.message), { status: 400 });
  return data;
}

async function cancelMarket(marketId) {
  // Refund all open positions
  const { data: positions } = await supabase
    .from('positions')
    .select('*')
    .eq('market_id', marketId)
    .eq('status', 'open');

  for (const pos of (positions || [])) {
    await supabase.from('wallets')
      .update({ balance: supabase.sql`balance + ${pos.amount_paise}`, locked: supabase.sql`locked - ${pos.amount_paise}` })
      .eq('user_id', pos.user_id);
    await supabase.from('positions')
      .update({ status: 'cancelled', payout_paise: pos.amount_paise })
      .eq('id', pos.id);
  }

  await supabase.from('markets').update({ status: 'cancelled' }).eq('id', marketId);
  return { cancelled: (positions || []).length };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO
// ═══════════════════════════════════════════════════════════════════════════════

async function getUserPortfolio(userId) {
  const { data: positions, error } = await supabase
    .from('positions')
    .select('*, markets(title, category, status)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const open = positions.filter(p => p.status === 'open');
  const won  = positions.filter(p => p.status === 'won');
  const lost = positions.filter(p => p.status === 'lost');

  return {
    openPositions:  open,
    wonPositions:   won,
    lostPositions:  lost,
    totalInvested:  positions.reduce((s, p) => s + p.amount_paise, 0),
    totalWon:       won.reduce((s, p) => s + (p.payout_paise || 0), 0),
    totalLost:      lost.reduce((s, p) => s + p.amount_paise, 0),
    pnl:            won.reduce((s, p) => s + (p.payout_paise || 0), 0) - positions.reduce((s, p) => s + p.amount_paise, 0),
    winRate:        positions.length ? Math.round(won.length / positions.length * 100) : 0,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// RAZORPAY ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

async function saveOrder(order) {
  const { error } = await supabase.from('payment_orders').insert({
    id:           order.id,
    user_id:      order.userId,
    amount_paise: order.amountPaise,
    receipt:      order.receipt,
    status:       'created',
  });
  if (error) throw error;
}

async function getOrder(razorpayOrderId) {
  const { data, error } = await supabase
    .from('payment_orders')
    .select('*')
    .eq('id', razorpayOrderId)
    .single();
  if (error) return null;
  return { ...data, userId: data.user_id, amountPaise: data.amount_paise, paid: data.status === 'paid' };
}

async function markOrderPaid(razorpayOrderId, paymentId) {
  const { data, error } = await supabase
    .from('payment_orders')
    .update({ status: 'paid', razorpay_payment_id: paymentId, paid_at: new Date() })
    .eq('id', razorpayOrderId)
    .select()
    .single();
  if (error) throw error;
  return { ...data, paid: true, userId: data.user_id, amountPaise: data.amount_paise };
}

async function getUser(userId) {
  const { data } = await supabase.from('users').select('*').eq('id', userId).single();
  return data;
}


module.exports = {
  supabase,
  getUser, getWallet, creditWallet, debitWallet, getTxHistory,
  listMarkets, getMarket, createMarket,
  placeBet, calcPreviewPayout,
  resolveMarket, cancelMarket,
  getUserPortfolio,
  saveOrder, getOrder, markOrderPaid,
};
