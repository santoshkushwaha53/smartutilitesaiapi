import { Router, type Response } from "express";
import { userService } from "../services/user.service.js";
import {
  authMiddleware,
  generateToken,
  type AuthRequest,
} from "../core/middlewares/auth.middleware.js";

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 * Body: { email, password, name? }
 */
router.post("/register", async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({
        error: "Email and password are required",
      });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({
        error: "Password must be at least 6 characters",
      });
      return;
    }

    const result = await userService.createUser(email, password, name);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    const token = generateToken(result.user.id, result.user.email);

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: result.user,
    });
    return;
  } catch (error: any) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Internal server error" });
    return;
  }
});

/**
 * POST /api/auth/login
 * Login user and return JWT token
 * Body: { email, password }
 */
router.post("/login", async (req: AuthRequest, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        error: "Email and password are required",
      });
      return;
    }

    const result = await userService.validatePassword(email, password);

    if (!result.valid || !result.user) {
      res.status(401).json({
        error: "Invalid email or password",
      });
      return;
    }

    const token = generateToken(result.user.id, result.user.email);

    res.status(200).json({
      message: "Login successful",
      token,
      user: result.user,
    });
    return;
  } catch (error: any) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
    return;
  }
});

/**
 * GET /api/auth/me
 * Get current user profile (requires authentication)
 */
router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await userService.getUserById(req.userId!);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({ user });
    return;
  } catch (error: any) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Internal server error" });
    return;
  }
});

/**
 * POST /api/auth/logout
 * Logout user (client-side token removal)
 */
router.post("/logout", (_req, res: Response) => {
  res.status(200).json({
    message: "Logout successful",
  });
});

export default router;