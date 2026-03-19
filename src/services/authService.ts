import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import type { User, JwtPayload } from '../types';

const SALT_ROUNDS = 12;

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, SALT_ROUNDS);

export const comparePassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);

export const generateAccessToken = (user: User): string =>
  jwt.sign(
    { sub: user.id, email: user.email } as JwtPayload,
    process.env.JWT_SECRET as string,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as string }
  );

export const generateRefreshToken = (): { raw: string; hash: string } => {
  const raw = crypto.randomBytes(64).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

export const saveRefreshToken = async (
  userId: string,
  tokenHash: string
): Promise<void> => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
};

export const rotateRefreshToken = async (
  oldRaw: string
): Promise<{ user: User; newRaw: string } | null> => {
  const oldHash = crypto.createHash('sha256').update(oldRaw).digest('hex');

  const { rows: tokens } = await query<{ user_id: string; expires_at: Date }>(
    `SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1`,
    [oldHash]
  );

  if (!tokens[0] || tokens[0].expires_at < new Date()) {
    // Invalid or expired — delete it
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [oldHash]);
    return null;
  }

  const { rows: users } = await query<User>(
    `SELECT id, email, name, image_url as "imageUrl", provider, created_at as "createdAt", updated_at as "updatedAt"
     FROM users WHERE id = $1`,
    [tokens[0].user_id]
  );

  if (!users[0]) return null;

  // Rotate: delete old, create new
  await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [oldHash]);
  const { raw: newRaw, hash: newHash } = generateRefreshToken();
  await saveRefreshToken(users[0].id, newHash);

  return { user: users[0], newRaw };
};

export const revokeAllTokens = async (userId: string): Promise<void> => {
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
};

export const setAuthCookies = (
  res: import('express').Response,
  accessToken: string,
  refreshToken: string
): void => {
  const isProd = process.env.NODE_ENV === 'production';

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000, // 15 min
  });

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/auth/refresh',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

export const clearAuthCookies = (res: import('express').Response): void => {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
};
