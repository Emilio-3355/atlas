import winston from 'winston';
import { getEnv } from '../config/env.js';

const logger = winston.createLogger({
  level: getEnv().LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    getEnv().NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), winston.format.simple())
  ),
  defaultMeta: { service: 'atlas' },
  transports: [new winston.transports.Console()],
});

export default logger;
