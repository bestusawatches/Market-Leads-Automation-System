import "dotenv/config";
import app from "./app";
import { logger } from "./utils/logger";
import { prisma } from "./db/client";
import { cronManager } from "./utils/cronManager";
import { initializeDailyScrapeJob } from "./jobs/daily-scrape.job";

const PORT = process.env.PORT || 3005;

async function startServer() {
  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;
    logger.info("✓ Database connected");

    // Start Express server
    const server = app.listen(PORT, () => {
      logger.info(`✓ Server listening on http://localhost:${PORT}`);
      logger.info(`✓ Properties endpoint: GET http://localhost:${PORT}/api/v1/properties`);
    });

      // Initialize cron jobs and start cron manager
      try {
        initializeDailyScrapeJob();
        cronManager.startAll();
      } catch (err) {
        logger.error("Failed to initialize cron jobs:", err);
      }

    // Graceful shutdown
    process.on("SIGTERM", async () => {
      logger.info("SIGTERM received, shutting down gracefully...");
      server.close(async () => {
        await prisma.$disconnect();
        logger.info("Server closed");
        process.exit(0);
      });
    });

    process.on("SIGINT", async () => {
      logger.info("SIGINT received, shutting down gracefully...");
      server.close(async () => {
        await prisma.$disconnect();
        logger.info("Server closed");
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

startServer();
