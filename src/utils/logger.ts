import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, label, ...meta }) => {
      return JSON.stringify({
        timestamp,
        level,
        message,
        label,
        ...meta
      });
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, label, ...meta }) => {
          return `${timestamp} [${level}] ${label ? `[${label}] ` : ''}${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
      ),
    }),
  ],
});

// Instead of modifying the logger directly, create a custom wrapper
const customLogger = {
  info: (message: string, ...meta: any[]) => logger.info(message, ...meta),
  error: (message: string, ...meta: any[]) => logger.error(message, ...meta),
  warn: (message: string, ...meta: any[]) => logger.warn(message, ...meta),
  debug: (message: string, ...meta: any[]) => logger.debug(message, ...meta)
};

export default customLogger; 