const express = require("express");
const { scanWebsiteSafety } = require("../services/website-safety.service");

const router = express.Router();

router.post("/check", async function (req, res) {
  try {
    const url = String((req.body && req.body.url) || "").trim();

    if (!url) {
      return res.status(400).json({
        message: "URL is required.",
      });
    }

    const result = await scanWebsiteSafety(url);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      message:
        error && error.message ? error.message : "Website safety scan failed.",
    });
  }
});

module.exports = router;