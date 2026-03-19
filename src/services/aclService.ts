import { query } from '../db';

export const getEffectiveRole = async (
  userId: string,
  resourceType: string,
  resourceId: string
): Promise<string | null> => {
  const table = resourceType === 'file' ? 'files' : 'folders';

  const { rows: owned } = await query(
    `SELECT id FROM ${table} WHERE id = $1 AND owner_id = $2 AND is_deleted = false`,
    [resourceId, userId]
  );
  if (owned.length > 0) return 'owner';

  const { rows: shares } = await query(
    `SELECT role FROM shares
     WHERE resource_type = $1 AND resource_id = $2 AND grantee_user_id = $3`,
    [resourceType, resourceId, userId]
  );
  if (shares.length > 0) return String(shares[0].role);

  if (resourceType === 'file') {
    const { rows: files } = await query(
      `SELECT folder_id FROM files WHERE id = $1`,
      [resourceId]
    );
    if (files[0]?.folder_id) {
      return getEffectiveRole(userId, 'folder', String(files[0].folder_id));
    }
  }

  return null;
};

export const requireRole = async (
  userId: string,
  resourceType: string,
  resourceId: string,
  minRole: string
): Promise<void> => {
  const role = await getEffectiveRole(userId, resourceType, resourceId);

  if (!role) {
    throw { statusCode: 403, code: 'FORBIDDEN', message: 'Access denied' };
  }

  const hierarchy = ['viewer', 'editor', 'owner'];
  const userLevel = hierarchy.indexOf(role);
  const requiredLevel = hierarchy.indexOf(minRole);

  if (userLevel < requiredLevel) {
    throw {
      statusCode: 403,
      code: 'FORBIDDEN',
      message: `Requires ${minRole} access`,
    };
  }
};
