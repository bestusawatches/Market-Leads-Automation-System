import dotenv from "dotenv";
dotenv.config();

export const DATABASE_URL = process.env.DATABASE_URL || "file:./dev.db";
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
