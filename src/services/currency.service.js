const axios = require('axios');

const API_BASE = process.env.FRANKFURTER_API_BASE || 'https://api.frankfurter.dev/v1';
const REQUEST_TIMEOUT_MS = Number(process.env.CURRENCY_TIMEOUT_MS || 15000);

const http = axios.create({
  baseURL: API_BASE,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'smartutilitiesai-currency-api/1.0'
  }
});

function assertCurrency(code, fieldName) {
  const value = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    const error = new Error(`${fieldName} must be a valid 3-letter ISO currency code.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function assertPositiveAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const error = new Error('amount must be a number greater than 0.');
    error.status = 400;
    throw error;
  }
  return parsed;
}

function assertPositiveInteger(value, fieldName, min = 1, max = 365) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${fieldName} must be an integer between ${min} and ${max}.`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function formatDateOnly(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shiftUtcDays(date, days) {
  const clone = new Date(date);
  clone.setUTCDate(clone.getUTCDate() + days);
  return clone;
}

function resolveRangeToDates(range) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const map = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '180d': 180,
    '1y': 365,
    '2y': 730,
    '5y': 1825
  };

  const normalized = String(range || '90d').trim().toLowerCase();
  const days = map[normalized];
  if (!days) {
    const error = new Error('range must be one of: 7d, 30d, 90d, 180d, 1y, 2y, 5y.');
    error.status = 400;
    throw error;
  }

  const start = shiftUtcDays(end, -(days - 1));
  return {
    range: normalized,
    from: formatDateOnly(start),
    to: formatDateOnly(end),
    totalDays: days
  };
}

function computeStats(points) {
  if (!points.length) {
    return {
      high: null,
      low: null,
      average: null,
      changePct: null,
      changeValue: null,
      volatility: null
    };
  }

  const values = points.map((p) => p.rate);
  const first = values[0];
  const last = values[values.length - 1];
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  const volatility = Math.sqrt(variance);

  return {
    high: Number(Math.max(...values).toFixed(6)),
    low: Number(Math.min(...values).toFixed(6)),
    average: Number(average.toFixed(6)),
    changePct: first ? Number((((last - first) / first) * 100).toFixed(4)) : null,
    changeValue: Number((last - first).toFixed(6)),
    volatility: Number(volatility.toFixed(6))
  };
}

function normalZForConfidence(confidence) {
  if (confidence >= 0.99) return 2.576;
  if (confidence >= 0.95) return 1.96;
  if (confidence >= 0.9) return 1.645;
  return 1.282; // ~80%
}

function fitLinearRegression(points) {
  const n = points.length;
  if (n < 2) {
    const error = new Error('Not enough history to generate a forecast.');
    error.status = 422;
    throw error;
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i += 1) {
    const x = i;
    const y = points[i].rate;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  const residualVariance = points.reduce((sum, point, index) => {
    const predicted = intercept + slope * index;
    return sum + Math.pow(point.rate - predicted, 2);
  }, 0) / Math.max(1, n - 2);

  const residualStdDev = Math.sqrt(Math.max(0, residualVariance));

  return {
    intercept,
    slope,
    residualStdDev
  };
}

async function upstreamGet(url, config = {}) {
  try {
    const response = await http.get(url, config);
    return response.data;
  } catch (error) {
    if (error.response) {
      const message =
        error.response.data?.message ||
        error.response.data?.error ||
        'Upstream exchange-rate service returned an error.';
      const wrapped = new Error(message);
      wrapped.status = error.response.status === 404 ? 404 : 502;
      throw wrapped;
    }

    const wrapped = new Error('Could not reach the exchange-rate provider.');
    wrapped.status = 502;
    throw wrapped;
  }
}

async function getCurrencies() {
  const data = await upstreamGet('/currencies');

  const currencies = Object.entries(data)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    source: 'Frankfurter v1 (ECB-backed reference rates)',
    count: currencies.length,
    currencies
  };
}

async function getLatestRate({ base, quote, amount = 1 }) {
  const normalizedBase = assertCurrency(base, 'base');
  const normalizedQuote = assertCurrency(quote, 'quote');
  const normalizedAmount = assertPositiveAmount(amount);

  if (normalizedBase === normalizedQuote) {
    return {
      base: normalizedBase,
      quote: normalizedQuote,
      amount: normalizedAmount,
      rate: 1,
      convertedAmount: Number(normalizedAmount.toFixed(6)),
      updatedAt: new Date().toISOString(),
      source: 'Identity conversion',
      type: 'reference'
    };
  }

  const data = await upstreamGet('/latest', {
    params: {
      base: normalizedBase,
      symbols: normalizedQuote
    }
  });

  const rate = data?.rates?.[normalizedQuote];
  if (!Number.isFinite(rate)) {
    const error = new Error(`No exchange rate found for ${normalizedBase}/${normalizedQuote}.`);
    error.status = 404;
    throw error;
  }

  return {
    base: normalizedBase,
    quote: normalizedQuote,
    amount: normalizedAmount,
    rate: Number(rate),
    convertedAmount: Number((normalizedAmount * Number(rate)).toFixed(6)),
    updatedAt: data.date,
    source: 'Frankfurter v1 (ECB-backed reference rates)',
    type: 'reference'
  };
}

async function getHistory({ base, quote, range, from, to }) {
  const normalizedBase = assertCurrency(base, 'base');
  const normalizedQuote = assertCurrency(quote, 'quote');

  let startDate;
  let endDate;
  let normalizedRange = null;

  if (from || to) {
    if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
      const error = new Error('from and to must be in YYYY-MM-DD format.');
      error.status = 400;
      throw error;
    }
    startDate = from;
    endDate = to;
  } else {
    const resolved = resolveRangeToDates(range || '90d');
    normalizedRange = resolved.range;
    startDate = resolved.from;
    endDate = resolved.to;
  }

  const data = await upstreamGet(`/${startDate}..${endDate}`, {
    params: {
      base: normalizedBase,
      symbols: normalizedQuote
    }
  });

  const rawRates = data?.rates || {};
  const points = Object.keys(rawRates)
    .sort()
    .map((date) => ({
      date,
      rate: Number(rawRates[date]?.[normalizedQuote])
    }))
    .filter((point) => Number.isFinite(point.rate));

  if (!points.length) {
    const error = new Error(`No historical exchange rates found for ${normalizedBase}/${normalizedQuote}.`);
    error.status = 404;
    throw error;
  }

  return {
    base: normalizedBase,
    quote: normalizedQuote,
    range: normalizedRange,
    from: points[0].date,
    to: points[points.length - 1].date,
    source: 'Frankfurter v1 (ECB-backed reference rates)',
    points,
    stats: computeStats(points)
  };
}

