import { query } from '../db';

type Role = 'owner' | 'editor' | 'viewer';
type ResourceType = 'file' | 'folder';

/**
 * Returns the effective role of userId on the given resource.
 * Returns null if no access.
 */
export const getEffectiveRole = async (
  userId: string,
  resourceType: ResourceType,
  resourceId: string
): Promise<Role | null> => {
  // Check if user is the owner
  const table = resourceType === 'file' ? 'files' : 'folders';
  const { rows: owned } = await query(
    `SELECT id FROM ${table} WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
    [resourceId, userId]
  );
  if (owned.length > 0) return 'owner';

  // Check explicit share grant
  const { rows: shares } = await query<{ role: string }>(
    `SELECT role FROM shares WHERE resource_type = $1 AND resource_id = $2 AND grantee_user_id = $3`,
    [resourceType, resourceId, userId]
  );
  if (shares.length > 0) return shares[0].role as Role;

  // For files inside a shared folder, check parent folder inheritance
  if (resourceType === 'file') {
    const { rows: files } = await query<{ folder_id: string }>(
      `SELECT folder_id FROM files WHERE id = $1`,
      [resourceId]
    );
    if (files[0]?.folder_id) {
      const folderRole = await getEffectiveRole(userId, 'folder', files[0].folder_id);
      return folderRole;
    }
  }

  return null;
};

export const requireRole = async (
  userId: string,
  resourceType: ResourceType,
  resourceId: string,
  minRole: 'viewer' | 'editor' | 'owner'
): Promise<void> => {
  const role = await getEffectiveRole(userId, resourceType, resourceId);
  if (!role) throw { statusCode: 403, code: 'FORBIDDEN', message: 'Access denied' };

  const hierarchy: Role[] = ['viewer', 'editor', 'owner'];
  if (hierarchy.indexOf(role) < hierarchy.indexOf(minRole)) {
    throw { statusCode: 403, code: 'FORBIDDEN', message: `Requires ${minRole} access` };
  }
};
