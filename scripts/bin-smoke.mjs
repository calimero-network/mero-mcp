#!/usr/bin/env node
// Installs the packed tarball and launches the server the way npm does - by bin
// name on PATH, never a file path. Resolving the path is what hides a broken
// entrypoint guard, which is how a package that cannot start shipped green.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = 'mero-mcp';
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bin-smoke', version: '1' },
  },
});

const work = mkdtempSync(join(tmpdir(), 'mero-mcp-bin-smoke-'));
let failure;

try {
  execFileSync('npm', ['pack', '--pack-destination', work], { cwd: ROOT, stdio: 'inherit' });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  const app = join(work, 'app');
  writeFileSync(join(work, 'package.json'), '{"name":"smoke","private":true}');
  execFileSync('npm', ['init', '-y'], { cwd: work, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(work, tarball)], {
    cwd: work,
    stdio: 'inherit',
  });

  const binDir = join(work, 'node_modules', '.bin');
  const out = await new Promise((resolve, reject) => {
    // Bin name only. Passing a path here would resolve the symlink and pass on a
    // package no client can actually start.
    const child = spawn(BIN, [], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no response within 20s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);

    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.includes('"serverInfo"')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve(stdout);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!stdout.includes('"serverInfo"')) {
        reject(
          new Error(
            `${BIN} exited (code ${code}) without answering initialize.\n` +
              `stdout: ${JSON.stringify(stdout)}\nstderr: ${JSON.stringify(stderr)}`,
          ),
        );
      }
    });

    child.stdin.write(`${INIT}\n`);
  });

  const line = out.split('\n').find((l) => l.includes('"serverInfo"'));
  const name = JSON.parse(line).result?.serverInfo?.name;
  if (name !== 'mero-mcp') throw new Error(`unexpected serverInfo.name: ${name}`);
  console.log(`ok - ${BIN} on PATH answered initialize as ${name}`);
} catch (err) {
  failure = err;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failure) {
  console.error(`FAIL - ${failure.message}`);
  process.exit(1);
}
