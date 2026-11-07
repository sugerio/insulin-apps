// A throwaway RFC 3161 TSA for tests: a synthetic root and a timestamping certificate made with
// OpenSSL, answering timestamp queries with `openssl ts -reply`. Synthetic data only.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type OpensslTsa = {
  roots: Uint8Array[];
  signerSpkiSha256: string;
  policy: string;
  reply(query: Uint8Array): Promise<Uint8Array>;
  dispose(): Promise<void>;
};

/** withAccuracy false issues tokens without an accuracy field, like DigiCert's. */
export async function startOpensslTsa({ withAccuracy = true } = {}): Promise<OpensslTsa> {
  const dir = await mkdtemp(join(tmpdir(), 'esign-openssl-tsa-'));
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Synthetic Root', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tsa.key', '-out', 'tsa.csr', '-subj', '/CN=Synthetic TSA']);
  await writeFile(join(dir, 'extensions.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
  run(['x509', '-req', '-in', 'tsa.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-set_serial', '1', '-days', '1', '-extfile', 'extensions.cnf', '-out', 'tsa.pem']);
  run(['x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der']);
  await writeFile(join(dir, 'serial'), '01\n');
  await writeFile(join(dir, 'tsa.cnf'), `[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\n${withAccuracy ? 'accuracy=secs:1\n' : ''}ordering=no\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n`);
  const signer = new X509Certificate(await readFile(join(dir, 'tsa.pem')));
  const signerSpkiSha256 = createHash('sha256').update(signer.publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  const roots = [new Uint8Array(await readFile(join(dir, 'root.der')))];
  // The certificates start now; a timestamp within its accuracy of their start is refused.
  await new Promise(resolve => setTimeout(resolve, 2100));
  let n = 0;
  return {
    roots, signerSpkiSha256, policy: '1.2.3.4',
    async reply(query) {
      const name = `q${++n}`;
      await writeFile(join(dir, name), query);
      run(['ts', '-reply', '-config', 'tsa.cnf', '-queryfile', name, '-out', `${name}.tsr`]);
      return new Uint8Array(await readFile(join(dir, `${name}.tsr`)));
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
