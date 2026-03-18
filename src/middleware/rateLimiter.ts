import rateLimit from 'express-rate-limit';

const createLimiter = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message } },
    skip: () => process.env.NODE_ENV === 'test',
  });

export const rateLimiter = {
  // General API: 200 req / 5 min
  general: createLimiter(5 * 60 * 1000, 200, 'Too many requests, please slow down'),
  // Auth endpoints: 20 attempts / 15 min
  auth: createLimiter(15 * 60 * 1000, 20, 'Too many auth attempts, try again later'),
  // Upload init: 30 per 5 min (heavier operation)
  upload: createLimiter(5 * 60 * 1000, 30, 'Upload rate limit reached'),
};
