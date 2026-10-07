// Preloaded into the server under test: appends the path of every node request to REQUEST_LOG.
import { appendFileSync } from 'node:fs';

const log = process.env.REQUEST_LOG;
const send = globalThis.fetch;
globalThis.fetch = (input, ...rest) => {
  appendFileSync(log, `${new URL(String(input?.url ?? input)).pathname}\n`);
  return send(input, ...rest);
};
