import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '@calimero-network/mero-js';
import { decodeFunctionCallErrorData, textResult, toMessage } from './errors.ts';

test('decodeFunctionCallErrorData unwraps a JSON-quoted guest message embedded in a Debug-formatted string', () => {
  const bytes = [...Buffer.from('"boom"', 'utf8')];
  assert.equal(decodeFunctionCallErrorData(`the method call returned an error: ${JSON.stringify(bytes)}`), 'boom');
});

test('decodeFunctionCallErrorData falls back to the raw decoded text when it is not JSON-quoted', () => {
  const bytes = [...Buffer.from('boom', 'utf8')];
  assert.equal(decodeFunctionCallErrorData(`the method call returned an error: ${JSON.stringify(bytes)}`), 'boom');
});

test('decodeFunctionCallErrorData returns undefined for non-string or absent data', () => {
  assert.equal(decodeFunctionCallErrorData(undefined), undefined);
  assert.equal(decodeFunctionCallErrorData(42), undefined);
});

test('decodeFunctionCallErrorData surfaces a plain-string guest panic, no byte array involved', () => {
  const data = 'guest panicked: key not found at apps/kv-store/src/lib.rs:133:33';
  assert.equal(decodeFunctionCallErrorData(data), data);
});

test('decodeFunctionCallErrorData surfaces any bracket-free string as-is (a defensible over-surface, not a Debug blob)', () => {
  assert.equal(decodeFunctionCallErrorData('no brackets here'), 'no brackets here');
});

test('decodeFunctionCallErrorData treats blank data (empty or whitespace-only) as no message', () => {
  assert.equal(decodeFunctionCallErrorData(''), undefined);
  assert.equal(decodeFunctionCallErrorData('   '), undefined);
});

test('toMessage unwraps a FunctionCallError-typed RpcError into the guest message', () => {
  const bytes = JSON.stringify([...Buffer.from('"label must be at most 64 characters"', 'utf8')]);
  const err = new RpcError(-32000, 'FunctionCallError', `the method call returned an error: ${bytes}`, 'FunctionCallError');
  assert.equal(toMessage(err), 'label must be at most 64 characters');
});

test('toMessage unwraps a FunctionCallError-typed RpcError carrying a plain-string guest panic', () => {
  const data = 'guest panicked: key not found at apps/kv-store/src/lib.rs:133:33';
  const err = new RpcError(-32000, 'FunctionCallError', data, 'FunctionCallError');
  assert.equal(toMessage(err), data);
});

test('toMessage leaves a non-FunctionCallError RpcError untouched, using its own message', () => {
  const err = new RpcError(-32000, 'internal error', 'irrelevant data', 'InternalError');
  assert.equal(toMessage(err), 'internal error');
});

test('toMessage passes a plain Error through unchanged', () => {
  assert.equal(toMessage(new Error('boom')), 'boom');
});

test('textResult(undefined) yields the string "null", not the literal undefined', () => {
  assert.equal(textResult(undefined).content[0].text, 'null');
});
