import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as editorClient from '../src/app/ui/editor-client.ts';

test('editor demo accepts the configured local Worker or same-origin HTTPS Worker only', () => {
 const validate = (editorClient as Record<string, unknown>).editorDemoURL;
 assert.equal(typeof validate, 'function', 'editor demo must validate URLs for local and same-origin Worker environments');
 const editorDemoURL = validate as (host: string, url: string, sessionId: string) => string;
 const id = 'a'.repeat(64), code = 'b'.repeat(64);
 const link = (origin: string) => `${origin}/editor/page/${id}#${code}`;
 assert.equal(editorDemoURL('http://127.0.0.1:5173', link('http://127.0.0.1:8787'), id), link('http://127.0.0.1:8787'));
 assert.equal(editorDemoURL('https://demo.example.test', link('https://demo.example.test'), id), link('https://demo.example.test'));
 for (const [host, url, session] of [
  ['https://demo.example.test', link('https://other.example.test'), id],
  ['http://demo.example.test', link('http://demo.example.test'), id],
  ['http://127.0.0.1:5173', link('http://127.0.0.1:8797'), id],
  ['http://127.0.0.1:5197', link('http://127.0.0.1:8797'), id],
  ['https://demo.example.test', `https://user@demo.example.test/editor/page/${id}#${code}`, id],
  ['https://demo.example.test', `https://demo.example.test/editor/page/${id}?secret=1#${code}`, id],
  ['https://demo.example.test', link('https://demo.example.test'), 'c'.repeat(64)],
  ['https://demo.example.test', `https://demo.example.test/editor/page/${id}#bad`, id],
 ]) assert.throws(() => editorDemoURL(host, url, session));
});
