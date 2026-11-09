import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FieldEditor} from '../ui/FieldEditor.ts';
import {readFile} from 'node:fs/promises';

test('embedded editor has no upload or save buttons; host owns both',async()=>{
 const editor=renderToStaticMarkup(React.createElement(FieldEditor,{embedded:true,onSave:async()=>{}}));
 assert.doesNotMatch(editor,/type="file"|Save template/);
 const host=await readFile(new URL('./fixtures/editor-host.html',import.meta.url),'utf8');
 assert.match(host,/type="file"/);assert.match(host,/>Save template<\/button>/);
});
