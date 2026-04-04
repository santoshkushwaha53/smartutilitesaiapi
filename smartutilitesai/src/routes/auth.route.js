const express = require("express");
const { userService } = require("../services/user.service");
const {
  authMiddleware,
  generateToken,
} = require("../core/middlewares/auth.middleware");

const router = express.Router();

/**
 * POST /api/auth/register
 * Register a new user
 * Body: { email, password, name? }
 */
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const result = await userService.createUser(email, password, name);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const token = generateToken(result.user.id, result.user.email);

    return res.status(201).json({
      message: "User registered successfully",
      token,
      user: result.user,
    });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/auth/login
 * Login user and return JWT token
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const result = await userService.validatePassword(email, password);

    if (!result.valid || !result.user) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const token = generateToken(result.user.id, result.user.email);

    return res.status(200).json({
      message: "Login successful",
      token,
      user: result.user,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/auth/me
 * Get current user profile (requires authentication)
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await userService.getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({
      user,
    });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/auth/logout
 * Logout user (client-side token removal)
 */
router.post("/logout", (req, res) => {
  // Token invalidation typically happens on the client side
  // For production, consider using a token blacklist or redis
  return res.status(200).json({
    message: "Logout successful",
  });
});

module.exports = router;
