import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '@calimero-network/mero-js';
import { decodeFunctionCallErrorData, toMessage } from './errors.ts';

test('decodeFunctionCallErrorData unwraps a JSON-quoted guest message embedded in a Debug-formatted string', () => {
  const bytes = [...Buffer.from('"boom"', 'utf8')];
  assert.equal(decodeFunctionCallErrorData(`the method call returned an error: ${JSON.stringify(bytes)}`), 'boom');
});

test('decodeFunctionCallErrorData falls back to the raw decoded text when it is not JSON-quoted', () => {
  const bytes = [...Buffer.from('boom', 'utf8')];
  assert.equal(decodeFunctionCallErrorData(`the method call returned an error: ${JSON.stringify(bytes)}`), 'boom');
});

test('decodeFunctionCallErrorData returns undefined for non-string, absent, or non-array data', () => {
  assert.equal(decodeFunctionCallErrorData(undefined), undefined);
  assert.equal(decodeFunctionCallErrorData(42), undefined);
  assert.equal(decodeFunctionCallErrorData('no brackets here'), undefined);
});

test('toMessage unwraps a FunctionCallError-typed RpcError into the guest message', () => {
  const bytes = JSON.stringify([...Buffer.from('"label must be at most 64 characters"', 'utf8')]);
  const err = new RpcError(-32000, 'FunctionCallError', `the method call returned an error: ${bytes}`, 'FunctionCallError');
  assert.equal(toMessage(err), 'label must be at most 64 characters');
});

test('toMessage passes a plain Error through unchanged', () => {
  assert.equal(toMessage(new Error('boom')), 'boom');
});
