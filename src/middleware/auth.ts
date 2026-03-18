import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db';
import type { JwtPayload, User } from '../types';

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Accept token from httpOnly cookie OR Authorization header
    const token =
      req.cookies?.access_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    const { rows } = await query<User>(
      'SELECT id, email, name, image_url as "imageUrl", provider, created_at as "createdAt", updated_at as "updatedAt" FROM users WHERE id = $1',
      [payload.sub]
    );

    if (!rows[0]) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: { code: 'TOKEN_EXPIRED', message: 'Access token expired' } });
      return;
    }
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid token' } });
  }
};

// Optional auth — attaches user if token present, continues even if not
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token =
      req.cookies?.access_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      const { rows } = await query<User>(
        'SELECT id, email, name, image_url as "imageUrl", provider, created_at as "createdAt", updated_at as "updatedAt" FROM users WHERE id = $1',
        [payload.sub]
      );
      if (rows[0]) req.user = rows[0];
    }
  } catch {
    // Silently continue without user
  }
  next();
};
