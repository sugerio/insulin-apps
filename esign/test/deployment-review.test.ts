import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policies = Object.fromEntries([
  'CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS','CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT','CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT',
  'CANDIDATE_TEMPLATE_WINDOW_MS','CANDIDATE_TEMPLATE_TENANT_LIMIT','CANDIDATE_TEMPLATE_DATABASE_LIMIT','CANDIDATE_TEMPLATE_RETAINED_LIMIT','CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT',
  'CANDIDATE_PROVISION_WINDOW_MS','CANDIDATE_PROVISION_TENANT_LIMIT','CANDIDATE_PROVISION_DATABASE_LIMIT','CANDIDATE_PROVISION_RETAINED_LIMIT',
  'TEST_EDITOR_WINDOW_MS','TEST_EDITOR_TENANT_ISSUANCE','TEST_EDITOR_DATABASE_ISSUANCE','TEST_EDITOR_TENANT_OUTSTANDING','TEST_EDITOR_DATABASE_OUTSTANDING','TEST_EDITOR_TENANT_RETAINED','TEST_EDITOR_DATABASE_RETAINED',
  'TEST_ISSUANCE_WINDOW_MS','TEST_ISSUANCE_TENANT_LIMIT','TEST_ISSUANCE_DATABASE_LIMIT','TEST_OUTSTANDING_TENANT_LIMIT','TEST_OUTSTANDING_DATABASE_LIMIT'
].map(n => [n, n.endsWith('WINDOW_MS') ? '60000' : '1']));
const fixture = () => ({
  accountId:'synthetic-account', candidateService:'synthetic-candidate', databaseId:'synthetic-database', bucketName:'synthetic-bucket',
  managementCredentialHashProvisionedSeparately:true, policies,
  isolatedOtpRecipients:['one@example.test','two@example.test'],
  pageOrigin:'https://pages.example.test', editorGatewayOrigin:'https://editor.example.test', recipientGatewayOrigin:'https://recipient.example.test',
  buildEditorGatewayOrigin:'https://editor.example.test', buildRecipientGatewayOrigin:'https://recipient.example.test',
  runtimeEditorGatewayOrigin:'https://editor.example.test', runtimeRecipientGatewayOrigin:'https://recipient.example.test',
  trustedEditorOrigins:['https://pages.example.test'], trustedRecipientOrigins:['https://pages.example.test'],
  assets:{ binding:'ASSETS', directory:'client', runWorkerFirst:true, directAccess:false },
  gateways:{ management:{binding:'PRIVATE_MANAGEMENT', service:'synthetic-candidate', entrypoint:'PrivateManagement', limiter:{namespaceId:'synthetic-1',limit:1,period:60},locationLimiter:{namespaceId:'synthetic-4',limit:1,period:60}}, editor:{binding:'PRIVATE_EDITOR',service:'synthetic-candidate',entrypoint:'PrivateEditor',limiter:{namespaceId:'synthetic-2',limit:1,period:60},locationLimiter:{namespaceId:'synthetic-5',limit:1,period:60}}, recipient:{binding:'PRIVATE_RECIPIENT',service:'synthetic-candidate',entrypoint:'PrivateRecipient',limiter:{namespaceId:'synthetic-3',limit:1,period:60},locationLimiter:{namespaceId:'synthetic-6',limit:1,period:60}} },
  noLocalDemoFallback:true, noTestFallback:true, mailDisabled:true, tsaDisabled:true,
  policiesReviewed:true, isolatedResources:true, edgeOnlyIngress:true, independentReviewRequired:true
});

test('offline deployment review fails closed and never echoes input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esign-review-'));
  try {
    const path = join(dir, 'worksheet.json');
    const run = (v: unknown) => { writeFileSync(path, JSON.stringify(v)); return spawnSync(process.execPath, ['scripts/check-deployment-review.ts', path], {encoding:'utf8'}); };
    const ok = run(fixture()); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /UNSEALED/); assert.match(ok.stdout, /TSA_NOT_SUPPORTED/);
    const variants: unknown[] = [ {...fixture(),gateways:{...fixture().gateways,editor:{...fixture().gateways.editor,locationLimiter:{namespaceId:'synthetic-1',limit:1,period:60}}}}, {}, {...fixture(), databaseId:''}, {...fixture(), managementCredentialHashProvisionedSeparately:false}, {...fixture(), policies:{...policies, TEST_EDITOR_WINDOW_MS:'1'}}, {...fixture(), assets:{...fixture().assets,runWorkerFirst:false}}, {...fixture(), runtimeEditorGatewayOrigin:'https://wrong.example.test'}, {...fixture(), noTestFallback:false}, {...fixture(), mailDisabled:false}, {...fixture(), gateways:{...fixture().gateways, editor:{...fixture().gateways.editor,entrypoint:'PrivateManagement'}}}, {...fixture(), secret:'do-not-print-this-secret'} ];
    for (const value of variants) { const result = run(value); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-this-secret|synthetic-account|synthetic-database/); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
