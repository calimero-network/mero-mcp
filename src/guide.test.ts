import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedApp } from './abi.ts';
import { guideBlocks, guideOf, listing, procedures } from './guide.ts';

const utf8Bytes = (s: string) => [...Buffer.from(s, 'utf8')];
const lines = (...l: string[]) => l.join('\n');

test('procedures are the ### titles under ## Procedures, up to the next ## heading', () => {
  const guide = lines(
    '## Overview',
    '### Not a procedure',
    '## Procedures',
    '### Create a folder',
    'Call create_context first.',
    '### Share it',
    '## Rules and limits',
    '### Nor this',
  );
  assert.deepEqual(procedures(guide), ['Create a folder', 'Share it']);
});

test('headings inside a fenced code block are text, not structure', () => {
  assert.deepEqual(procedures(lines('## Procedures', '### Real', '```md', '### Fenced', '## Overview', '```', '### Also real')), [
    'Real',
    'Also real',
  ]);
  assert.deepEqual(procedures(lines('```', '## Procedures', '### Fenced', '```')), []);
});

test('trailing whitespace and CRLF line endings do not hide a heading', () => {
  assert.deepEqual(procedures('## Procedures  \r\n### Place blocks \r\n'), ['Place blocks']);
});

test('## Procedures must be the whole heading line', () => {
  assert.deepEqual(procedures(lines('## Procedures and more', '### Nope')), []);
});

test('a guide without ## Procedures has no procedures', () => {
  assert.deepEqual(procedures(lines('## Overview', '### Something')), []);
  assert.deepEqual(procedures(''), []);
});

test('a leading UTF-8 BOM does not hide the first heading', () => {
  const guide = lines('## Procedures', '### Save a value');
  assert.deepEqual(procedures('\ufeff' + guide), procedures(guide));
});

test('a tab-indented backtick line is not a fence, so later procedures still count', () => {
  assert.deepEqual(procedures(lines('## Procedures', '### Real', '\t```', '### Still real')), [
    'Real',
    'Still real',
  ]);
});

test('guideOf reads a non-empty string guide from JSON metadata, and nothing else', () => {
  assert.equal(guideOf(utf8Bytes(JSON.stringify({ guide: '## Overview' }))), '## Overview');
  assert.equal(guideOf(utf8Bytes(JSON.stringify({ guide: '' }))), undefined);
  assert.equal(guideOf(utf8Bytes(JSON.stringify({ guide: 7 }))), undefined);
  assert.equal(guideOf(utf8Bytes(JSON.stringify({ name: 'kv-store' }))), undefined);
  assert.equal(guideOf(utf8Bytes('plain text')), undefined);
  assert.equal(guideOf([]), undefined);
});

test('listing drops any guide key from object metadata and passes other metadata through', () => {
  const guide = lines('## Procedures', '### Save a value');
  assert.deepEqual(listing(utf8Bytes(JSON.stringify({ name: 'kv', guide }))), { metadata: { name: 'kv' }, procedures: ['Save a value'] });
  assert.deepEqual(listing(utf8Bytes(JSON.stringify({ name: 'kv', guide: 7 }))), { metadata: { name: 'kv' }, procedures: [] });
  assert.deepEqual(listing(utf8Bytes('plain text')), { metadata: 'plain text', procedures: [] });
  assert.deepEqual(listing([]), { metadata: undefined, procedures: [] });
});

test('a guide of an app without a version is sent as text, since it has no readable resource uri', () => {
  const app = { id: 'raw-id', package: 'org.x', guide: '## Overview', signerId: 'S' } as ResolvedApp;
  assert.deepEqual(guideBlocks(app).map((b) => b.type), ['text', 'text']);
  assert.equal(guideBlocks({ ...app, version: '1.0.0' })[1].type, 'resource');
});
