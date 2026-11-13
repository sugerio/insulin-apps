import {authorizeAccess,editorOriginAllowed,exchangeAccessCode,issueAccessCode,randomHex,validEditorOrigin} from './access.ts';
import type {Share} from './ownership.ts';

const HEX64=/^[a-f0-9]{64}$/;
/** What an editing session starts from: an existing template of the tenant (pinned by hash) and preset roles. */
/** The session's source, preset roles, and the name and metadata (metadata.ts) the saved template gets. */
export type EditorSource={sourceTemplateId?:string|null;sourceSha256?:string|null;roles?:string[];templateName?:string|null;templateMetadata?:Record<string,string>|null;
  /** Who opened it (the saved template's owner), and the shares and the owner's tags the saved template gets (ownership.ts, tags.ts). */
  ownerUserId?:string;shares?:Share[];tags?:string[]};

/**
 * SQL: the editor session `alias` still has its one-time code unused and unexpired, so the page
 * has not been opened yet. Binds: now.
 */
export const editorCodeOpen=(alias:string)=>`EXISTS (SELECT 1 FROM access_codes c WHERE c.scope='editor' AND c.subject_id=${alias}.id AND c.tenant_id=${alias}.tenant_id AND c.used_at IS NULL AND c.expires_at>?)`;

/**
 * Starts an editing session (`editor_sessions`) for a parent origin the deployment allows for the editor
 * (`app_settings.editor_origins`) and issues its one-time code (scope `editor`). The page ID
 * selects a CSP policy only; it does not authorize an exchange. The session row goes first in the batch and the code last: the code, the commit point,
 * is issued only for a session that exists with an allowed parent, and a session row without a
 * code is an unreachable, harmless orphan.
 */
export async function issueEditorPage(db:D1Database,tenantId:string,parentOrigin:string,now:number,source:EditorSource={}):Promise<{pageId:string;code:string}>{
  if(!validEditorOrigin(parentOrigin))throw new Error('Invalid origin');
  const pageId=randomHex();
  const session=db.prepare(`INSERT INTO editor_sessions (id,tenant_id,parent_origin,source_template_id,source_sha256,preset_roles_json,template_name,template_metadata_json,owner_user_id,shares_json,tags_json) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${editorOriginAllowed('?','?')}`)
    .bind(pageId,tenantId,parentOrigin,source.sourceTemplateId??null,source.sourceSha256??null,JSON.stringify(source.roles??[]),source.templateName??null,source.templateMetadata?JSON.stringify(source.templateMetadata):null,source.ownerUserId??'',JSON.stringify(source.shares??[]),JSON.stringify(source.tags??[]),tenantId,parentOrigin);
  let code:string;
  try{code=await issueAccessCode(db,{scope:'editor',tenantId,subjectId:pageId,origin:parentOrigin,now},[session]);}catch{throw new Error('Origin not allowed');}
  return {pageId,code};
}

/** The parent origin allowed to frame the page, while it is still allowed and its code is within its lifetime. */
export async function editorPageParent(db:D1Database,pageId:string,now:number):Promise<string|null>{
  if(!HEX64.test(pageId))return null;
  const row=await db.prepare(`SELECT x.parent_origin FROM editor_sessions x
    WHERE x.id=? AND ${editorOriginAllowed('x.tenant_id','x.parent_origin')} AND EXISTS (SELECT 1 FROM access_codes c WHERE c.scope='editor' AND c.subject_id=x.id AND c.tenant_id=x.tenant_id AND c.expires_at>?)`).bind(pageId,now).first<{parent_origin:string}>();
  return row?.parent_origin??null;
}

/** Exchanges the page's one-time code (scope `editor`, bound to this page) for an editor token. */
export async function exchangeEditorPage(db:D1Database,pageId:string,code:string,now:number):Promise<string>{
  if(!HEX64.test(pageId)||!HEX64.test(code))throw new Error('Invalid code');
  return exchangeAccessCode(db,{scope:'editor',code,subjectId:pageId,now});
}

export type EditorContext={pageId:string;tenantId:string;parentOrigin:string;tokenHash:string;sourceTemplateId:string|null;sourceSha256:string|null;stagedObjectKey:string|null;stagedSha256:string|null;roles:string[];resultTemplateId:string|null;templateName:string|null;templateMetadataJson:string|null;ownerUserId:string;shares:Share[];tags:string[]};

/** The editing session a live editor token opens. */
export async function editorPageContext(db:D1Database,token:string,now:number):Promise<EditorContext>{
  const access=await authorizeAccess(db,{scope:'editor',token,now});
  const row=await db.prepare('SELECT id,tenant_id,parent_origin,source_template_id,source_sha256,staged_object_key,staged_sha256,preset_roles_json,result_template_id,template_name,template_metadata_json,owner_user_id,shares_json,tags_json FROM editor_sessions WHERE id=? AND tenant_id=?').bind(access.subjectId,access.tenantId).first<{id:string;tenant_id:string;parent_origin:string;source_template_id:string|null;source_sha256:string|null;staged_object_key:string|null;staged_sha256:string|null;preset_roles_json:string;result_template_id:string|null;template_name:string|null;template_metadata_json:string|null;owner_user_id:string;shares_json:string;tags_json:string}>();
  if(!row)throw new Error('Invalid session');
  return {pageId:row.id,tenantId:row.tenant_id,parentOrigin:row.parent_origin,tokenHash:access.tokenHash,sourceTemplateId:row.source_template_id,sourceSha256:row.source_sha256,stagedObjectKey:row.staged_object_key,stagedSha256:row.staged_sha256,roles:JSON.parse(row.preset_roles_json),resultTemplateId:row.result_template_id,templateName:row.template_name,templateMetadataJson:row.template_metadata_json,ownerUserId:row.owner_user_id,shares:JSON.parse(row.shares_json),tags:JSON.parse(row.tags_json)};
}
