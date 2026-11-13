import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, stripEscapes } from '../../../src/cli/render.ts';

test('stripEscapes removes terminal control sequences but keeps text, newlines and tabs', () => {
  const bel = String.fromCharCode(7),
    backslash = String.fromCharCode(92),
    esc = String.fromCharCode(27);
  const text =
    'A' +
    esc +
    ']0;EVIL' +
    bel +
    'B' +
    esc +
    '[?25lC' +
    esc +
    ']52;c;PGJhc2U2ND4=' +
    bel +
    'D' +
    esc +
    '[2J' +
    esc +
    '[HE' +
    esc +
    'P+q' +
    esc +
    backslash +
    'F' +
    '\r\x00' +
    bel +
    '\tG\nH';
  assert.equal(stripEscapes(text), 'ABCDEF\tG\nH');
});
test('stripEscapes keeps ordinary ANSI-free text intact', () => {
  assert.equal(stripEscapes('plain 中文 text'), 'plain 中文 text');
});
test('renderer strips escapes from model deltas, tool output and errors', () => {
  const out: string[] = [];
  const render = createRenderer({ write: (s) => out.push(s) });
  render({ type: 'stream', event: { type: 'textDelta', text: '\x1b]0;hijack\x07visible' } } as never);
  render({
    type: 'toolEnd',
    result: {
      isError: true,
      content: [{ type: 'text', text: '\x1b[?25lrow' }],
      details: { diff: '+\x1b]0;x\x07added' },
    },
  } as never);
  render({ type: 'agentEnd', reason: 'error', error: '\x1b]0;t\x07boom' } as never);
  const all = out.join('');
  assert.match(all, /visible/);
  assert.match(all, /row/);
  assert.match(all, /added/);
  assert.match(all, /boom/);
  assert.ok(!all.includes('\x1b]'), 'no OSC sequences may reach the terminal');
});
test('renderer truncates very long tool output lines', () => {
  const out: string[] = [];
  const render = createRenderer({ write: (s) => out.push(s) });
  render({
    type: 'toolEnd',
    result: { isError: false, content: [{ type: 'text', text: 'x'.repeat(5000) }] },
  } as never);
  assert.ok(out.join('').length < 3000);
});
