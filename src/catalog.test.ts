import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createAbiLoader } from './abi.ts';
import { createCatalog, WATCH_INTERVAL_MS } from './catalog.ts';
import { fakeNode, manifest, method, type FakeApp } from '../test/support/node.ts';

const app = (id: string, pkg: string, version = '1.0.0'): FakeApp => ({ id, package: pkg, version, abi: manifest([method('ping')]) });

test('sync notifies only when an app is installed, upgraded or uninstalled, and keeps catalog order by package', async () => {
  const node = fakeNode([app('b-id', 'org.b'), app('a-id', 'org.a')]);
  const catalog = createCatalog(createAbiLoader(node.session));
  let changes = 0;
  catalog.subscribe(() => changes++);

  await catalog.sync();
  assert.deepEqual(catalog.apps().map((a) => a.package), ['org.a', 'org.b']);
  await catalog.sync();
  assert.equal(changes, 1, 'an unchanged node must not announce a change');

  node.apps.push(app('c-id', 'org.c'));
  await catalog.sync();
  node.apps[0].version = '2.0.0';
  await catalog.sync();
  node.apps.splice(1, 1);
  await catalog.sync();
  assert.equal(changes, 4);
  assert.deepEqual(catalog.apps().map((a) => a.package), ['org.b', 'org.c']);
});

test('two installed versions of one package are both kept, in version order, and dropping one still changes the catalog', async () => {
  // Installed in reverse order, so keeping "package then service" as the sort key would leave their
  // relative order up to whatever order the node happens to return them in.
  const node = fakeNode([app('v2-id', 'org.dup', '2.0.0'), app('v1-id', 'org.dup', '1.0.0')]);
  const catalog = createCatalog(createAbiLoader(node.session));
  let changes = 0;
  catalog.subscribe(() => changes++);

  await catalog.sync();
  assert.deepEqual(catalog.apps().map((a) => [a.version, a.id]), [
    ['1.0.0', 'v1-id'],
    ['2.0.0', 'v2-id'],
  ]);
  assert.equal(changes, 1);

  node.apps.splice(0, 1); // uninstall the 2.0.0 entry, leaving only 1.0.0 installed
  await catalog.sync();
  assert.equal(changes, 2, 'uninstalling one of two versions of a package must still be seen as a change');
  assert.deepEqual(catalog.apps().map((a) => a.version), ['1.0.0']);
});

test('versions sort numerically, not lexically, so 9.0.0 comes before 10.0.0', async () => {
  const node = fakeNode([app('v10-id', 'org.dup', '10.0.0'), app('v9-id', 'org.dup', '9.0.0')]);
  const catalog = createCatalog(createAbiLoader(node.session));
  await catalog.sync();
  assert.deepEqual(catalog.apps().map((a) => a.version), ['9.0.0', '10.0.0']);
});

test('an app whose ABI cannot be read is left out and reported, and the rest still load', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const node = fakeNode([app('a-id', 'org.a'), { ...app('bad-id', 'org.bad'), abi: { schema_version: 'wasm-abi/1' } }]);
  const catalog = createCatalog(createAbiLoader(node.session));
  await catalog.sync();
  assert.deepEqual(catalog.apps().map((a) => a.package), ['org.a']);
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /^\[mero-mcp\] skipping org\.bad: /);
});

test('the refresh poll starts with the first sync that reaches the node and runs every 30 s', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const node = fakeNode([app('a-id', 'org.a')]);
  let listed = 0;
  const list = node.session.mero.admin.listApplications.bind(node.session.mero.admin);
  node.session.mero.admin.listApplications = async () => {
    listed++;
    return list();
  };
  const catalog = createCatalog(createAbiLoader(node.session));
  let changes = 0;
  catalog.subscribe(() => changes++);

  mock.timers.tick(WATCH_INTERVAL_MS * 3);
  assert.equal(listed, 0, 'nothing polls before the first sync');
  await catalog.sync();
  node.apps.push(app('b-id', 'org.b'));
  mock.timers.tick(WATCH_INTERVAL_MS);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listed, 2);
  assert.equal(changes, 2);
});
