import {authorizeRecipientSession,sendRecipientOtp} from './page-authorization.ts';
import {createCloudflareOtpMailer} from './cloudflare-otp-mail.ts';

type EmailBinding=NonNullable<Parameters<typeof createCloudflareOtpMailer>[0]['binding']>;
/** Unmounted synthetic fixture wiring only; it is not a recipient identity or sending authorization boundary. */
export async function sendSyntheticCloudflareOtpTest(db:D1Database,binding:EmailBinding,token:string,origin:string,now:number,pepper:Uint8Array):Promise<void>{
 const task=await authorizeRecipientSession(db,token,origin,now);
 const row=await db.prepare('SELECT recipient_email FROM tasks WHERE id=?').bind(task).first<{recipient_email:string}>();
 if(row?.recipient_email!=='ana@example.com')throw new Error('Synthetic recipient unavailable');
 const send=createCloudflareOtpMailer({enabled:'true',from:'sign@example.com',binding});
 await sendRecipientOtp(db,token,origin,now,pepper,async(to,otp)=>{if(to!=='ana@example.com')throw new Error('Synthetic recipient unavailable');await send(to,otp);});
}
