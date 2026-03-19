import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from '../db';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../services/aclService';

// ─────────────────────────────────────────────────────────────────────────────
// LINK SHARES (authenticated routes)
// ─────────────────────────────────────────────────────────────────────────────
export const linkSharesRouter = Router();
linkSharesRouter.use(authenticate);

// POST /api/link-shares
linkSharesRouter.post('/', async (req: Request, res: Response) => {
  const body = z.object({
    resourceType: z.enum(['file', 'folder']),
    resourceId: z.string().uuid(),
    expiresAt: z.string().datetime().optional(),
    password: z.string().min(4).max(128).optional(),
  }).parse(req.body);

  await requireRole(req.user!.id, body.resourceType, body.resourceId, 'owner');

  const token = crypto.randomBytes(32).toString('hex');
  const passwordHash = body.password
    ? await bcrypt.hash(body.password, 10)
    : null;

  const { rows } = await query(
    `INSERT INTO link_shares
       (resource_type, resource_id, token, password_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, resource_type as "resourceType", resource_id as "resourceId",
               token, expires_at as "expiresAt", created_at as "createdAt"`,
    [
      body.resourceType,
      body.resourceId,
      token,
      passwordHash,
      body.expiresAt ?? null,
      req.user!.id,
    ]
  );

  const link = `${process.env.CORS_ORIGIN || 'http://localhost:3000'}/shared/${token}`;
  return res.status(201).json({ linkShare: rows[0], link });
});

// GET /api/link-shares/:resourceType/:resourceId
linkSharesRouter.get('/:resourceType/:resourceId', async (req: Request, res: Response) => {
  await requireRole(
    req.user!.id,
    req.params.resourceType,
    req.params.resourceId,
    'owner'
  );

  const { rows } = await query(
    `SELECT id, resource_type as "resourceType", resource_id as "resourceId",
            token, expires_at as "expiresAt", created_at as "createdAt",
            CASE WHEN password_hash IS NOT NULL THEN true ELSE false END as "hasPassword"
     FROM link_shares
     WHERE resource_type = $1 AND resource_id = $2
     ORDER BY created_at DESC`,
    [req.params.resourceType, req.params.resourceId]
  );

  return res.json({ linkShares: rows });
});

// DELETE /api/link-shares/:id
linkSharesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { rows } = await query(
    'SELECT * FROM link_shares WHERE id = $1',
    [req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Link not found' }
    });
  }

  await requireRole(
    req.user!.id,
    rows[0].resource_type,
    rows[0].resource_id,
    'owner'
  );

  await query('DELETE FROM link_shares WHERE id = $1', [req.params.id]);
  return res.json({ message: 'Link revoked' });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC LINK RESOLVER (no auth required)
// ─────────────────────────────────────────────────────────────────────────────
export const publicLinkRouter = Router();

