// ─────────────────────────────────────────────────────────────────────────────
// db/index.js  —  In-memory store for dev / easy swap for Supabase/Postgres
//
// To switch to Supabase, replace each function body with a Supabase query.
// The API surface stays identical — routes don't change at all.
// ─────────────────────────────────────────────────────────────────────────────

const { v4: uuid } = require('uuid');

// ── In-memory tables ─────────────────────────────────────────────────────────
const users = new Map();       // userId → { id, name, phone, kycStatus, upiId }
const wallets = new Map();     // userId → { balance, locked }
const transactions = [];       // array of tx objects
const orders = new Map();      // razorpayOrderId → order object

// ── Seed a test user ─────────────────────────────────────────────────────────
const TEST_USER_ID = 'user_haxor_001';
users.set(TEST_USER_ID, {
  id: TEST_USER_ID,
  name: 'Haxor',
  phone: '9876543210',
  kycStatus: 'verified',   // pending | basic | verified
  upiId: 'haxor@okaxis'
});
wallets.set(TEST_USER_ID, { balance: 384000, locked: 56000 }); // paise

// ── User ─────────────────────────────────────────────────────────────────────
function getUser(userId) {
  return users.get(userId) || null;
}

// ── Wallet ───────────────────────────────────────────────────────────────────
function getWallet(userId) {
  if (!wallets.has(userId)) wallets.set(userId, { balance: 0, locked: 0 });
  return wallets.get(userId);
}

function creditWallet(userId, amountPaise, note = '') {
  const w = getWallet(userId);
  w.balance += amountPaise;
  _addTx({ userId, type: 'credit', amount: amountPaise, note, status: 'success' });
  return w;
}

function debitWallet(userId, amountPaise, note = '') {
  const w = getWallet(userId);
  if (w.balance < amountPaise) throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  w.balance -= amountPaise;
  _addTx({ userId, type: 'debit', amount: amountPaise, note, status: 'success' });
  return w;
}

function lockFunds(userId, amountPaise) {
  const w = getWallet(userId);
  if (w.balance < amountPaise) throw Object.assign(new Error('Insufficient balance to lock'), { status: 400 });
  w.balance -= amountPaise;
  w.locked += amountPaise;
  return w;
}

function unlockFunds(userId, amountPaise, credit = false) {
  const w = getWallet(userId);
  w.locked -= amountPaise;
  if (credit) w.balance += amountPaise; // return locked funds (e.g. lost bet = don't credit)
  return w;
}

// ── Transactions ─────────────────────────────────────────────────────────────
function _addTx(data) {
  transactions.unshift({ id: uuid(), createdAt: new Date(), ...data });
}

function getTxHistory(userId, limit = 20) {
  return transactions.filter(t => t.userId === userId).slice(0, limit);
}

// ── Razorpay Orders ───────────────────────────────────────────────────────────
function saveOrder(order) {
  orders.set(order.id, { ...order, createdAt: new Date(), paid: false });
}

function getOrder(razorpayOrderId) {
  return orders.get(razorpayOrderId) || null;
}

function markOrderPaid(razorpayOrderId, paymentId) {
  const o = orders.get(razorpayOrderId);
  if (o) { o.paid = true; o.paymentId = paymentId; o.paidAt = new Date(); }
  return o;
}

// ── Withdrawals ───────────────────────────────────────────────────────────────
const withdrawals = [];

function createWithdrawal(userId, amountPaise, upiId) {
  const w = { id: uuid(), userId, amountPaise, upiId, status: 'pending', createdAt: new Date() };
  withdrawals.push(w);
  _addTx({ userId, type: 'debit', amount: amountPaise, note: `Withdrawal to ${upiId}`, status: 'pending' });
  return w;
}

function getWithdrawals(userId) {
  return withdrawals.filter(w => w.userId === userId);
}

module.exports = {
  getUser, getWallet,
  creditWallet, debitWallet, lockFunds, unlockFunds,
  getTxHistory, saveOrder, getOrder, markOrderPaid,
  createWithdrawal, getWithdrawals,
  TEST_USER_ID
};
