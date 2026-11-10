import {validEditorOrigin} from '../../src/app/server/esign/access.ts';

/**
 * Replaces a tenant's editor origin list (`tenants.editor_origins_json`, the test gateway's stand-in
 * for ESIGN_FRAME_ANCESTORS) with `origins`. It writes only validated bare origins, and the tenant
 * must exist.
 */
export async function setEditorOrigins(db:D1Database,tenantId:string,origins:string[]):Promise<void>{
 for(const origin of origins) if(!validEditorOrigin(origin)) throw new Error(`invalid editor origin ${origin}`);
 // The test gateway's trigger also rewrites app_settings, so D1 counts more than the one change.
 const result=await db.prepare('UPDATE tenants SET editor_origins_json=? WHERE id=? RETURNING id').bind(JSON.stringify(origins),tenantId).all();
 if(result.results.length!==1) throw new Error(`no tenant ${tenantId}`);
}
