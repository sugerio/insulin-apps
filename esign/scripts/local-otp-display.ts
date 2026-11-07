/** Node-only adapter for the trusted loopback demo; never mount on a Worker. */
export async function withLocalTestOtp(response:Response,mailbox:{get(key:string):Promise<{json():Promise<unknown>}|null>}):Promise<Response> {
 if(response.status!==202)return response;
 try {
  const body:unknown=await response.json();
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==1 || !('messageId' in body) || typeof body.messageId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.messageId))throw new Error('Invalid message');
  const message=await mailbox.get(`test-mail/${body.messageId}.json`),value=await message?.json();
  if(!value || typeof value!=='object' || !('otp' in value) || typeof value.otp!=='string' || !/^\d{6}$/.test(value.otp))throw new Error('Invalid mailbox item');
  const headers=new Headers(response.headers);headers.delete('content-length');headers.set('cache-control','no-store');
  return Response.json({messageId:body.messageId,testOtp:value.otp},{status:202,headers});
 } catch {return Response.json({error:'local_mailbox_unavailable'},{status:503,headers:{'cache-control':'no-store'}});}
}
