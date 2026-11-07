import {fetchManagementGateway} from './management-gateway.ts';
import {fetchRecipientGateway} from './recipient-gateway.ts';
import {fetchEditorGateway} from './editor-gateway.ts';

type Limiter = {limit(options:{key:string}):Promise<{success:boolean}>};
export type ConsolidatedGatewayEnv = {
 MANAGEMENT_GATEWAY_ENABLED?:string; MANAGEMENT_READINESS_ENABLED?:string; RECIPIENT_GATEWAY_ENABLED?:string; EDITOR_GATEWAY_ENABLED?:string;
 TRUSTED_RECIPIENT_ORIGINS?:string; TRUSTED_EDITOR_ORIGINS?:string;
 MANAGEMENT_RATE_LIMITER?:Limiter; MANAGEMENT_LOCATION_RATE_LIMITER?:Limiter;
 RECIPIENT_RATE_LIMITER?:Limiter; RECIPIENT_LOCATION_RATE_LIMITER?:Limiter;
 EDITOR_RATE_LIMITER?:Limiter; EDITOR_LOCATION_RATE_LIMITER?:Limiter;
};
type Handler = (request:Request)=>Promise<Response>;
type Handlers<E> = {management:(request:Request,env:E)=>Promise<Response>;recipient:(request:Request,env:E)=>Promise<Response>;editor:(request:Request,env:E)=>Promise<Response>;page:(request:Request,env:E)=>Promise<Response>};
const recipient=new Set(['/v1/page-sessions/exchange','/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign']);
const editor=new Set(['/v1/editor-sessions/exchange','/v1/editor-sessions/context','/v1/editor-sessions/save']);
export function createConsolidatedRouter<E extends ConsolidatedGatewayEnv>(handlers:Handlers<E>) {
 return (request:Request,env:E,trustedClientIp:string|null):Promise<Response> => {
  const path=new URL(request.url).pathname;
  const bind=(handler:(request:Request,env:E)=>Promise<Response>):{fetch:Handler}=>({fetch:request=>handler(request,env)});
  if(env.MANAGEMENT_READINESS_ENABLED==='true' && env.MANAGEMENT_GATEWAY_ENABLED!=='true' && path.startsWith('/v1/')) {
   if(request.method!=='GET' || path!=='/v1/me' || request.url.includes('?')) return Promise.resolve(Response.json({error:'not_found'},{status:404,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}));
   return fetchManagementGateway(request,{...env,MANAGEMENT_GATEWAY_ENABLED:'true',RATE_LIMITER:env.MANAGEMENT_RATE_LIMITER,LOCATION_RATE_LIMITER:env.MANAGEMENT_LOCATION_RATE_LIMITER,PRIVATE_MANAGEMENT:bind(handlers.management)},trustedClientIp);
  }
  if(recipient.has(path)) return fetchRecipientGateway(request,{...env,RATE_LIMITER:env.RECIPIENT_RATE_LIMITER,LOCATION_RATE_LIMITER:env.RECIPIENT_LOCATION_RATE_LIMITER,PRIVATE_RECIPIENT:bind(handlers.recipient)},trustedClientIp);
  if(editor.has(path)) return fetchEditorGateway(request,{...env,RATE_LIMITER:env.EDITOR_RATE_LIMITER,LOCATION_RATE_LIMITER:env.EDITOR_LOCATION_RATE_LIMITER,PRIVATE_EDITOR:bind(handlers.editor)},trustedClientIp);
  if(path.startsWith('/v1/')) return fetchManagementGateway(request,{...env,RATE_LIMITER:env.MANAGEMENT_RATE_LIMITER,LOCATION_RATE_LIMITER:env.MANAGEMENT_LOCATION_RATE_LIMITER,PRIVATE_MANAGEMENT:bind(handlers.management)},trustedClientIp);
  if(path==='/health' && request.method==='GET' && !new URL(request.url).search) return Promise.resolve(Response.json({status:'ok',service:'esign',mode:'candidate'},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}));
  return handlers.page(request,env);
 };
}
