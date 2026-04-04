// src/middleware/auth.js
import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // 🔹 Normalise what we store on req.user
    // your JWT payload has: sub, email, role, iat, exp
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role || 'user',
      // keep raw if you ever need it:
      _raw: payload,
    };

    next();
  } catch (err) {
    console.error('JWT verify failed:', err.message);
    res.status(401).json({ error: 'invalid_token' });
  }
}

// 🔹 NEW: only allow admin role
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
