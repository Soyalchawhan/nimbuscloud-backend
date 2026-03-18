import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../services/aclService';
import { logActivity } from '../services/activityService';
import type { Folder } from '../types';

export const foldersRouter = Router();
foldersRouter.use(authenticate);

// ── POST /api/folders ─────────────────────────────────────────────────────────
foldersRouter.post('/', async (req: Request, res: Response) => {
  const body = z.object({
    name: z.string().min(1).max(255).trim(),
    parentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  if (body.parentId) {
    await requireRole(req.user!.id, 'folder', body.parentId, 'editor');
  }

  const { rows } = await query<Folder>(
    `INSERT INTO folders (name, owner_id, parent_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, owner_id as "ownerId", parent_id as "parentId",
               is_deleted as "isDeleted", created_at as "createdAt", updated_at as "updatedAt"`,
    [body.name, req.user!.id, body.parentId ?? null]
  );

  await logActivity(req.user!.id, 'create_folder', 'folder', rows[0].id, { name: rows[0].name });
  return res.status(201).json({ folder: rows[0] });
});

// ── GET /api/folders (root) ───────────────────────────────────────────────────
foldersRouter.get('/', async (req: Request, res: Response) => {
  const { rows: folders } = await query<Folder>(
    `SELECT id, name, owner_id as "ownerId", parent_id as "parentId",
            is_deleted as "isDeleted", created_at as "createdAt", updated_at as "updatedAt"
     FROM folders
     WHERE owner_id = $1 AND parent_id IS NULL AND is_deleted = false
     ORDER BY name ASC`,
    [req.user!.id]
  );

  const { rows: files } = await query(
    `SELECT id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
            folder_id as "folderId", status,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM files
     WHERE owner_id = $1 AND folder_id IS NULL AND is_deleted = false
     ORDER BY name ASC`,
    [req.user!.id]
  );

  return res.json({ folders, files, path: [] });
});

// ── GET /api/folders/:id ──────────────────────────────────────────────────────
foldersRouter.get('/:id', async (req: Request, res: Response) => {
  await requireRole(req.user!.id, 'folder', req.params.id, 'viewer');

  const { rows: folderRows } = await query<Folder>(
    `SELECT id, name, owner_id as "ownerId", parent_id as "parentId",
            is_deleted as "isDeleted", created_at as "createdAt", updated_at as "updatedAt"
     FROM folders WHERE id = $1 AND is_deleted = false`,
    [req.params.id]
  );

  if (!folderRows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Folder not found' } });
  }

  const folder = folderRows[0];

  // Child folders
  const { rows: childFolders } = await query<Folder>(
    `SELECT id, name, owner_id as "ownerId", parent_id as "parentId",
            is_deleted as "isDeleted", created_at as "createdAt", updated_at as "updatedAt"
     FROM folders
     WHERE parent_id = $1 AND is_deleted = false
     ORDER BY name ASC`,
    [folder.id]
  );

  // Files in this folder — show all statuses so uploaded files appear immediately
  const { rows: childFiles } = await query(
    `SELECT id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
            folder_id as "folderId", status,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM files
     WHERE folder_id = $1 AND is_deleted = false
     ORDER BY name ASC`,
    [folder.id]
  );

  // Breadcrumb path
  const { rows: path } = await query<{ id: string; name: string }>(
    `WITH RECURSIVE breadcrumb AS (
       SELECT id, name, parent_id, 0 AS depth FROM folders WHERE id = $1
       UNION ALL
       SELECT f.id, f.name, f.parent_id, b.depth + 1
       FROM folders f JOIN breadcrumb b ON f.id = b.parent_id
     )
     SELECT id, name FROM breadcrumb ORDER BY depth DESC`,
    [folder.id]
  );

  return res.json({
    folder,
    children: { folders: childFolders, files: childFiles },
    path,
  });
});

// ── PATCH /api/folders/:id ────────────────────────────────────────────────────
foldersRouter.patch('/:id', async (req: Request, res: Response) => {
  const body = z.object({
    name: z.string().min(1).max(255).trim().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  await requireRole(req.user!.id, 'folder', req.params.id, 'editor');

  const { rows } = await query<Folder>(
    `UPDATE folders
     SET name = COALESCE($1, name),
         parent_id = CASE WHEN $2::boolean THEN $3 ELSE parent_id END,
         updated_at = now()
     WHERE id = $4 AND is_deleted = false
     RETURNING id, name, owner_id as "ownerId", parent_id as "parentId",
               is_deleted as "isDeleted", created_at as "createdAt", updated_at as "updatedAt"`,
    [body.name, 'parentId' in body, body.parentId ?? null, req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Folder not found' } });
  }

  await logActivity(req.user!.id, 'rename', 'folder', rows[0].id, { name: rows[0].name });
  return res.json({ folder: rows[0] });
});

// ── DELETE /api/folders/:id ───────────────────────────────────────────────────
foldersRouter.delete('/:id', async (req: Request, res: Response) => {
  await requireRole(req.user!.id, 'folder', req.params.id, 'owner');

  await withTransaction(async (client) => {
    // Soft-delete folder and all descendants
    await client.query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM folders WHERE id = $1
         UNION ALL
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
       )
       UPDATE folders SET is_deleted = true, deleted_at = now()
       WHERE id IN (SELECT id FROM tree)`,
      [req.params.id]
    );

    // Soft-delete all files inside those folders
    await client.query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM folders WHERE id = $1
         UNION ALL
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
       )
       UPDATE files SET is_deleted = true, deleted_at = now()
       WHERE folder_id IN (SELECT id FROM tree)`,
      [req.params.id]
    );
  });

  await logActivity(req.user!.id, 'delete', 'folder', req.params.id);
  return res.json({ message: 'Folder moved to trash' });
});