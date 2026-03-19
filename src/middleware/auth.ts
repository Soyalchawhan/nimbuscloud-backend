import { Request, Response, NextFunction } from 'express';
import { query } from '../db';
import type { User } from '../types';

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const jwt = require('jsonwebtoken');
    const token =
      req.cookies?.access_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const secret = process.env.JWT_SECRET || 'fallback-secret';
    const payload = jwt.verify(token, secret) as any;

    const { rows } = await query(
      `SELECT id, email, name, image_url as "imageUrl", provider,
              created_at as "createdAt", updated_at as "updatedAt"
       FROM users WHERE id = $1`,
      [String(payload.sub)]
    );

    if (!rows[0]) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
      return;
    }

    req.user = rows[0] as unknown as User;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({
        error: { code: 'TOKEN_EXPIRED', message: 'Access token expired' },
      });
      return;
    }
    res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Invalid token' },
    });
  }
};

export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const jwt = require('jsonwebtoken');
    const token =
      req.cookies?.access_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const secret = process.env.JWT_SECRET || 'fallback-secret';
      const payload = jwt.verify(token, secret) as any;
      const { rows } = await query(
        `SELECT id, email, name, image_url as "imageUrl", provider,
                created_at as "createdAt", updated_at as "updatedAt"
         FROM users WHERE id = $1`,
        [String(payload.sub)]
      );
      if (rows[0]) req.user = rows[0] as unknown as User;
    }
  } catch {
    // Continue without user
  }
  next();
};
