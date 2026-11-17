// The dialog (components/ui/dialog.ts) keeps the keyboard inside it while it is open and gives focus back to what
// opened it when it closes. In-process, with a stand-in panel and document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Dialog } from '../src/app/components/ui/dialog.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('Tab and Shift+Tab stay inside an open dialog, and closing it gives focus back to its opener', async () => {
  const focused: string[] = [];
  const control = (name: string) => ({ name, focus() { focused.push(name); fake.activeElement = this; } });
  const opener = control('opener'), first = control('first'), last = control('last');
  const fake = { activeElement: opener as unknown, body: { style: { overflow: '' } }, addEventListener() {}, removeEventListener() {} };
  const panel = { focus() { focused.push('panel'); fake.activeElement = panel; }, querySelectorAll: () => [first, last], contains: (node: unknown) => node === first || node === last || node === panel };
  const before = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fake;
  try {
    const dialog = (open: boolean) => React.createElement(Dialog, { open, onOpenChange: () => {}, label: 'Example' }, React.createElement('button', null, 'First'));
    let renderer!: Renderer.ReactTestRenderer;
    await act(async () => { renderer = Renderer.create(dialog(true), { createNodeMock: () => panel }); });
    assert.deepEqual(focused, ['panel'], 'focus moves into the dialog');
    const tab = (shiftKey: boolean) => { let prevented = false; renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Tab', shiftKey, preventDefault: () => { prevented = true; } }); return prevented; };
    fake.activeElement = last;
    assert.equal(tab(false), true);
    assert.equal(fake.activeElement, first, 'Tab from the last control goes to the first');
    assert.equal(tab(true), true);
    assert.equal(fake.activeElement, last, 'Shift+Tab from the first goes to the last');
    await act(async () => { renderer.update(dialog(false)); });
    assert.equal(fake.activeElement, opener, 'closed: focus is back where it was');
    await act(async () => { renderer.unmount(); });
  } finally { (globalThis as { document?: unknown }).document = before; }
});

test('Escape closes the dialog, unless something inside it used that Escape (a list of suggestions closing)', async () => {
  const listeners: ((e: { key: string; defaultPrevented: boolean }) => void)[] = [];
  const fake = { activeElement: null, body: { style: { overflow: '' } }, addEventListener: (_: string, listener: (e: { key: string; defaultPrevented: boolean }) => void) => listeners.push(listener), removeEventListener() {} };
  const before = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fake;
  try {
    const closed: boolean[] = [];
    let renderer!: Renderer.ReactTestRenderer;
    await act(async () => { renderer = Renderer.create(React.createElement(Dialog, { open: true, onOpenChange: (open: boolean) => closed.push(open), label: 'Example' }), { createNodeMock: () => ({ focus() {}, querySelectorAll: () => [] }) }); });
    for (const listener of listeners) listener({ key: 'Escape', defaultPrevented: true });
    assert.deepEqual(closed, [], 'used inside the dialog');
    for (const listener of listeners) listener({ key: 'Escape', defaultPrevented: false });
    assert.deepEqual(closed, [false]);
    await act(async () => { renderer.unmount(); });
  } finally { (globalThis as { document?: unknown }).document = before; }
});

test('an embedded page (the field editor\'s frame) is one of the stops Tab cycles through', async () => {
  const fake = { activeElement: null as unknown, body: { style: { overflow: '' } }, addEventListener() {}, removeEventListener() {} };
  const element = (tag: string) => ({ tag, focus() { fake.activeElement = this; } });
  const frame = element('iframe'), close = element('button'), save = element('button');
  // Answers as the browser would: the controls the selector names, in the page's order.
  const panel = { focus() {}, querySelectorAll: (selector: string) => [frame, close, save].filter((e) => selector.split(',').some((part) => part.trim().split(/[:[]/)[0] === e.tag)) };
  const before = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fake;
  try {
    let renderer!: Renderer.ReactTestRenderer;
    await act(async () => { renderer = Renderer.create(React.createElement(Dialog, { open: true, onOpenChange: () => {}, label: 'Place the fields' }), { createNodeMock: () => panel }); });
    fake.activeElement = save;
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() {} });
    assert.equal(fake.activeElement, frame, 'Tab from the last button goes back to the editor');
    await act(async () => { renderer.unmount(); });
  } finally { (globalThis as { document?: unknown }).document = before; }
});
