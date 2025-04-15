import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, label, ...meta }) => {
      return JSON.stringify({
        timestamp,
        level,
        message,
        label,
        ...meta,
      });
    }),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          ({ timestamp, level, message, label, ...meta }) => {
            return `${timestamp} [${level}] ${label ? `[${label}] ` : ""}${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`;
          },
        ),
      ),
    }),
  ],
});

// Define more specific type for meta parameters
type LogMeta = Record<string, unknown>;

// Create a custom wrapper with explicit return types
const customLogger = {
  info: (message: string, meta?: LogMeta): winston.Logger =>
    logger.info(message, meta),
  error: (message: string, meta?: LogMeta): winston.Logger =>
    logger.error(message, meta),
  warn: (message: string, meta?: LogMeta): winston.Logger =>
    logger.warn(message, meta),
  debug: (message: string, meta?: LogMeta): winston.Logger =>
    logger.debug(message, meta),
};

export default customLogger;
