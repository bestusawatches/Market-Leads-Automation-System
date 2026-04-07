import winston from "winston";
import { LOG_LEVEL } from "../config";

const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

export default logger;
