import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
};

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

export const initMultipartUpload = async (
  storageKey: string,
  _fileName: string,
  _mimeType: string,
  _sizeBytes: number
): Promise<PresignedUploadResult> => {
  const uploadId = crypto.randomUUID();
  const supabase = getSupabase();

  if (supabase && process.env.NODE_ENV === 'production') {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'nimbuscloud-files';
    const { data, error } = await (supabase.storage as any)
      .from(bucket)
      .createSignedUploadUrl(storageKey);

    if (error) {
      console.error('Supabase signed URL error:', error);
    } else if (data?.signedUrl) {
      return {
        storageKey,
        uploadId,
        parts: [{ partNumber: 1, url: data.signedUrl, uploadId }],
      };
    }
  }

  const baseUrl = `http://localhost:${process.env.PORT || 8080}`;
  return {
    storageKey,
    uploadId,
    parts: [{
      partNumber: 1,
      url: `${baseUrl}/api/files/upload-part/${encodeURIComponent(storageKey)}`,
      uploadId,
    }],
  };
};

export const generateSignedDownloadUrl = async (
  storageKey: string,
  ttlSeconds = 3600
): Promise<string> => {
  const supabase = getSupabase();

  if (supabase && process.env.NODE_ENV === 'production') {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'nimbuscloud-files';

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storageKey, ttlSeconds);

    if (error) {
      console.error('Supabase download URL error:', error);
    } else if (data?.signedUrl) {
      return data.signedUrl;
    }
  }

  const baseUrl = `http://localhost:${process.env.PORT || 8080}`;
  return `${baseUrl}/api/files/download/${encodeURIComponent(storageKey)}`;
};

export const deleteStorageObject = async (storageKey: string): Promise<void> => {
  const supabase = getSupabase();
  if (supabase && process.env.NODE_ENV === 'production') {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'nimbuscloud-files';
    await supabase.storage.from(bucket).remove([storageKey]);
  }
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
