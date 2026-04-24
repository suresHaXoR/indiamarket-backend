// routes/auth.js
// Phone OTP login via Supabase Auth (or in-memory for dev)
// Flow: POST /send-otp → POST /verify-otp → JWT returned

const router  = require('express').Router();
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const JWT_SECRET  = process.env.JWT_SECRET || 'dev_secret_change_in_prod';
const JWT_EXPIRES = '7d';

// ── In-memory OTP store (swap with Redis in production) ────────────────────
// { phone → { otp, expiresAt, attempts } }
const otpStore = new Map();

// ── In-memory user store (swap with Supabase) ──────────────────────────────
const userStore = new Map(); // phone → { id, name, phone, kycStatus, createdAt }

// ── Rate limiter per phone (5 OTPs per hour) ──────────────────────────────
const otpRateLimit = new Map(); // phone → { count, windowStart }

function checkOtpRate(phone) {
  const now    = Date.now();
  const entry  = otpRateLimit.get(phone) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 3600000) { // reset after 1 hour
    otpRateLimit.set(phone, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= 5) return false; // too many
  entry.count++;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/auth/send-otp
// Body: { phone: "9876543210" }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/send-otp', async (req, res, next) => {
  try {
    let { phone } = req.body;

    // Normalize: strip +91 / spaces
    phone = phone?.toString().replace(/\s/g, '').replace(/^\+91/, '').trim();

    if (!phone || !/^[6-9]\d{9}$/.test(phone))
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });

    if (!checkOtpRate(phone))
      return res.status(429).json({ error: 'Too many OTP requests. Try again in 1 hour.' });

    // Generate 6-digit OTP
    const otp       = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min

    otpStore.set(phone, { otp, expiresAt, attempts: 0 });

    // ── Send OTP via SMS ──────────────────────────────────────────────────
    // OPTION 1: Fast2SMS (cheapest for India, free trial ₹50 credit)
    if (process.env.FAST2SMS_KEY && process.env.NODE_ENV === 'production') {
      const smsRes = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          authorization: process.env.FAST2SMS_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          route:           'otp',
          variables_values: otp,
          numbers:          phone,
          flash:            0
        })
      });
      const smsData = await smsRes.json();
      if (!smsData.return) throw new Error('SMS failed: ' + smsData.message);
    }

    // OPTION 2: Supabase Auth (handles everything automatically)
    // const { error } = await supabase.auth.signInWithOtp({ phone: '+91' + phone });
    // if (error) throw new Error(error.message);
    // (remove otp generation above if using Supabase — it generates OTP internally)

    // OPTION 3: MSG91 (enterprise)
    // await fetch(`https://api.msg91.com/api/v5/otp?template_id=${TEMPLATE}&mobile=91${phone}&authkey=${MSG91_KEY}`)

    console.log(`\n📱 OTP for +91${phone}: ${otp} (expires in 10 min)\n`);

    res.json({
      success:    true,
      phone:      '+91' + phone.slice(0, 3) + '****' + phone.slice(-3), // masked
      expiresIn:  600, // seconds
      // In dev only — remove in production:
      ...(process.env.NODE_ENV !== 'production' && { _devOtp: otp })
    });

  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-otp
// Body: { phone: "9876543210", otp: "123456", name?: "Haxor" }
// Returns: { token, user, isNewUser }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/verify-otp', (req, res, next) => {
  try {
    let { phone, otp, name } = req.body;
    phone = phone?.toString().replace(/\s/g, '').replace(/^\+91/, '').trim();

    if (!phone || !otp)
      return res.status(400).json({ error: 'Phone and OTP are required' });

    const record = otpStore.get(phone);

    if (!record)
      return res.status(400).json({ error: 'No OTP sent to this number. Request a new one.' });

    if (Date.now() > record.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }

    // Max 3 wrong attempts
    record.attempts++;
    if (record.attempts > 3) {
      otpStore.delete(phone);
      return res.status(400).json({ error: 'Too many wrong attempts. Request a new OTP.' });
    }

    if (record.otp !== otp.toString().trim())
      return res.status(400).json({
        error:           'Wrong OTP',
        attemptsLeft:    3 - record.attempts
      });

    // ✅ OTP correct — clear it
    otpStore.delete(phone);

    // Get or create user
    const isNewUser = !userStore.has(phone);
    if (isNewUser) {
      userStore.set(phone, {
        id:        uuid(),
        phone,
        name:      name || 'User',
        kycStatus: 'pending',
        createdAt: new Date(),
      });
    }

    const user = userStore.get(phone);

    // Sign JWT
    const token = jwt.sign(
      { sub: user.id, phone: user.phone, iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      success:   true,
      token,
      expiresIn: 7 * 24 * 3600, // 7 days in seconds
      isNewUser,
      user: {
        id:        user.id,
        phone:     '+91' + phone,
        name:      user.name,
        kycStatus: user.kycStatus,
      }
    });

  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// Header: Authorization: Bearer <token>
// ──────────────────────────────────────────────────────────────────────────────
router.post('/refresh', (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const payload = jwt.verify(token, JWT_SECRET);
    const user    = [...userStore.values()].find(u => u.id === payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const newToken = jwt.sign(
      { sub: user.id, phone: user.phone },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({ token: newToken, expiresIn: 7 * 24 * 3600 });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// Header: Authorization: Bearer <token>
// ──────────────────────────────────────────────────────────────────────────────
router.get('/me', (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const payload = jwt.verify(token, JWT_SECRET);
    const user    = [...userStore.values()].find(u => u.id === payload.sub);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      id:        user.id,
      phone:     '+91' + user.phone,
      name:      user.name,
      kycStatus: user.kycStatus,
      createdAt: user.createdAt,
    });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Middleware export — use in other routes
// ──────────────────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.headers['x-user-id'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  // Allow x-user-id dev header
  if (!token.includes('.')) { req.userId = token; return next(); }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId    = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token. Please login again.' });
  }
}

module.exports = router;
module.exports.authMiddleware = authMiddleware;
