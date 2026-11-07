import {fetchCandidateManagement,fetchCandidateRecipient,fetchCandidateEditor} from './candidate-worker.ts';
import page from './candidate-page-host.ts';
import {createConsolidatedRouter, type ConsolidatedGatewayEnv} from './consolidated-router.ts';

type Env = ConsolidatedGatewayEnv & Parameters<typeof fetchCandidateManagement>[1] & Parameters<typeof page.fetch>[1];
const route=createConsolidatedRouter<Env>({management:fetchCandidateManagement,recipient:fetchCandidateRecipient,editor:fetchCandidateEditor,page:page.fetch});
export default {fetch(request:Request,env:Parameters<typeof route>[1]) {
 const url=new URL(request.url);
 if(url.pathname!=='/health' && (url.origin!==env.RECIPIENT_GATEWAY_ORIGIN || url.origin!==env.EDITOR_GATEWAY_ORIGIN)) return new Response('Unavailable',{status:503,headers:{'cache-control':'no-store'}});
 // Cloudflare supplies this edge header; deployments must not bypass the Cloudflare edge.
 return route(request,env,request.headers.get('cf-connecting-ip'));
}};
