import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeShare, encodeShare } from '../src/share.ts';

test('a share link round-trips code, input, tab and step', async () => {
  const state = { code: 'class A {\n  // ünïcödé ✓ "quotes" + / =\n}\n'.repeat(50), stdin: '5\n', tab: 'tree', step: 42 };
  const hash = await encodeShare(state);
  assert.match(hash, /^#s=[A-Za-z0-9_-]+$/); // URL-safe, no padding
  assert.ok(hash.length < state.code.length / 4, 'repetitive code compresses well');
  assert.deepEqual(await decodeShare(hash), state);
});

test('anything that is not a share link decodes to null', async () => {
  assert.equal(await decodeShare(''), null);
  assert.equal(await decodeShare('#other'), null);
  assert.equal(await decodeShare('#s=not-deflate-data'), null);
  assert.equal(await decodeShare(await encodeShare({ code: 1 } as never)), null);
});

test('bad tab and step values are dropped', async () => {
  const hash = await encodeShare({ code: 'x', tab: 7, step: -3 } as never);
  assert.deepEqual(await decodeShare(hash), { code: 'x', stdin: undefined, tab: undefined, step: undefined });
});
