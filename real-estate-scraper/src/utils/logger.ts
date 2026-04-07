// src/utils/logger.ts
import winston from "winston";
import path from "path";
import fs from "fs";

const logDir = path.resolve(process.cwd(), "logs");
fs.mkdirSync(logDir, { recursive: true });

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) =>
      stack
        ? `${timestamp} | ${level.toUpperCase()} | ${message}\n${stack}`
        : `${timestamp} | ${level.toUpperCase()} | ${message}`
    )
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }) => `${level}: ${message}`)
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, "scraper.log"),
      maxsize: 1024 * 1024, // 1 MB
      maxFiles: 7,
    }),
  ],
});
