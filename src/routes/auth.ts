import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import {
  hashPassword, comparePassword,
  generateAccessToken, generateRefreshToken,
  saveRefreshToken, rotateRefreshToken, revokeAllTokens,
  setAuthCookies, clearAuthCookies,
} from '../services/authService';
import { authenticate } from '../middleware/auth';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
authRouter.post('/register', async (req: Request, res: Response) => {
  const body = registerSchema.parse(req.body);

  const { rows: existing } = await query(
    'SELECT id FROM users WHERE email = $1',
    [body.email]
  );
  if (existing.length > 0) {
    return res.status(409).json({
      error: { code: 'EMAIL_TAKEN', message: 'Email already registered' }
    });
  }

  const passwordHash = await hashPassword(body.password);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, provider)
     VALUES ($1, $2, $3, 'email')
     RETURNING id, email, name, image_url as "imageUrl", provider,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [body.email.toLowerCase(), body.name, passwordHash]
  );

  const user = rows[0];
  const accessToken = generateAccessToken(user as any);
  const { raw, hash } = generateRefreshToken();
  await saveRefreshToken(String(user.id), hash);
  setAuthCookies(res, accessToken, raw);

  return res.status(201).json({ user, accessToken, refreshToken: raw });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response) => {
  const body = loginSchema.parse(req.body);

  const { rows } = await query(
    `SELECT id, email, name, password_hash, image_url as "imageUrl", provider,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM users WHERE email = $1`,
    [body.email.toLowerCase()]
  );

  const user = rows[0];
  if (!user?.password_hash) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }
    });
  }

  const valid = await comparePassword(body.password, String(user.password_hash));
  if (!valid) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }
    });
  }

  const { password_hash, ...safeUser } = user;
  const accessToken = generateAccessToken(safeUser as any);
  const { raw, hash } = generateRefreshToken();
  await saveRefreshToken(String(user.id), hash);
  setAuthCookies(res, accessToken, raw);

  return res.json({ user: safeUser, accessToken, refreshToken: raw });
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const rawToken =
    req.cookies?.refresh_token ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!rawToken) {
    return res.status(401).json({
      error: { code: 'NO_REFRESH_TOKEN', message: 'Refresh token missing' }
    });
  }

  const result = await rotateRefreshToken(rawToken);
  if (!result) {
    clearAuthCookies(res);
    return res.status(401).json({
      error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token invalid or expired' }
    });
  }

  const accessToken = generateAccessToken(result.user);
  setAuthCookies(res, accessToken, result.newRaw);
  return res.json({ accessToken, refreshToken: result.newRaw });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  await revokeAllTokens(req.user!.id);
  clearAuthCookies(res);
  return res.json({ message: 'Logged out successfully' });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
authRouter.get('/me', authenticate, (req: Request, res: Response) => {
  return res.json({ user: req.user });
});

// ── PATCH /api/auth/me ────────────────────────────────────────────────────────
authRouter.patch('/me', authenticate, async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1).max(80).trim().optional(),
  });
  const body = schema.parse(req.body);

  const { rows } = await query(
    `UPDATE users SET name = COALESCE($1, name), updated_at = now()
     WHERE id = $2
     RETURNING id, email, name, image_url as "imageUrl", provider,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [body.name, req.user!.id]
  );

  return res.json({ user: rows[0] });
});
