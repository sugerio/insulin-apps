/** Offline verification does not establish that the uploaded PDF is synthetic. */
import {readFile} from 'node:fs/promises';
import {verifyUploadedSeal} from './synthetic-seal-verify.ts';
const args=process.argv.slice(2);
if(args.length!==3) {console.error('Usage: node scripts/upload-seal-verify.ts WORKSPACE EXPECTED_SPKI_SHA256 TRUST_BUNDLE');process.exitCode=1;}
else {
 try {console.log(JSON.stringify(await verifyUploadedSeal(args[0],args[1],await readFile(args[2]))));}
 catch {console.error('Uploaded evidence verification failed.');process.exitCode=1;}
}
