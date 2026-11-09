import {validEditorOrigin} from '../../src/access.ts';

/**
 * Replaces a tenant's editor origin list (`tenants.editor_origins_json`) with `origins`. Like
 * `scripts/provision-tenant.ts`, it writes only validated bare origins, and the tenant must exist.
 */
export async function setEditorOrigins(db:D1Database,tenantId:string,origins:string[]):Promise<void>{
 for(const origin of origins) if(!validEditorOrigin(origin)) throw new Error(`invalid editor origin ${origin}`);
 const result=await db.prepare('UPDATE tenants SET editor_origins_json=? WHERE id=?').bind(JSON.stringify(origins),tenantId).run();
 if(result.meta.changes!==1) throw new Error(`no tenant ${tenantId}`);
}
