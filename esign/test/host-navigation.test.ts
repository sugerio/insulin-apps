import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HostPage} from '../ui/HostPage.ts';

test('signing host does not advertise separate seal experiments',()=>{
 const html=renderToStaticMarkup(React.createElement(HostPage));
 assert.ok(!html.includes('href="/synthetic.html"'));
 assert.ok(!html.includes('href="/upload.html"'));
});
