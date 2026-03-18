import { query } from '../db';
import type { Activity } from '../types';

type ActivityAction = Activity['action'];
type ResourceType = 'file' | 'folder';

export const logActivity = async (
  actorId: string,
  action: ActivityAction,
  resourceType: ResourceType,
  resourceId: string,
  context: Record<string, unknown> = {}
): Promise<void> => {
  try {
    await query(
      `INSERT INTO activities (actor_id, action, resource_type, resource_id, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, resourceType, resourceId, JSON.stringify(context)]
    );
  } catch (err) {
    // Activity logging must never break the main request
    console.error('[Activity] Failed to log:', err);
  }
};

export const getResourceActivities = async (
  resourceType: ResourceType,
  resourceId: string,
  limit = 20
): Promise<Activity[]> => {
  const { rows } = await query<Activity>(
    `SELECT a.id, a.actor_id as "actorId", a.action, a.resource_type as "resourceType",
            a.resource_id as "resourceId", a.context, a.created_at as "createdAt",
            u.name as "actorName", u.image_url as "actorImageUrl"
     FROM activities a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.resource_type = $1 AND a.resource_id = $2
     ORDER BY a.created_at DESC
     LIMIT $3`,
    [resourceType, resourceId, limit]
  );
  return rows;
};
