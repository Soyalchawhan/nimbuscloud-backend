import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../services/aclService';
import { logActivity } from '../services/activityService';

export const sharesRouter = Router();
sharesRouter.use(authenticate);

// ── POST /api/shares ──────────────────────────────────────────────────────────
sharesRouter.post('/', async (req: Request, res: Response) => {
  const body = z.object({
    resourceType: z.enum(['file', 'folder']),
    resourceId: z.string().uuid(),
    granteeUserId: z.string().uuid(),
    role: z.enum(['viewer', 'editor']),
  }).parse(req.body);

  // Only owner can grant access
  await requireRole(req.user!.id, body.resourceType as 'file' | 'folder', body.resourceId, 'owner');

  if (body.granteeUserId === req.user!.id) {
    return res.status(400).json({ error: { code: 'SELF_SHARE', message: 'Cannot share with yourself' } });
  }

  // Verify grantee exists
  const { rows: granteeRows } = await query('SELECT id, name, email FROM users WHERE id = $1', [body.granteeUserId]);
  if (!granteeRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });

  const { rows } = await query(
    `INSERT INTO shares (resource_type, resource_id, grantee_user_id, role, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (resource_type, resource_id, grantee_user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING id, resource_type as "resourceType", resource_id as "resourceId",
               grantee_user_id as "granteeUserId", role, created_by as "createdBy", created_at as "createdAt"`,
    [body.resourceType, body.resourceId, body.granteeUserId, body.role, req.user!.id]
  );

  await logActivity(req.user!.id, 'share', body.resourceType, body.resourceId, { granteeUserId: body.granteeUserId, role: body.role });
  return res.status(201).json({ share: rows[0] });
});

// ── GET /api/shares/:resourceType/:resourceId ─────────────────────────────────
sharesRouter.get('/:resourceType/:resourceId', async (req: Request, res: Response) => {
  const resourceType = req.params.resourceType as 'file' | 'folder';
  await requireRole(req.user!.id, resourceType, req.params.resourceId, 'owner');

  const { rows } = await query(
    `SELECT s.id, s.resource_type as "resourceType", s.resource_id as "resourceId",
            s.grantee_user_id as "granteeUserId", s.role, s.created_at as "createdAt",
            u.name as "granteeName", u.email as "granteeEmail", u.image_url as "granteeImageUrl"
     FROM shares s JOIN users u ON u.id = s.grantee_user_id
     WHERE s.resource_type = $1 AND s.resource_id = $2
     ORDER BY s.created_at DESC`,
    [resourceType, req.params.resourceId]
  );

  return res.json({ shares: rows });
});

// ── DELETE /api/shares/:id ────────────────────────────────────────────────────
sharesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT * FROM shares WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share not found' } });

  await requireRole(req.user!.id, rows[0].resource_type, rows[0].resource_id, 'owner');

  await query('DELETE FROM shares WHERE id = $1', [req.params.id]);
  return res.json({ message: 'Share revoked' });
});
