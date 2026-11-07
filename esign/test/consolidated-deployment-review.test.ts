import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const names = ['CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS','CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT','CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT','CANDIDATE_TEMPLATE_WINDOW_MS','CANDIDATE_TEMPLATE_TENANT_LIMIT','CANDIDATE_TEMPLATE_DATABASE_LIMIT','CANDIDATE_TEMPLATE_RETAINED_LIMIT','CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT','CANDIDATE_PROVISION_WINDOW_MS','CANDIDATE_PROVISION_TENANT_LIMIT','CANDIDATE_PROVISION_DATABASE_LIMIT','CANDIDATE_PROVISION_RETAINED_LIMIT','TEST_EDITOR_WINDOW_MS','TEST_EDITOR_TENANT_ISSUANCE','TEST_EDITOR_DATABASE_ISSUANCE','TEST_EDITOR_TENANT_OUTSTANDING','TEST_EDITOR_DATABASE_OUTSTANDING','TEST_EDITOR_TENANT_RETAINED','TEST_EDITOR_DATABASE_RETAINED','TEST_ISSUANCE_WINDOW_MS','TEST_ISSUANCE_TENANT_LIMIT','TEST_ISSUANCE_DATABASE_LIMIT','TEST_OUTSTANDING_TENANT_LIMIT','TEST_OUTSTANDING_DATABASE_LIMIT'];
const bindings = ['MANAGEMENT_RATE_LIMITER','MANAGEMENT_LOCATION_RATE_LIMITER','EDITOR_RATE_LIMITER','EDITOR_LOCATION_RATE_LIMITER','RECIPIENT_RATE_LIMITER','RECIPIENT_LOCATION_RATE_LIMITER'];
const fixture = () => ({
  accountId:'synthetic-account', workerName:'synthetic-worker', databaseId:'synthetic-database', bucketName:'synthetic-bucket',
  managementCredentialHashProvisionedSeparately:true, managementBackendAuthenticatedAndAuthorized:true,
  policies:Object.fromEntries(names.map(n => [n,n.endsWith('WINDOW_MS')?'60000':'1'])), isolatedOtpRecipients:['one@example.test','two@example.test'],
  pageOrigin:'https://app.example.test', requestOrigin:'https://app.example.test', editorGatewayOrigin:'https://app.example.test', recipientGatewayOrigin:'https://app.example.test', buildEditorGatewayOrigin:'https://app.example.test', buildRecipientGatewayOrigin:'https://app.example.test', runtimeEditorGatewayOrigin:'https://app.example.test', runtimeRecipientGatewayOrigin:'https://app.example.test', trustedEditorOrigins:['https://app.example.test'], trustedRecipientOrigins:['https://app.example.test'],
  assets:{binding:'ASSETS',directory:'client',runWorkerFirst:true,directAccess:false},
  limiters:Object.fromEntries(bindings.map((name,i) => [name,{namespaceId:`synthetic-${i}`,limit:1,period:60}])),
  noLocalDemoFallback:true,noTestFallback:true,mailDisabled:true,otpDisabled:true,tsaDisabled:true,policiesReviewed:true,isolatedResources:true,edgeOnlyIngress:true,independentReviewRequired:true
});
test('consolidated offline worksheet rejects mismatches and never echoes input', () => {
 const dir=mkdtempSync(join(tmpdir(),'esign-consolidated-review-'));
 try {
  const path=join(dir,'worksheet.json');
  const run=(v:unknown)=>{writeFileSync(path,JSON.stringify(v));return spawnSync(process.execPath,['scripts/check-consolidated-deployment-review.ts',path],{encoding:'utf8'});};
  const ok=run(fixture()); assert.equal(ok.status,0,ok.stderr); assert.match(ok.stdout,/No deployment approval/);
  const f=fixture();
  const maxLength={...f,isolatedOtpRecipients:['a'.repeat(241)+'@example.test','two@example.test']};
  assert.equal(maxLength.isolatedOtpRecipients[0].length,254);
  assert.equal(run(maxLength).status,0,'addresses of 254 characters are allowed');
  const overlength={...f,isolatedOtpRecipients:['a'.repeat(242)+'@example.test','two@example.test']};
  assert.equal(overlength.isolatedOtpRecipients[0].length,255);
  assert.notEqual(run(overlength).status,0,'addresses over 254 characters must be rejected');
  const bad=[{}, {...f,requestOrigin:'https://other.example.test'}, {...f,buildEditorGatewayOrigin:'https://other.example.test'}, {...f,trustedRecipientOrigins:['https://other.example.test']}, {...f,pageOrigin:'https://app.example.test/'}, {...f,assets:{...f.assets,runWorkerFirst:false}}, {...f,assets:{...f.assets,directAccess:true}}, {...f,limiters:{...f.limiters,EDITOR_RATE_LIMITER:f.limiters.MANAGEMENT_RATE_LIMITER}}, {...f,limiters:{...f.limiters,UNKNOWN:f.limiters.EDITOR_RATE_LIMITER}}, {...f,databaseId:''}, {...f,workerName:''}, {...f,otpDisabled:false}, {...f,mailDisabled:false}, {...f,tsaDisabled:false}, {...f,managementCredentialHashProvisionedSeparately:false}, {...f,managementBackendAuthenticatedAndAuthorized:false}, {...f,edgeOnlyIngress:false}, {...f,policies:{...f.policies,TEST_EDITOR_WINDOW_MS:'1'}}, {...f,secret:'do-not-print-this-secret'}];
  for(const v of bad){const result=run(v);assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout+result.stderr,/do-not-print-this-secret|synthetic-account|synthetic-database/);}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
