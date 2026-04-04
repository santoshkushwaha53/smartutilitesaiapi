// Keep this tiny and extend if you use other models later.
const PRICES = {
  'gpt-4o-mini': { in: 0.15/1e6, out: 0.60/1e6 }, // $ per token
  // 'gpt-4.1': { in: X/1e6, out: Y/1e6 }, // example
};

export function estimateCostUSD(model, usage = {}) {
  const p = PRICES[model];
  if (!p) return null;
  const inTok  = usage.input_tokens  || 0;
  const outTok = usage.output_tokens || 0;
  return +(inTok  * p.in + outTok * p.out).toFixed(6);
}

