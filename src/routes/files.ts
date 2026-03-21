import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { query } from '../db';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../services/aclService';
import { logActivity } from '../services/activityService';
import {
  generateStorageKey,
  initMultipartUpload,
  generateSignedDownloadUrl,
  MAX_FILE_SIZE_BYTES,
} from '../services/storageService';

export const filesRouter = Router();

const getBaseUrl = (): string => {
  if (process.env.NODE_ENV === 'production') {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'nimbuscloud-api.onrender.com'}`;
  }
  return `http://localhost:${process.env.PORT || 8080}`;
};

const saveLocalFile = (storageKey: string, buffer: Buffer): void => {
  const uploadDir = path.join(process.cwd(), 'uploads');
  const filePath = path.join(uploadDir, storageKey.replace(/\//g, path.sep));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buffer);
};

const getLocalFilePath = (storageKey: string): string => {
  return path.join(
    process.cwd(), 'uploads',
    storageKey.replace(/\//g, path.sep)
  );
};

// ── PUT /api/files/upload-part/:storageKey (NO AUTH) ─────────────────────────
filesRouter.put('/upload-part/:storageKey', (req: Request, res: Response) => {
  try {
    const storageKey = decodeURIComponent(req.params.storageKey);
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        saveLocalFile(storageKey, buffer);
        console.log(`✅ Saved: ${storageKey} (${buffer.length} bytes)`);
        res.status(200).json({ etag: 'local-etag-1' });
      } catch (err) {
        console.error('Write error:', err);
        res.status(500).json({
          error: { code: 'WRITE_ERROR', message: 'Failed to save file' }
        });
      }
    });

    req.on('error', (err) => {
      console.error('Request error:', err);
      res.status(500).json({
        error: { code: 'UPLOAD_ERROR', message: 'Upload failed' }
      });
    });
  } catch (err) {
    console.error('Upload route error:', err);
    res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Server error' }
    });
  }
});

// ── GET /api/files/download/:storageKey (NO AUTH) ────────────────────────────
filesRouter.get('/download/:storageKey', (req: Request, res: Response) => {
  const storageKey = decodeURIComponent(req.params.storageKey);
  const filePath = getLocalFilePath(storageKey);
  console.log(`📥 Download: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'File not found on disk' }
    });
  }
  return res.download(filePath);
});

// ── All routes below require authentication ───────────────────────────────────
filesRouter.use(authenticate);

// ── POST /api/files/init ──────────────────────────────────────────────────────
filesRouter.post('/init', async (req: Request, res: Response) => {
  const body = z.object({
    name: z.string().min(1).max(255).trim(),
    mimeType: z.string(),
    sizeBytes: z.number().positive().max(MAX_FILE_SIZE_BYTES),
    folderId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  if (body.folderId) {
    await requireRole(req.user!.id, 'folder', body.folderId, 'editor');
  }

  const fileId = uuidv4();
  const storageKey = generateStorageKey(
    req.user!.id, fileId, body.name, body.folderId
  );

  const { rows } = await query(
    `INSERT INTO files
       (id, name, mime_type, size_bytes, storage_key, owner_id, folder_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading')
     RETURNING id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
               storage_key as "storageKey", owner_id as "ownerId",
               folder_id as "folderId", status,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [fileId, body.name, body.mimeType, body.sizeBytes, storageKey,
     req.user!.id, body.folderId ?? null]
  );

  const upload = await initMultipartUpload(
    storageKey, body.name, body.mimeType, body.sizeBytes
  );

  return res.status(201).json({ file: rows[0], upload });
});

// ── POST /api/files/complete ──────────────────────────────────────────────────
filesRouter.post('/complete', async (req: Request, res: Response) => {
  try {
    const body = z.object({
      fileId: z.string().uuid(),
      parts: z.array(z.object({
        partNumber: z.number(),
        etag: z.string(),
      })).optional(),
      checksum: z.string().optional(),
    }).parse(req.body);

    const { rows: fileRows } = await query(
      `SELECT id, owner_id as "ownerId", storage_key as "storageKey",
              size_bytes as "sizeBytes", name, folder_id as "folderId"
       FROM files WHERE id = $1`,
      [body.fileId]
    );

    if (!fileRows[0]) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'File not found' }
      });
    }

    if (String(fileRows[0].ownerId) !== req.user!.id) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Access denied' }
      });
    }

    await query(
      `UPDATE files SET status = 'ready', updated_at = now() WHERE id = $1`,
      [body.fileId]
    );

    try {
      const { rows: versionRows } = await query(
        `INSERT INTO file_versions
           (file_id, version_number, storage_key, size_bytes, created_by)
         VALUES ($1, 1, $2, $3, $4)
         ON CONFLICT (file_id, version_number) DO UPDATE
           SET storage_key = EXCLUDED.storage_key
         RETURNING id`,
        [body.fileId, fileRows[0].storageKey,
         fileRows[0].sizeBytes, req.user!.id]
      );
      await query(
        `UPDATE files SET version_id = $1 WHERE id = $2`,
        [versionRows[0].id, body.fileId]
      );
    } catch (vErr) {
      console.warn('Version record skipped:', vErr);
    }

    const { rows } = await query(
      `SELECT id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
              storage_key as "storageKey", owner_id as "ownerId",
              folder_id as "folderId", status,
              created_at as "createdAt", updated_at as "updatedAt"
       FROM files WHERE id = $1`,
      [body.fileId]
    );

    console.log(`✅ File ready: ${rows[0].name} | folder: ${rows[0].folderId ?? 'root'}`);

    try {
      await logActivity(
        req.user!.id, 'upload', 'file',
        body.fileId, { name: rows[0].name }
      );
    } catch {}

    return res.json({ file: rows[0] });

  } catch (err) {
    console.error('Complete error:', err);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Failed to complete upload' }
    });
  }
});

