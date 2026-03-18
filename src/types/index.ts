// ── Domain Types ──────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  imageUrl?: string;
  provider: 'email' | 'google' | 'github';
  createdAt: Date;
  updatedAt: Date;
}

export interface Folder {
  id: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface File {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  ownerId: string;
  folderId: string | null;
  versionId?: string;
  checksum?: string;
  status: 'uploading' | 'ready' | 'error';
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  storageKey: string;
  sizeBytes: number;
  checksum?: string;
  createdBy?: string;
  createdAt: Date;
}

export interface Share {
  id: string;
  resourceType: 'file' | 'folder';
  resourceId: string;
  granteeUserId: string;
  role: 'viewer' | 'editor';
  createdBy: string;
  createdAt: Date;
}

export interface LinkShare {
  id: string;
  resourceType: 'file' | 'folder';
  resourceId: string;
  token: string;
  role: 'viewer';
  passwordHash?: string;
  expiresAt?: Date;
  createdBy: string;
  createdAt: Date;
}

export interface Star {
  userId: string;
  resourceType: 'file' | 'folder';
  resourceId: string;
  createdAt: Date;
}

export interface Activity {
  id: string;
  actorId: string;
  action: 'upload' | 'rename' | 'delete' | 'restore' | 'move' | 'share' | 'download' | 'create_folder' | 'copy';
  resourceType: 'file' | 'folder';
  resourceId: string;
  context: Record<string, unknown>;
  createdAt: Date;
}

// ── Request body types ────────────────────────────────────────────────────────

export interface RegisterBody {
  email: string;
  password: string;
  name: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface CreateFolderBody {
  name: string;
  parentId?: string | null;
}

export interface UpdateFolderBody {
  name?: string;
  parentId?: string | null;
}

export interface InitUploadBody {
  name: string;
  mimeType: string;
  sizeBytes: number;
  folderId?: string | null;
}

export interface CompleteUploadBody {
  fileId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  checksum?: string;
}

export interface UpdateFileBody {
  name?: string;
  folderId?: string | null;
}

export interface CreateShareBody {
  resourceType: 'file' | 'folder';
  resourceId: string;
  granteeUserId: string;
  role: 'viewer' | 'editor';
}

export interface CreateLinkShareBody {
  resourceType: 'file' | 'folder';
  resourceId: string;
  expiresAt?: string;
  password?: string;
}

export interface StarBody {
  resourceType: 'file' | 'folder';
  resourceId: string;
}

// ── API Response types ────────────────────────────────────────────────────────

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
  total?: number;
}

// ── JWT Payload ───────────────────────────────────────────────────────────────
export interface JwtPayload {
  sub: string;      // user id
  email: string;
  iat?: number;
  exp?: number;
}

// ── Augmented Express Request ─────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
