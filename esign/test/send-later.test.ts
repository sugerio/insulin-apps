// Send later's day and time (member/SendLater.ts) are the member's own: a time their clocks skip, when they spring
// forward, isn't moved to another one, it is asked for again. In-process, in a time zone with daylight saving time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { SendLaterDialog } from '../src/app/member/SendLater.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('a time the clocks skip is refused, not moved', async () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const scheduled: string[] = [];
    let renderer!: Renderer.ReactTestRenderer;
    await act(async () => { renderer = Renderer.create(React.createElement(SendLaterDialog, { open: true, busy: false, onClose: () => {}, onSchedule: (iso: string) => scheduled.push(iso) }), { createNodeMock: () => ({ focus() {} }) }); });
    const field = (id: string) => renderer.root.find((n) => n.props.id === id);
    const set = async (id: string, value: string) => { await act(async () => { field(id).props.onChange({ target: { value } }); }); };
    const schedule = async () => { await act(async () => { renderer.root.find((n) => n.type === 'button' && n.props.children?.includes?.('Schedule')).props.onClick(); }); };
    // The next second Sunday of March, 02:30: in Los Angeles the clocks go from 02:00 straight to 03:00.
    const springForward = (year: number) => { const first = new Date(year, 2, 1).getDay(); return `${year}-03-${String(1 + (7 - first) % 7 + 7).padStart(2, '0')}`; };
    const thisYear = new Date().getFullYear();
    const day = Date.parse(`${springForward(thisYear)}T00:00`) > Date.now() + 86_400_000 ? springForward(thisYear) : springForward(thisYear + 1);
    await set('send-later-day', day);
    await set('send-later-time', '02:30');
    await schedule();
    assert.deepEqual(scheduled, [], 'not scheduled for 03:30 instead');
    assert.match(JSON.stringify(renderer.toJSON()), /doesn.t exist/);
    await set('send-later-time', '03:30');
    await schedule();
    assert.deepEqual(scheduled, [`${day}T10:30:00.000Z`], 'daylight saving time: seven hours behind UTC');
    await act(async () => { renderer.unmount(); });
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});
