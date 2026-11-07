import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('workers.dev topology generator rejects unsafe inputs and emits isolated configurations', () => {
 const dir=mkdtempSync(join(tmpdir(),'esign-topology-'));
 try {
  const input=join(dir,'input.json');
  const fixture={subdomain:'synthetic',candidate:'synthetic-candidate',management:'synthetic-management',editor:'synthetic-editor',recipient:'synthetic-recipient',page:'synthetic-page',namesAvailable:true,namespaceIds:['1001','1002','1003'],budgetNamespaceIds:['2001','2002','2003']};
  const run=(v:unknown)=>{writeFileSync(input,JSON.stringify(v));return spawnSync(process.execPath,['scripts/workers-dev-topology.ts',input],{encoding:'utf8'});};
  const ok=run(fixture); assert.equal(ok.status,0,ok.stderr);
  const result=JSON.parse(ok.stdout);
  assert.equal(result.management.workers_dev,false); assert.equal(result.management.preview_urls,false);
  assert.equal(result.editor.services[0].entrypoint,'PrivateEditor'); assert.equal(result.recipient.services[0].entrypoint,'PrivateRecipient');
  assert.equal(result.management.services[0].entrypoint,'PrivateManagement');
  assert.equal(result.page.assets.run_worker_first,true); assert.equal(result.page.assets.directory,'./dist-candidate-assets/client');
  assert.equal(result.page.vars.EDITOR_GATEWAY_ORIGIN,'https://synthetic-editor.synthetic.workers.dev');
  assert.equal(result.editor.vars.TRUSTED_EDITOR_ORIGINS,'https://synthetic-page.synthetic.workers.dev');
  for(const k of ['editor','recipient','page']) {assert.equal(result[k].workers_dev,true);assert.equal(result[k].preview_urls,false); assert.ok(!Object.keys(result[k].vars).some(key=>key.endsWith('_ENABLED')));}
  assert.deepEqual(['management','editor','recipient'].map(k=>result[k].ratelimits[0].simple),[{limit:20,period:60},{limit:40,period:60},{limit:60,period:60}]);
  assert.deepEqual(['management','editor','recipient'].map(k=>result[k].ratelimits[0].namespace_id),fixture.namespaceIds);
  assert.deepEqual(['management','editor','recipient'].map(k=>result[k].ratelimits[1].namespace_id),fixture.budgetNamespaceIds);
  assert.deepEqual(['management','editor','recipient'].map(k=>result[k].ratelimits[1].simple),[{limit:20,period:60},{limit:40,period:60},{limit:60,period:60}]);
  assert.notEqual(run({...fixture,budgetNamespaceIds:['1001','2002','2003']}).status,0);
  assert.equal(result.recipient.vars.TRUSTED_RECIPIENT_ORIGINS,result.editor.vars.TRUSTED_EDITOR_ORIGINS);
  for(const k of ['management','editor','recipient']) assert.equal(result[k].services[0].service,fixture.candidate);
  for(const v of [{...fixture,namesAvailable:false},{...fixture,editor:fixture.page},{...fixture,namespaceIds:['1','1','2']},{...fixture,subdomain:'bad.example.com'},{...fixture,secret:'no'}]) assert.notEqual(run(v).status,0);
  const candidate=JSON.parse(readFileSync('wrangler.candidate.jsonc','utf8'));
  assert.equal(candidate.workers_dev,false); assert.equal(candidate.preview_urls,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
