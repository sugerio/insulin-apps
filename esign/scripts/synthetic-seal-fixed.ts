/** Only the checked-in, hash-pinned synthetic Worker fixture is eligible for sealing. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { createSyntheticFixture } from './synthetic-seal-fixture.ts';

const FIXTURE_SHA256='d9b12fb3dadb75230348771217fa4cc30a2aa5e00b299c3c622afceea70132dc';
export async function loadFixedSyntheticFixture(...args:never[]):Promise<Awaited<ReturnType<typeof createSyntheticFixture>>> {
  if(args.length) throw new Error('Fixture accepts no input');
  const bytes=await readFile(new URL('./synthetic-seal-fixed-fixture.json',import.meta.url));
  if(createHash('sha256').update(bytes).digest('hex')!==FIXTURE_SHA256) throw new Error('Fixed synthetic fixture mismatch');
  const fixture=JSON.parse(bytes.toString('utf8'));
  if(!Array.isArray(fixture.artifacts) || fixture.artifacts.length!==4) throw new Error('Invalid fixed fixture');
  fixture.artifacts=fixture.artifacts.map((s:string)=>Uint8Array.from(Buffer.from(s,'base64')));
  return fixture;
}
