const express = require('express');
const {
  getCurrencies,
  getLatestRate,
  getHistory,
  getForecast
} = require('../services/currency.service');

const router = express.Router();

function sendError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    success: false,
    error: error?.message || 'Unexpected server error.'
  });
}

router.get('/currencies', async (req, res) => {
  try {
    const result = await getCurrencies();
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/latest', async (req, res) => {
  try {
    const result = await getLatestRate({
      base: req.query.base,
      quote: req.query.quote,
      amount: req.query.amount || 1
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/history', async (req, res) => {
  try {
    const result = await getHistory({
      base: req.query.base,
      quote: req.query.quote,
      range: req.query.range,
      from: req.query.from,
      to: req.query.to
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/forecast', async (req, res) => {
  try {
    const result = await getForecast({
      base: req.query.base,
      quote: req.query.quote,
      days: req.query.days || 30,
      lookback: req.query.lookback || 180,
      confidence: req.query.confidence || 0.8
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
