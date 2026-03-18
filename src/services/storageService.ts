import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Local storage directory
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Make sure uploads folder exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export interface PresignedUploadPart {
  partNumber: number;
  url: string;
  uploadId?: string;
}

export interface PresignedUploadResult {
  storageKey: string;
  uploadId: string;
  parts: PresignedUploadPart[];
}

export const generateStorageKey = (
  ownerId: string,
  fileId: string,
  fileName: string,
  folderId?: string | null
): string => {
  const ext = fileName.split('.').pop()?.toLowerCase() || 'bin';
  const slug = fileName
    .replace(/\.[^/.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return `${ownerId}/${fileId}-${slug}.${ext}`;
};

export const generateVersionKey = (baseKey: string, versionNumber: number): string => {
  const ext = baseKey.split('.').pop();
  const base = baseKey.replace(/\.[^/.]+$/, '');
  return `${base}.v${versionNumber}.${ext}`;
};

export const generateThumbnailKey = (storageKey: string): string => {
  return `previews/${storageKey}`;
};

export const initMultipartUpload = async (
  storageKey: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number
): Promise<PresignedUploadResult> => {
  const uploadId = crypto.randomUUID();
  const uploadUrl = `http://localhost:${process.env.PORT || 8080}/api/files/upload-part/${encodeURIComponent(storageKey)}`;

  return {
    storageKey,
    uploadId,
    parts: [{ partNumber: 1, url: uploadUrl, uploadId }],
  };
};

export const generateSignedDownloadUrl = async (
  storageKey: string,
  ttlSeconds = 3600
): Promise<string> => {
  const token = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'dev')
    .update(`${storageKey}:${Date.now() + ttlSeconds * 1000}`)
    .digest('hex');

  return `http://localhost:${process.env.PORT || 8080}/api/files/download/${encodeURIComponent(storageKey)}?token=${token}`;
};

export const deleteStorageObject = async (storageKey: string): Promise<void> => {
  const filePath = path.join(UPLOAD_DIR, storageKey.replace(/\//g, path.sep));
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

export const saveLocalFile = (storageKey: string, buffer: Buffer): void => {
  const filePath = path.join(UPLOAD_DIR, storageKey.replace(/\//g, path.sep));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, buffer);
};

export const getLocalFilePath = (storageKey: string): string => {
  return path.join(UPLOAD_DIR, storageKey.replace(/\//g, path.sep));
};

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json', 'application/zip',
  'application/x-tar', 'application/gzip',
  'application/octet-stream',
]);

export const MAX_FILE_SIZE_BYTES =
  parseInt(process.env.MAX_FILE_SIZE_MB || '500') * 1024 * 1024;