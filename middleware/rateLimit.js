const { clientIp, wantsJson } = require("../utils/http");

// Fixed-window, in-memory rate limiter. The gateway is a single process (PM2 instances: 1), so a per-process map is
// enough; it is bounded and swept so it cannot grow without limit.
const MAX_KEYS = 50000;

function rateLimit({ name, windowMs, max, key = req => (req.session && req.session.user ? `u:${req.session.user.id}` : `ip:${clientIp(req)}`), message = "Çok fazla istek gönderdiniz. Lütfen biraz bekleyip tekrar deneyin." }) {
  const hits = new Map();

  function sweep(now) {
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k);
    }
  }

  return function limiter(req, res, next) {
    const now = Date.now();
    if (hits.size > MAX_KEYS) sweep(now);
    const k = `${name}:${key(req)}`;
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      if (wantsJson(req)) return res.status(429).json({ success: false, message });
      return res.status(429).send(message);
    }
    next();
  };
}

module.exports = { rateLimit };
