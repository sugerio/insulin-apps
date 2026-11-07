/** Offline verification only. A valid seal does not establish synthetic provenance. */
import {readFile} from 'node:fs/promises';
import {verifyDynamicSyntheticSeal} from './synthetic-seal-verify.ts';
const args=process.argv.slice(2);
if(args.length!==3) {console.error('Usage: node scripts/synthetic-seal-dynamic-verify.ts WORKSPACE EXPECTED_SPKI_SHA256 TRUST_BUNDLE');process.exitCode=1;}
else {
 try {console.log(JSON.stringify(await verifyDynamicSyntheticSeal(args[0],args[1],await readFile(args[2]))));}
 catch {console.error('Synthetic evidence verification failed.');process.exitCode=1;}
}
