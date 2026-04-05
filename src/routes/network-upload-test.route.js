const express = require("express");

const router = express.Router();

/**
 * Upload test endpoint
 * Accepts raw binary payload and returns received byte count.
 * This is enough for browser-side upload speed measurement.
 */
router.post(
  "/api/network/upload-test",
  express.raw({
    type: "*/*",
    limit: "64mb",
  }),
  (req, res) => {
    const receivedBytes = req.body ? req.body.length : 0;

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    return res.status(200).json({
      ok: true,
      receivedBytes,
      receivedAt: new Date().toISOString(),
    });
  }
);

module.exports = router;