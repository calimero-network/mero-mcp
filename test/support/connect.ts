import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export const ERAS = {
  '2025-11-25': {},
  '2026-07-28': { versionNegotiation: { mode: { pin: '2026-07-28' } } },
} as const;

export type Era = keyof typeof ERAS;

/** Serves `factory` through the same dual-era stdio entry the bin uses, and connects a client of `era`. */
export async function connect(factory: () => McpServer | Promise<McpServer>, era: Era = '2025-11-25') {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(factory, { transport: serverSide });
  const client = new Client({ name: 'mero-mcp-test', version: '0.0.0' }, ERAS[era]);
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await served.close();
    },
  };
}