async function getForecast({ base, quote, days = 30, confidence = 0.8, lookback = 180 }) {
  const normalizedBase = assertCurrency(base, 'base');
  const normalizedQuote = assertCurrency(quote, 'quote');
  const normalizedDays = assertPositiveInteger(days, 'days', 1, 180);
  const normalizedLookback = assertPositiveInteger(lookback, 'lookback', 30, 1825);
  const normalizedConfidence = Number(confidence);

  if (!Number.isFinite(normalizedConfidence) || normalizedConfidence < 0.5 || normalizedConfidence > 0.99) {
    const error = new Error('confidence must be a number between 0.5 and 0.99.');
    error.status = 400;
    throw error;
  }

  const today = new Date();
  const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const startDate = shiftUtcDays(endDate, -(normalizedLookback - 1));

  const history = await getHistory({
    base: normalizedBase,
    quote: normalizedQuote,
    from: formatDateOnly(startDate),
    to: formatDateOnly(endDate)
  });

  if (history.points.length < 20) {
    const error = new Error('Not enough historical data points to generate a forecast.');
    error.status = 422;
    throw error;
  }

  const model = fitLinearRegression(history.points);
  const z = normalZForConfidence(normalizedConfidence);
  const n = history.points.length;
  const lastDate = new Date(`${history.to}T00:00:00Z`);

  const points = [];
  for (let step = 1; step <= normalizedDays; step += 1) {
    const date = shiftUtcDays(lastDate, step);
    const x = n - 1 + step;
    const predicted = model.intercept + model.slope * x;
    const interval = z * model.residualStdDev * Math.sqrt(1 + step / Math.max(1, n));

    points.push({
      date: formatDateOnly(date),
      predicted: Number(predicted.toFixed(6)),
      lower: Number((predicted - interval).toFixed(6)),
      upper: Number((predicted + interval).toFixed(6))
    });
  }

  return {
    base: normalizedBase,
    quote: normalizedQuote,
    days: normalizedDays,
    confidence: normalizedConfidence,
    source: 'Calculated by SmartUtilitiesAI from historical Frankfurter/ECB reference-rate data',
    model: {
      name: 'linear_regression_with_residual_band',
      lookbackDaysRequested: normalizedLookback,
      historyPointsUsed: history.points.length,
      historyFrom: history.from,
      historyTo: history.to,
      slopePerStep: Number(model.slope.toFixed(8)),
      residualStdDev: Number(model.residualStdDev.toFixed(8))
    },
    points,
    disclaimer:
      'Forecast estimate only. It is computed from historical reference rates and is not an official future exchange rate or financial advice.'
  };
}

module.exports = {
  getCurrencies,
  getLatestRate,
  getHistory,
  getForecast
};
