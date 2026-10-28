import { ApiError } from "../http.ts";

/** E-mail identity and explicit Directory/admin links both trigger the non-bypassable block. */
export async function isSelfDealing(
  db: D1Database, orgId: string, actorEmail: string, stakeholderIds: readonly string[],
): Promise<boolean> {
  if (stakeholderIds.length === 0) return false;
  const match = await db.prepare(
    `WITH requested(id) AS (SELECT value FROM json_each(?2)),
       canonical(id) AS (
         SELECT COALESCE(s.merged_into_id, s.id) FROM stakeholders s JOIN requested r ON r.id = s.id WHERE s.org_id = ?1
       ),
       merge_group(id) AS (
         SELECT s.id FROM stakeholders s JOIN canonical c ON s.id = c.id OR s.merged_into_id = c.id WHERE s.org_id = ?1
       )
     SELECT 1 FROM stakeholders s WHERE s.org_id = ?1 AND s.id IN (SELECT id FROM merge_group) AND (
         EXISTS (SELECT 1 FROM stakeholder_emails se WHERE se.org_id = s.org_id AND se.stakeholder_id = s.id
                 AND lower(se.email) = lower(?3) AND se.removed_at IS NULL)
         OR EXISTS (SELECT 1 FROM admin_stakeholder_links asl WHERE asl.org_id = s.org_id
                    AND asl.stakeholder_id = s.id AND lower(asl.email) = lower(?3) AND asl.removed_at IS NULL)
       ) LIMIT 1`,
  ).bind(orgId, JSON.stringify([...new Set(stakeholderIds)]), actorEmail).first();
  return match !== null;
}

export async function assertNotSelfDealing(
  db: D1Database, orgId: string, actorEmail: string, stakeholderIds: readonly string[],
): Promise<void> {
  if (await isSelfDealing(db, orgId, actorEmail, stakeholderIds)) {
    throw new ApiError("self_dealing", "An administrator cannot change their own stakeholder record or holdings");
  }
}
