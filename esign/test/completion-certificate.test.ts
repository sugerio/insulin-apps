import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CompletionCertificate} from '../src/app/ui/CompletionCertificate.ts';
const certificate={mode:'LOCAL TEST ONLY',envelope:{id:'envelope',template_id:'template',created_at:1700000000000,status:'COMPLETED'},source:{id:'doc-0',sha256:'a'.repeat(64)},finalArtifactId:'doc-2',finalSha256:'c'.repeat(64),recipients:[{id:'task-1',role:'first',recipient_name:'<img src=x onerror=alert(1)>',recipient_email:'ana@example.com',routing_order:1,status:'SIGNED'},{id:'task-2',role:'second',recipient_name:'Marcus',recipient_email:'marcus@example.com',routing_order:2,status:'SIGNED'}],signatures:[{id:'sig-1',sequence:1,task_id:'task-1',recipient_name:'<img src=x onerror=alert(1)>',input_artifact_id:'doc-0',input_sha256:'a'.repeat(64),otp_verified_at:1700000000000,consented_at:1700000001000,previous_hash:'',event_hash:'d'.repeat(64),artifact_id:'doc-1',sha256:'b'.repeat(64)},{id:'sig-2',sequence:2,task_id:'task-2',recipient_name:'Marcus',input_artifact_id:'doc-1',input_sha256:'b'.repeat(64),otp_verified_at:1700000002000,consented_at:1700000003000,previous_hash:'d'.repeat(64),event_hash:'e'.repeat(64),artifact_id:'doc-2',sha256:'c'.repeat(64)}]};
test('certificate is readable, accurate, and escapes untrusted names',()=>{
  const html=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate}));
  for(const text of ['Certificate of completion','LOCAL TEST ONLY','doc-0','doc-2','Marcus','ana@example.com','2023-11-14T22:13:21.000Z','OTP','consent','manifest','not sealed','not a legal guarantee', 'a'.repeat(64),'e'.repeat(64)]) assert.ok(html.includes(text),text);
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
