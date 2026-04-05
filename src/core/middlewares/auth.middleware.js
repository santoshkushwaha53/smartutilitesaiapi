const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

const generateToken = (userId, email) => {
  return jwt.sign({ userId, email }, JWT_SECRET, {
    expiresIn: "7d",
  });
};

const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.user = { id: decoded.userId, email: decoded.email };

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

module.exports = {
  generateToken,
  authMiddleware,
};
