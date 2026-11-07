// Offline assertions only: no platform or deployed configuration is inspected.
import { readFileSync } from 'node:fs';
import { validate } from './check-deployment-review.ts';

const fail = (): never => { throw new Error('invalid worksheet'); };
const object = (value: unknown, keys: string[]): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result = value as Record<string, any>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result,key))) return fail();
  return result;
};
const bindingNames = ['MANAGEMENT_RATE_LIMITER','MANAGEMENT_LOCATION_RATE_LIMITER','EDITOR_RATE_LIMITER','EDITOR_LOCATION_RATE_LIMITER','RECIPIENT_RATE_LIMITER','RECIPIENT_LOCATION_RATE_LIMITER'];
function validateConsolidated(value: unknown) {
  const w = object(value, ['accountId','workerName','databaseId','bucketName','managementCredentialHashProvisionedSeparately','managementBackendAuthenticatedAndAuthorized','policies','isolatedOtpRecipients','pageOrigin','requestOrigin','editorGatewayOrigin','recipientGatewayOrigin','buildEditorGatewayOrigin','buildRecipientGatewayOrigin','runtimeEditorGatewayOrigin','runtimeRecipientGatewayOrigin','trustedEditorOrigins','trustedRecipientOrigins','assets','limiters','noLocalDemoFallback','noTestFallback','mailDisabled','otpDisabled','tsaDisabled','policiesReviewed','isolatedResources','edgeOnlyIngress','independentReviewRequired']);
  if (w.managementBackendAuthenticatedAndAuthorized !== true || w.otpDisabled !== true) fail();
  for (const key of ['requestOrigin','editorGatewayOrigin','recipientGatewayOrigin','buildEditorGatewayOrigin','buildRecipientGatewayOrigin','runtimeEditorGatewayOrigin','runtimeRecipientGatewayOrigin']) if (w[key] !== w.pageOrigin) fail();
  const l = object(w.limiters, bindingNames);
  // Reuse the separate topology's quota, resource, origin, asset and limiter policy checks.
  const {workerName, requestOrigin, limiters, managementBackendAuthenticatedAndAuthorized, otpDisabled, ...common} = w;
  validate({...common, candidateService:workerName, gateways:{
    management:{binding:'PRIVATE_MANAGEMENT',service:workerName,entrypoint:'PrivateManagement',limiter:l.MANAGEMENT_RATE_LIMITER,locationLimiter:l.MANAGEMENT_LOCATION_RATE_LIMITER},
    editor:{binding:'PRIVATE_EDITOR',service:workerName,entrypoint:'PrivateEditor',limiter:l.EDITOR_RATE_LIMITER,locationLimiter:l.EDITOR_LOCATION_RATE_LIMITER},
    recipient:{binding:'PRIVATE_RECIPIENT',service:workerName,entrypoint:'PrivateRecipient',limiter:l.RECIPIENT_RATE_LIMITER,locationLimiter:l.RECIPIENT_LOCATION_RATE_LIMITER}
  }});
}
try {
  if (process.argv.length !== 3) fail();
  validateConsolidated(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('Offline assertions only; no cloud configuration or credential entropy verified. No deployment approval. UNSEALED; TSA_NOT_SUPPORTED. Mail/OTP unavailable.');
} catch {
  console.error('Offline worksheet rejected. No deployment approval; inspect the documented schema privately.');
  process.exitCode = 1;
}
