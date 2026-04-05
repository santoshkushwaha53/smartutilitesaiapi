import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  userId?: number;
  user?: {
    id: number;
    email: string;
    name?: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";

export const generateToken = (userId: number, email: string) => {
  return jwt.sign({ userId, email }, JWT_SECRET, {
    expiresIn: "7d",
  });
};

export const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: number;
      email: string;
    };
    req.userId = decoded.userId;
    req.user = { id: decoded.userId, email: decoded.email };

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
