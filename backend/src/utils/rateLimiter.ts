import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { Request, Response, NextFunction } from 'express';

// Chat: 10 requests per 60 seconds per authenticated user
export const chatLimiter = new RateLimiterMemory({
  points: 10,
  duration: 60,
});

// Auth endpoints: 5 requests per 60 seconds per IP
export const authLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60,
});

// Document upload: 5 requests per 60 seconds per authenticated user
export const uploadLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60,
});

// Telegram webhook: 30 requests per 60 seconds per IP
export const telegramLimiter = new RateLimiterMemory({
  points: 30,
  duration: 60,
});

/**
 * Express middleware factory.
 * @param limiter - The RateLimiterMemory instance to consume from
 * @param keyFn  - Function that extracts the rate-limit key from the request
 */
export function rateLimitMiddleware(
  limiter: RateLimiterMemory,
  keyFn: (req: Request) => string
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await limiter.consume(keyFn(req));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(err.msBeforeNext / 1000);
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
      next(err);
    }
  };
}
