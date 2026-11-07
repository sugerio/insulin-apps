import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('editor host visibly frames the embedded editor',async()=>{
 const html=await readFile(new URL('../ui/editor-host.html',import.meta.url),'utf8');
 assert.match(html,/<iframe\b[^>]*\bid="editor"[^>]*\bstyle="[^"]*border:3px solid #1e293b/);
});
