import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consumeCandidateEditorFragment,candidateEditorGateway} from '../ui/candidate-editor-client.ts';

test('candidate editor strips fragment before validating and only accepts an HTTPS gateway origin',()=>{
 const pageId='a'.repeat(64),code='b'.repeat(64);let replaced='';
 assert.deepEqual(consumeCandidateEditorFragment({hash:`#pageId=${pageId}&code=${code}`,pathname:'/candidate-editor.html',search:''},{replaceState(_d,_u,url){replaced=url;}}),{pageId,code});
 assert.equal(replaced,'/candidate-editor.html');
 assert.throws(()=>consumeCandidateEditorFragment({hash:'#pageId=bad',pathname:'/candidate-editor.html',search:''},{replaceState(_d,_u,url){replaced=url;}}));
 assert.equal(replaced,'/candidate-editor.html');
 assert.equal(candidateEditorGateway('https://editor.example.test'),'https://editor.example.test');
 for(const invalid of ['','http://editor.example.test','https://editor.example.test/path','https://editor.example.test/'])assert.throws(()=>candidateEditorGateway(invalid));
});
