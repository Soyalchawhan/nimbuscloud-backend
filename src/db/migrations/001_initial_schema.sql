-- NimbusCloud Database Schema
-- Run this file to create all tables, indexes, and constraints

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  password_hash TEXT,                         -- null if OAuth-only user
  image_url   TEXT,
  provider    TEXT DEFAULT 'email',           -- 'email' | 'google' | 'github'
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- ── Refresh Tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens(expires_at);

-- ── Folders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES folders(id) ON DELETE SET NULL,
  is_deleted  BOOLEAN DEFAULT false,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS folders_owner_id_idx ON folders(owner_id);
CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders(parent_id);
CREATE INDEX IF NOT EXISTS folders_name_owner_idx ON folders(name, owner_id);
-- Prevent duplicate names at the same level for the same owner
CREATE UNIQUE INDEX IF NOT EXISTS folders_unique_name_per_parent
  ON folders(owner_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE is_deleted = false;

-- ── Files ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  mime_type   TEXT,
  size_bytes  BIGINT DEFAULT 0,
  storage_key TEXT UNIQUE NOT NULL,           -- path in bucket
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   UUID REFERENCES folders(id) ON DELETE SET NULL,
  version_id  UUID,                           -- FK set after first version created
  checksum    TEXT,                           -- MD5 or SHA-256
  status      TEXT DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'error')),
  is_deleted  BOOLEAN DEFAULT false,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_owner_id_idx ON files(owner_id);
CREATE INDEX IF NOT EXISTS files_folder_id_idx ON files(folder_id);
CREATE INDEX IF NOT EXISTS files_name_owner_idx ON files(name, owner_id);
-- Full-text search index using trigram for fuzzy matching
CREATE INDEX IF NOT EXISTS files_name_trgm_idx ON files USING gin (name gin_trgm_ops);
-- Full-text search via tsvector
CREATE INDEX IF NOT EXISTS files_name_fts_idx ON files USING gin (to_tsvector('simple', name));

-- ── File Versions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number  INT NOT NULL,
  storage_key     TEXT NOT NULL,
  size_bytes      BIGINT,
  checksum        TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(file_id, version_number)
);

CREATE INDEX IF NOT EXISTS file_versions_file_id_idx ON file_versions(file_id);

-- Add FK from files to file_versions (deferred to avoid circular dep at creation)
ALTER TABLE files
  ADD CONSTRAINT files_version_id_fk
  FOREIGN KEY (version_id) REFERENCES file_versions(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- ── Shares (per-user ACL) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shares (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type     TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
  resource_id       UUID NOT NULL,
  grantee_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(resource_type, resource_id, grantee_user_id)
);

CREATE INDEX IF NOT EXISTS shares_resource_idx ON shares(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS shares_grantee_idx ON shares(grantee_user_id);

-- ── Public Link Shares ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_shares (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
  resource_id   UUID NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role = 'viewer'),
  password_hash TEXT,
  expires_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS link_shares_token_idx ON link_shares(token);
CREATE INDEX IF NOT EXISTS link_shares_resource_idx ON link_shares(resource_type, resource_id);

-- ── Stars / Favorites ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stars (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
  resource_id   UUID NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS stars_user_idx ON stars(user_id);

-- ── Activity Log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN (
                  'upload','rename','delete','restore','move',
                  'share','download','create_folder','copy')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
  resource_id   UUID NOT NULL,
  context       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activities_resource_idx ON activities(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS activities_actor_idx ON activities(actor_id);
CREATE INDEX IF NOT EXISTS activities_created_at_idx ON activities(created_at DESC);

-- ── Utility: update updated_at automatically ──────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER folders_updated_at
  BEFORE UPDATE ON folders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER files_updated_at
  BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION set_updated_at();
