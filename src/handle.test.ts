import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { guideHash, handleKeeper } from './handle.ts';

const PAYLOAD = { p: 'com.example.blocks', v: '1.2.0', g: guideHash('## Overview'), c: 'Ctx111', s: null };

test('a handle carries its payload as base64url JSON, then a dot, then a base64url HMAC-SHA256 of that JSON', () => {
  const key = randomBytes(32);
  const handle = handleKeeper(key).issue(PAYLOAD);
  const [body, mac] = handle.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), PAYLOAD);
  assert.equal(Buffer.from(mac, 'base64url').length, 32);
  assert.deepEqual(handleKeeper(key).read(handle), PAYLOAD);
});

test('a handle with an edited payload, an edited mac, another key, or no dot is not read', () => {
  const keeper = handleKeeper(randomBytes(32));
  const handle = keeper.issue(PAYLOAD);
  const [, mac] = handle.split('.');
  const forged = `${Buffer.from(JSON.stringify({ ...PAYLOAD, c: 'Ctx999' })).toString('base64url')}.${mac}`;
  assert.equal(keeper.read(forged), undefined);
  assert.equal(keeper.read(`${handle.slice(0, -2)}AA`), undefined);
  assert.equal(handleKeeper(randomBytes(32)).read(handle), undefined);
  assert.equal(keeper.read(handle.replace('.', '')), undefined);
  assert.equal(keeper.read(`${handle}.x`), undefined);
  assert.equal(keeper.read(undefined), undefined);
  assert.equal(keeper.read(42), undefined);
});

test('guideHash is the first 16 hex of sha256, over the empty string when there is no guide', () => {
  assert.equal(guideHash(undefined), 'e3b0c44298fc1c14');
  assert.equal(guideHash(''), 'e3b0c44298fc1c14');
  assert.match(guideHash('## Overview'), /^[0-9a-f]{16}$/);
  assert.notEqual(guideHash('## Overview'), guideHash('## Overview '));
});