// GET /api/link/:token
publicLinkRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT ls.*,
              CASE
                WHEN ls.resource_type = 'file' THEN f.name
                ELSE fo.name
              END as "resourceName"
       FROM link_shares ls
       LEFT JOIN files f
         ON ls.resource_type = 'file' AND f.id = ls.resource_id
       LEFT JOIN folders fo
         ON ls.resource_type = 'folder' AND fo.id = ls.resource_id
       WHERE ls.token = $1`,
      [req.params.token]
    );

    if (!rows[0]) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Link not found or invalid' }
      });
    }

    const link = rows[0] as {
      expires_at: string | null;
      password_hash: string | null;
      resource_type: string;
      resource_id: string;
      resourceName: string;
      role: string;
      token: string;
    };

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({
        error: { code: 'LINK_EXPIRED', message: 'This link has expired' }
      });
    }

    if (link.password_hash) {
      const { password } = req.query;
      if (!password) {
        return res.status(401).json({
          error: { code: 'PASSWORD_REQUIRED', message: 'Password required' }
        });
      }
      const valid = await bcrypt.compare(
        password as string,
        link.password_hash
      );
      if (!valid) {
        return res.status(401).json({
          error: { code: 'WRONG_PASSWORD', message: 'Incorrect password' }
        });
      }
    }

    let signedUrl: string | undefined;
    if (link.resource_type === 'file') {
      const { rows: fileRows } = await query(
        'SELECT storage_key FROM files WHERE id = $1',
        [link.resource_id]
      );
      if (fileRows[0]) {
        const port = process.env.PORT || 8080;
        const baseUrl = process.env.NODE_ENV === 'production'
          ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
          : `http://localhost:${port}`;
        signedUrl = `${baseUrl}/api/files/download/${encodeURIComponent(fileRows[0].storage_key)}`;
      }
    }

    return res.json({
      resourceType: link.resource_type,
      resourceId: link.resource_id,
      resourceName: link.resourceName,
      role: link.role,
      signedUrl,
    });

  } catch (err) {
    console.error('Public link resolve error:', err);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Failed to resolve link' }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export const searchRouter = Router();
searchRouter.use(authenticate);

searchRouter.get('/', async (req: Request, res: Response) => {
  const schema = z.object({
    q: z.string().min(1).max(200),
    type: z.enum(['file', 'folder', 'all']).optional().default('all'),
    limit: z.coerce.number().min(1).max(100).optional().default(30),
  });

  const params = schema.parse(req.query);
  const userId = req.user!.id;
  const searchTerm = `%${params.q}%`;
  const results: { type: string; item: unknown }[] = [];

  if (params.type !== 'file') {
    const { rows: folders } = await query(
      `SELECT id, name, owner_id as "ownerId", parent_id as "parentId",
              is_deleted as "isDeleted", created_at as "createdAt", updated_at as "updatedAt"
       FROM folders
       WHERE owner_id = $1 AND is_deleted = false AND name ILIKE $2
       ORDER BY name LIMIT $3`,
      [userId, searchTerm, params.limit]
    );
    folders.forEach((f) => results.push({ type: 'folder', item: f }));
  }

  if (params.type !== 'folder') {
    const { rows: files } = await query(
      `SELECT id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
              folder_id as "folderId", status,
              created_at as "createdAt", updated_at as "updatedAt"
       FROM files
       WHERE owner_id = $1 AND is_deleted = false AND name ILIKE $2
       ORDER BY name LIMIT $3`,
      [userId, searchTerm, params.limit]
    );
    files.forEach((f) => results.push({ type: 'file', item: f }));
  }

  return res.json({ results, total: results.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// STARS ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export const starsRouter = Router();
starsRouter.use(authenticate);

starsRouter.get('/', async (req: Request, res: Response) => {
  const { rows: starredFiles } = await query(
    `SELECT f.id, f.name, f.mime_type as "mimeType", f.size_bytes as "sizeBytes",
            f.folder_id as "folderId", f.status,
            f.created_at as "createdAt", f.updated_at as "updatedAt"
     FROM files f
     JOIN stars s ON s.resource_id = f.id AND s.resource_type = 'file'
     WHERE s.user_id = $1 AND f.is_deleted = false
     ORDER BY s.created_at DESC`,
    [req.user!.id]
  );

  const { rows: starredFolders } = await query(
    `SELECT fo.id, fo.name, fo.owner_id as "ownerId", fo.parent_id as "parentId",
            fo.created_at as "createdAt", fo.updated_at as "updatedAt"
     FROM folders fo
     JOIN stars s ON s.resource_id = fo.id AND s.resource_type = 'folder'
     WHERE s.user_id = $1 AND fo.is_deleted = false
     ORDER BY s.created_at DESC`,
    [req.user!.id]
  );

  return res.json({ files: starredFiles, folders: starredFolders });
});

starsRouter.post('/', async (req: Request, res: Response) => {
  const body = z.object({
    resourceType: z.enum(['file', 'folder']),
    resourceId: z.string().uuid(),
  }).parse(req.body);

  await requireRole(req.user!.id, body.resourceType, body.resourceId, 'viewer');

  await query(
    `INSERT INTO stars (user_id, resource_type, resource_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [req.user!.id, body.resourceType, body.resourceId]
  );

  return res.status(201).json({ message: 'Starred' });
});

starsRouter.delete('/', async (req: Request, res: Response) => {
  const body = z.object({
    resourceType: z.enum(['file', 'folder']),
    resourceId: z.string().uuid(),
  }).parse(req.body);

  await query(
    `DELETE FROM stars WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3`,
    [req.user!.id, body.resourceType, body.resourceId]
  );

  return res.json({ message: 'Unstarred' });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRASH ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export const trashRouter = Router();
trashRouter.use(authenticate);

trashRouter.get('/', async (req: Request, res: Response) => {
  const { rows: deletedFiles } = await query(
    `SELECT id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
            folder_id as "folderId", deleted_at as "deletedAt"
     FROM files
     WHERE owner_id = $1 AND is_deleted = true
     ORDER BY deleted_at DESC`,
    [req.user!.id]
  );

  const { rows: deletedFolders } = await query(
    `SELECT id, name, parent_id as "parentId", deleted_at as "deletedAt"
     FROM folders
     WHERE owner_id = $1 AND is_deleted = true
     ORDER BY deleted_at DESC`,
    [req.user!.id]
  );

  return res.json({ files: deletedFiles, folders: deletedFolders });
});

trashRouter.post('/restore', async (req: Request, res: Response) => {
  const body = z.object({
    resourceType: z.enum(['file', 'folder']),
    resourceId: z.string().uuid(),
  }).parse(req.body);

  const table = body.resourceType === 'file' ? 'files' : 'folders';

  await query(
    `UPDATE ${table}
     SET is_deleted = false, deleted_at = null, updated_at = now()
     WHERE id = $1 AND owner_id = $2`,
    [body.resourceId, req.user!.id]
  );

  return res.json({ message: 'Restored successfully' });
});

trashRouter.delete('/purge/:resourceType/:resourceId', async (req: Request, res: Response) => {
  const table = req.params.resourceType === 'file' ? 'files' : 'folders';

  await query(
    `DELETE FROM ${table}
     WHERE id = $1 AND owner_id = $2 AND is_deleted = true`,
    [req.params.resourceId, req.user!.id]
  );

  return res.json({ message: 'Permanently deleted' });
});
