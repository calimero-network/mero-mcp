import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as meroJs from '@calimero-network/mero-js';
import { RpcError } from '@calimero-network/mero-js';
import { decodeFunctionCallErrorData, nodeMessage, textResult, toMessage } from './errors.ts';

// HTTPError is absent from mero-js's resolvable types but real at runtime, and toMessage
// keys on its fields, so use the genuine class rather than a stand-in.
type HttpErrorCtor = new (status: number, statusText: string, url: string, headers: Headers, bodyText?: string) => Error;
const { HTTPError } = meroJs as unknown as { HTTPError: HttpErrorCtor };

const ADMIN_URL = 'http://localhost:2528/admin-api/dev/contexts';

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

test("nodeMessage extracts core's `{\"error\": ...}` and nothing else", () => {
  assert.equal(nodeMessage(JSON.stringify({ error: 'namespace not found' })), 'namespace not found');
  assert.equal(nodeMessage(''), undefined);
  assert.equal(nodeMessage(undefined), undefined);
  assert.equal(nodeMessage('<html>502</html>'), undefined);
  assert.equal(nodeMessage(JSON.stringify({ error: '' })), undefined);
  assert.equal(nodeMessage(JSON.stringify({ data: 'ok' })), undefined);
});

test("toMessage surfaces the node's message from the body, whatever the status", () => {
  for (const [status, statusText, body] of [
    [400, 'Bad Request', 'failed to download application: connection refused'],
    [404, 'Not Found', 'context not found'],
    [422, 'Unprocessable Entity', 'invalid context id'],
    [500, 'Internal Server Error', 'namespace NsX is not on this node'],
  ] as const) {
    const err = new HTTPError(status, statusText, ADMIN_URL, new Headers(), JSON.stringify({ error: body }));
    assert.equal(toMessage(err), body);
  }
});

test('toMessage on a bodyless failure names the endpoint and the status instead of a bare HTTP line', () => {
  const message = toMessage(new HTTPError(500, 'Internal Server Error', ADMIN_URL, new Headers()));
  assert.equal(message, 'HTTP 500 Internal Server Error from http://localhost:2528/admin-api/dev/contexts - the node returned no message');
});

test('toMessage keeps an unstructured body, which is still more than the status line', () => {
  const err = new HTTPError(502, 'Bad Gateway', ADMIN_URL, new Headers(), '<html>upstream died</html>');
  assert.match(toMessage(err), /^HTTP 502 Bad Gateway from \S+ - the node said: <html>upstream died<\/html>$/);
});

test('toMessage keeps a query string out of the message, since it can carry a credential', () => {
  const err = new HTTPError(500, 'Internal Server Error', `${ADMIN_URL}?access_token=secret-token`, new Headers());
  assert.equal(toMessage(err).includes('secret-token'), false);
  assert.match(toMessage(err), /from http:\/\/localhost:2528\/admin-api\/dev\/contexts -/);
});

test('toMessage tells a transport failure apart from a node rejection', () => {
  const transport = toMessage(new HTTPError(0, 'Network Error', ADMIN_URL, new Headers(), 'fetch failed'));
  assert.equal(transport, 'Cannot reach the node at http://localhost:2528/admin-api/dev/contexts: fetch failed');

  const rejection = toMessage(new HTTPError(503, 'Service Unavailable', ADMIN_URL, new Headers()));
  assert.equal(rejection.includes('Cannot reach the node'), false);
  assert.match(rejection, /HTTP 503 Service Unavailable/);
});

test('toMessage names a bodyless transport failure as unreachable rather than as an empty network error', () => {
  assert.equal(
    toMessage(new HTTPError(0, 'Network Error', ADMIN_URL, new Headers())),
    'Cannot reach the node at http://localhost:2528/admin-api/dev/contexts: network error',
  );
});

test('toMessage surfaces a ParseError with the explanation core stranded in `data`', () => {
  const detail = 'invalid length 5, expected an array of length 32';
  const err = new RpcError(-32700, 'ParseError', detail, 'ParseError');
  assert.equal(toMessage(err), `ParseError: ${detail}`);
});

test('textResult(undefined) yields the string "null", not the literal undefined', () => {
  assert.equal(textResult(undefined).content[0].text, 'null');
});
