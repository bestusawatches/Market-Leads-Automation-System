import express, { Express, Request, Response, NextFunction } from "express";
import { logger } from "./utils/logger";

const app: Express = express();

// ── Middleware ───────────────────────────────────────────────────────────────

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/api/healthcheck", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", message: "Server is running" });
});

// API v1 routes
import apiRoutes from "./api";
app.use("/api/v1", apiRoutes);

// Root redirect to API documentation
app.get("/", (req: Request, res: Response) => {
  res.redirect("/api/v1/properties");
});

// ── Error Handling ───────────────────────────────────────────────────────────

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    status: "error",
    message: "Route not found",
  });
});

// Global error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Error: ${err.message}`, err);

  res.status(err.statusCode || 500).json({
    status: "error",
    message: err.message || "Internal server error",
  });
});

export default app;
