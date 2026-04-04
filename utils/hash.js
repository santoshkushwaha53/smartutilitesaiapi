// utils/hash.js
import crypto from 'crypto';

export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  return Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = canonicalize(obj[k]);
    return acc;
  }, {});
}

export function hashRequest(endpoint, params = {}) {
  const canonical = JSON.stringify(canonicalize(params));
  return crypto.createHash('sha256').update(`${endpoint}|${canonical}`).digest('hex');
}
