import { Router } from "express";
import seoRoutes from "../modules/seo/seo.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "smartutilitesai API is running"
  });
});

router.use("/seo", seoRoutes);

export default router;
