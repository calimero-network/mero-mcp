import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbiManifest } from '@calimero-network/abi-codegen';

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));

/** A .mpk is a gzipped tar; a raw grep over it always reads zero, which is how a stale bundle gets committed. */
function readBundle(name: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(join(FIXTURES, name)));
  const entries = new Map<string, Buffer>();
  for (let off = 0; off + 512 <= tar.length; ) {
    const entry = tar.subarray(off, off + 512);
    const path = entry.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    if (!path) break; // the two zero blocks that terminate the archive
    const size = parseInt(entry.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, ''), 8);
    entries.set(path, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Bundle -> the abi.json committed beside it. Both come from one `cargo mero bundle --dev`.
const BUNDLES: Array<[string, string]> = [
  ['kv-store.mpk', 'kv-store'],
  ['scaffolding-e2e.mpk', 'scaffolding-e2e'],
];

for (const [bundle, abiName] of BUNDLES) {
  test(`${bundle} is a signed bundle the node will accept`, () => {
    const entries = readBundle(bundle);
    assert.deepEqual([...entries.keys()].sort(), ['abi.json', 'app.wasm', 'manifest.json']);

    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      wasm: { hash: string | null; size: number };
      abi: { hash: string | null; size: number };
      package: string;
    };
    // The stale .mpk `cargo mero build` leaves in res/ has both hashes null, and the node rejects
    // it with "invalid type: null, expected a string" - a trap only a fixture check catches early.
    assert.equal(typeof manifest.wasm.hash, 'string', `${bundle} has no wasm hash: rebundle it with \`cargo mero bundle --dev\``);
    assert.equal(typeof manifest.abi.hash, 'string', `${bundle} has no abi hash: rebundle it with \`cargo mero bundle --dev\``);
    assert.equal(manifest.abi.size, entries.get('abi.json')!.length);
  });

  test(`${bundle} carries the same ABI as test/fixtures/abi/${abiName}.json`, () => {
    const embedded = parseAbiManifest(JSON.parse(readBundle(bundle).get('abi.json')!.toString('utf8')) as unknown);
    const committed = parseAbiManifest(JSON.parse(readFileSync(join(FIXTURES, 'abi', `${abiName}.json`), 'utf8')) as unknown);
    assert.equal(embedded.schema_version, 'wasm-abi/1');
    assert.deepEqual(
      embedded.methods.map((m) => m.name),
      committed.methods.map((m) => m.name),
      'the bundle and the ABI fixture came from different builds',
    );
  });
}
