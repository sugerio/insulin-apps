import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
const save=await import('../src/editor-save.ts').catch(()=>({saveEditorTemplate:undefined,loadEditorTemplate:undefined}));

test('saved template versions retain fields and are tenant isolated and immutable',async()=>{
  assert.equal(typeof save.saveEditorTemplate,'function','editor template saving is missing');
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['FILES']});
  try {
    const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('FILES');
    for(const name of ['0001_tenants.sql','0014_editor_templates.sql']){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
    await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();
    const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
    const field={id:'field-1',type:'Signature',role:'Partner',page:1,required:true,rect:{x:0.1,y:0.2,width:0.2,height:0.1}};
    const one=await save.saveEditorTemplate!(db,bucket,'a',bytes,['Partner'],[field]);
    const two=await save.saveEditorTemplate!(db,bucket,'a',bytes,['Partner'],[field]);
    assert.notEqual(one,two);
    assert.deepEqual((await save.loadEditorTemplate!(db,'a',one)).fields,[field]);
    assert.equal(await save.loadEditorTemplate!(db,'b',one),null);
    await assert.rejects(()=>save.saveEditorTemplate!(db,bucket,'a',bytes,['Other'],[field]));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM editor_templates').first())!.n,2);
  } finally {await mf.dispose();}
});

test('editor saving requires a field for each exact role',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 const field={id:'a',type:'Signature',role:'Partner',page:1,required:true,rect:{x:0,y:0,width:.3,height:.1}};
 const db={} as D1Database,bucket={} as R2Bucket;
 await assert.rejects(()=>save.saveEditorTemplate!(db,bucket,'a',bytes,['Partner'],[]),/role/i);
 await assert.rejects(()=>save.saveEditorTemplate!(db,bucket,'a',bytes,['Partner','Other'],[field]),/role/i);
 await assert.rejects(()=>save.saveEditorTemplate!(db,bucket,'a',bytes,['partner'],[field]));
});
