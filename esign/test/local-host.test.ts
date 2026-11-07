import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedHostRequest, startLocalHost } from '../scripts/local-host.ts';

test('local host BFF accepts only explicit same-origin loopback requests and fixed API routes', () => {
  const good = {host:'127.0.0.1:8788',origin:'http://127.0.0.1:5173', 'x-local-esign':'1'};
  assert.equal(allowedHostRequest(good,'GET','/host/templates?cursor='),true);
  assert.equal(allowedHostRequest(good,'GET','/host/templates?cursor=abc-123'),true);
  assert.equal(allowedHostRequest(good,'GET','/host/templates?cursor=abc&other=1'),false);
  assert.equal(allowedHostRequest(good,'GET','/host/envelopes/123'),true);
  assert.equal(allowedHostRequest(good,'GET','/host/envelopes/123/certificate'),true);
  assert.equal(allowedHostRequest(good,'POST','/host/envelopes/123/certificate'),false);
  assert.equal(allowedHostRequest({...good,'x-local-esign':undefined},'GET','/host/envelopes/123'),false);
  assert.equal(allowedHostRequest({...good,'sec-fetch-site':'cross-site'},'GET','/host/envelopes/123'),false);
  assert.equal(allowedHostRequest({...good,origin:'http://evil.test'},'GET','/host/envelopes/123'),false);
  assert.equal(allowedHostRequest({...good,host:'evil.test:8788'},'GET','/host/envelopes/123'),false);
  assert.equal(allowedHostRequest(good,'GET','/host/../../v1/me'),false);
  assert.equal(allowedHostRequest(good,'POST','/host/envelopes/123/tasks/456/recipient-view'),true);
  assert.equal(allowedHostRequest(good,'GET','/host/envelopes/123/tasks/456/recipient-view'),false);
  assert.equal(allowedHostRequest(good,'POST','/host/synthetic/create'),true);
  assert.equal(allowedHostRequest(good,'POST','/host/synthetic/envelopes/123/seal'),true);
  assert.equal(allowedHostRequest(good,'POST','/host/synthetic/v1/templates'),false);
  assert.equal(allowedHostRequest(good,'POST','/host/synthetic/v1/signing/sign'),true);
  assert.equal(allowedHostRequest({...good,origin:'http://evil.test'},'POST','/host/synthetic/create'),false);
});

test('BFF refuses startup without explicit local flag and key',()=>{
  const old=process.env.ESIGN_LOCAL_HOST;
  try {delete process.env.ESIGN_LOCAL_HOST;assert.throws(()=>startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz'));process.env.ESIGN_LOCAL_HOST='true';assert.throws(()=>startLocalHost('short'));}
  finally {if(old===undefined) delete process.env.ESIGN_LOCAL_HOST;else process.env.ESIGN_LOCAL_HOST=old;}
});

test('editor host fixes parent origin rather than trusting the browser',async()=>{
 const {editorHostSessionBody}=await import('../scripts/local-host.ts');
 const value=editorHostSessionBody(JSON.stringify({allowedParentOrigin:'http://evil.test',roles:['Partner','Seller']}),'http://127.0.0.1:5173');
 assert.equal(JSON.parse(value).allowedParentOrigin,'http://127.0.0.1:5173');
 assert.deepEqual(JSON.parse(value).roles,['Partner','Seller']);
 assert.throws(()=>editorHostSessionBody('[]','http://127.0.0.1:5173'));
});

test('editor host forwards a source URL in the JSON body only',async()=>{
 const {editorHostSessionBody}=await import('../scripts/local-host.ts');
 const input=JSON.stringify({sourceUrl:'https://files.example.com/document.pdf?sig=synthetic-token',roles:['Signer']});
 assert.deepEqual(JSON.parse(editorHostSessionBody(input,'http://127.0.0.1:5173')),{allowedParentOrigin:'http://127.0.0.1:5173',roles:['Signer'],sourceUrl:'https://files.example.com/document.pdf?sig=synthetic-token'});
});
