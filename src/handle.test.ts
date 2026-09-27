import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { guideHash, handleKeeper } from './handle.ts';

const PAYLOAD = { a: 'BlocksAppId', p: 'com.example.blocks', v: '1.2.0', g: guideHash('## Overview'), c: 'Ctx111', s: null };

test('a handle reads back as the payload it was issued with', () => {
  const keeper = handleKeeper(randomBytes(32));
  assert.deepEqual(keeper.read(keeper.issue(PAYLOAD)), PAYLOAD);
});

test('a handle with an edited payload, an edited mac, another key, or no dot is not read', () => {
  const keeper = handleKeeper(randomBytes(32));
  const handle = keeper.issue(PAYLOAD);
  const [body, mac] = handle.split('.');
  const forged = `${Buffer.from(JSON.stringify({ ...PAYLOAD, c: 'Ctx999' })).toString('base64url')}.${mac}`;
  assert.equal(keeper.read(forged), undefined);
  const flipped = Buffer.from(mac, 'base64url');
  flipped[0] ^= 1;
  assert.equal(keeper.read(`${body}.${flipped.toString('base64url')}`), undefined);
  assert.equal(handleKeeper(randomBytes(32)).read(handle), undefined);
  assert.equal(keeper.read(handle.replace('.', '')), undefined);
  assert.equal(keeper.read(`${handle}.x`), undefined);
  assert.equal(keeper.read(undefined), undefined);
  assert.equal(keeper.read(42), undefined);
});