// ── GET /api/files/:id ────────────────────────────────────────────────────────
filesRouter.get('/:id', async (req: Request, res: Response) => {
  await requireRole(req.user!.id, 'file', req.params.id, 'viewer');

  const { rows } = await query(
    `SELECT id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
            storage_key as "storageKey", owner_id as "ownerId",
            folder_id as "folderId", status, checksum,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM files WHERE id = $1 AND is_deleted = false`,
    [req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'File not found' }
    });
  }

  const signedUrl = await generateSignedDownloadUrl(
    String(rows[0].storageKey)
  );

  await logActivity(req.user!.id, 'download', 'file', req.params.id);

  return res.json({ file: rows[0], signedUrl });
});

// ── PATCH /api/files/:id ──────────────────────────────────────────────────────
filesRouter.patch('/:id', async (req: Request, res: Response) => {
  const body = z.object({
    name: z.string().min(1).max(255).trim().optional(),
    folderId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  await requireRole(req.user!.id, 'file', req.params.id, 'editor');

  if (body.folderId) {
    await requireRole(req.user!.id, 'folder', body.folderId, 'editor');
  }

  const { rows } = await query(
    `UPDATE files
     SET name = COALESCE($1, name),
         folder_id = CASE WHEN $2::boolean THEN $3 ELSE folder_id END,
         updated_at = now()
     WHERE id = $4 AND is_deleted = false
     RETURNING id, name, mime_type as "mimeType", size_bytes as "sizeBytes",
               folder_id as "folderId", status,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [body.name, 'folderId' in body, body.folderId ?? null, req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'File not found' }
    });
  }

  if (body.name) {
    await logActivity(req.user!.id, 'rename', 'file', req.params.id, { name: body.name });
  }
  if ('folderId' in body) {
    await logActivity(req.user!.id, 'move', 'file', req.params.id);
  }

  return res.json({ file: rows[0] });
});

// ── DELETE /api/files/:id ─────────────────────────────────────────────────────
filesRouter.delete('/:id', async (req: Request, res: Response) => {
  await requireRole(req.user!.id, 'file', req.params.id, 'owner');

  await query(
    `UPDATE files SET is_deleted = true, deleted_at = now() WHERE id = $1`,
    [req.params.id]
  );

  await logActivity(req.user!.id, 'delete', 'file', req.params.id);
  return res.json({ message: 'File moved to trash' });
});

// ── GET /api/files/:id/versions ───────────────────────────────────────────────
filesRouter.get('/:id/versions', async (req: Request, res: Response) => {
  await requireRole(req.user!.id, 'file', req.params.id, 'viewer');

  const { rows } = await query(
    `SELECT id, file_id as "fileId", version_number as "versionNumber",
            storage_key as "storageKey", size_bytes as "sizeBytes",
            checksum, created_at as "createdAt"
     FROM file_versions WHERE file_id = $1
     ORDER BY version_number DESC`,
    [req.params.id]
  );

  return res.json({ versions: rows });
});
