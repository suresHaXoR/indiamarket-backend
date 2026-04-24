const { TEST_USER_ID } = require('../db');

/**
 * Auth middleware.
 * In production: verify a JWT from Authorization header.
 * For now: accepts `x-user-id` header (easy for testing).
 */
function auth(req, res, next) {
  // ── Production: uncomment and use JWT ───────────────────────────────────
  // const token = req.headers.authorization?.split(' ')[1];
  // if (!token) return res.status(401).json({ error: 'No token' });
  // try {
  //   const payload = jwt.verify(token, process.env.JWT_SECRET);
  //   req.userId = payload.sub;
  //   next();
  // } catch {
  //   return res.status(401).json({ error: 'Invalid token' });
  // }

  // ── Dev: use header or fallback to test user ─────────────────────────────
  req.userId = req.headers['x-user-id'] || TEST_USER_ID;
  next();
}

module.exports = { auth };
