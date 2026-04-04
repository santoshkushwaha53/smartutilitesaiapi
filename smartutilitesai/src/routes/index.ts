import { Router } from "express";
import authRoutes from "./auth.route.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "smartutilitesai API is running"
  });
});

router.use("/auth", authRoutes);

export default router;
