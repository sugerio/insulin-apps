// Offline worksheet validation only; this never reads or queries deployed resources.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const fail = (): never => { throw new Error('invalid worksheet'); };
const object = (value: unknown, keys: string[]): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return fail();
  return value as Record<string, any>;
};
const text = (v: unknown) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 256;
const origin = (v: unknown) => { if (!text(v)) return false; try { const u = new URL(v as string); return u.protocol === 'https:' && u.origin === v && !u.username && !u.password; } catch { return false; } };
const yes = (v: unknown) => { if (v !== true) fail(); };
const policyNames = [
  'CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS','CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT','CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT',
  'CANDIDATE_TEMPLATE_WINDOW_MS','CANDIDATE_TEMPLATE_TENANT_LIMIT','CANDIDATE_TEMPLATE_DATABASE_LIMIT','CANDIDATE_TEMPLATE_RETAINED_LIMIT','CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT',
  'CANDIDATE_PROVISION_WINDOW_MS','CANDIDATE_PROVISION_TENANT_LIMIT','CANDIDATE_PROVISION_DATABASE_LIMIT','CANDIDATE_PROVISION_RETAINED_LIMIT',
  'TEST_EDITOR_WINDOW_MS','TEST_EDITOR_TENANT_ISSUANCE','TEST_EDITOR_DATABASE_ISSUANCE','TEST_EDITOR_TENANT_OUTSTANDING','TEST_EDITOR_DATABASE_OUTSTANDING','TEST_EDITOR_TENANT_RETAINED','TEST_EDITOR_DATABASE_RETAINED',
  'TEST_ISSUANCE_WINDOW_MS','TEST_ISSUANCE_TENANT_LIMIT','TEST_ISSUANCE_DATABASE_LIMIT','TEST_OUTSTANDING_TENANT_LIMIT','TEST_OUTSTANDING_DATABASE_LIMIT'
];
export function validate(value: unknown) {
  const w = object(value, ['accountId','candidateService','databaseId','bucketName','managementCredentialHashProvisionedSeparately','policies','isolatedOtpRecipients','pageOrigin','editorGatewayOrigin','recipientGatewayOrigin','buildEditorGatewayOrigin','buildRecipientGatewayOrigin','runtimeEditorGatewayOrigin','runtimeRecipientGatewayOrigin','trustedEditorOrigins','trustedRecipientOrigins','assets','gateways','noLocalDemoFallback','noTestFallback','mailDisabled','tsaDisabled','policiesReviewed','isolatedResources','edgeOnlyIngress','independentReviewRequired']);
  for (const k of ['accountId','candidateService','databaseId','bucketName']) if (!text(w[k])) fail();
  for (const k of ['managementCredentialHashProvisionedSeparately','noLocalDemoFallback','noTestFallback','mailDisabled','tsaDisabled','policiesReviewed','isolatedResources','edgeOnlyIngress','independentReviewRequired']) yes(w[k]);
  const p = object(w.policies, policyNames);
  for (const name of policyNames) {
    const raw = p[name]; if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) fail();
    const n = Number(raw), window = name.endsWith('WINDOW_MS');
    const max = window ? 86400000 : name.startsWith('TEST_EDITOR_') || name.includes('RETAINED') ? 10000 : name.startsWith('TEST_') ? 100000 : 1000;
    if (!Number.isSafeInteger(n) || n < (window ? 60000 : 1) || n > max) fail();
  }
  const recipients = w.isolatedOtpRecipients;
  if (!Array.isArray(recipients) || recipients.length !== 2 || recipients[0] === recipients[1] || recipients.some((x: unknown) => typeof x !== 'string' || x.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.test$/.test(x))) fail();
  for (const k of ['pageOrigin','editorGatewayOrigin','recipientGatewayOrigin','buildEditorGatewayOrigin','buildRecipientGatewayOrigin','runtimeEditorGatewayOrigin','runtimeRecipientGatewayOrigin']) if (!origin(w[k])) fail();
  for (const kind of ['Editor','Recipient']) {
    const base = w[`${kind.toLowerCase()}GatewayOrigin`];
    if (w[`build${kind}GatewayOrigin`] !== base || w[`runtime${kind}GatewayOrigin`] !== base) fail();
    const trusted = w[`trusted${kind}Origins`]; if (!Array.isArray(trusted) || trusted.length !== 1 || trusted[0] !== w.pageOrigin) fail();
  }
  const assets = object(w.assets, ['binding','directory','runWorkerFirst','directAccess']);
  if (assets.binding !== 'ASSETS' || assets.directory !== 'client' || assets.runWorkerFirst !== true || assets.directAccess !== false) fail();
  const gateways = object(w.gateways, ['management','editor','recipient']);
  const namespaces = new Set();
  for (const [kind, binding, entrypoint] of [['management','PRIVATE_MANAGEMENT','PrivateManagement'],['editor','PRIVATE_EDITOR','PrivateEditor'],['recipient','PRIVATE_RECIPIENT','PrivateRecipient']]) {
    const g = object(gateways[kind], ['binding','service','entrypoint','limiter','locationLimiter']);
    if (g.binding !== binding || g.service !== w.candidateService || g.entrypoint !== entrypoint) fail();
    for (const policy of [g.limiter,g.locationLimiter]) {
    const limiter = object(policy, ['namespaceId','limit','period']);
    if (!text(limiter.namespaceId) || namespaces.has(limiter.namespaceId) || !Number.isSafeInteger(limiter.limit) || limiter.limit < 1 || ![10,60].includes(limiter.period)) fail();
    namespaces.add(limiter.namespaceId);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  if (process.argv.length !== 3) fail();
  validate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('Offline assertions only; no cloud configuration or credential entropy verified. No deployment approval. UNSEALED; TSA_NOT_SUPPORTED. Mail/OTP unavailable.');
} catch {
  console.error('Offline worksheet rejected. No deployment approval; inspect the documented schema privately.');
  process.exitCode = 1;
}
