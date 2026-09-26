import { AsyncLocalStorage } from 'node:async_hooks';
import { TRACEPARENT_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server';

const current = new AsyncLocalStorage<string>();

/** The W3C traceparent of the MCP request being handled, if the client sent one. */
export const currentTraceparent = (): string | undefined => current.getStore();

/** Every tool registered after this runs with its request's traceparent in scope, for node requests to forward. */
export function traceTools(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...args: unknown[]) => unknown) => unknown;
  server.registerTool = ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    register(name, config, (...args: unknown[]) => {
      const traceparent = (args.at(-1) as ServerContext).mcpReq._meta?.[TRACEPARENT_META_KEY];
      return typeof traceparent === 'string' ? current.run(traceparent, () => cb(...args)) : cb(...args);
    })) as McpServer['registerTool'];
}

/** fetch for the node client: adds the current traceparent header to every request made inside a traced tool call. */
export const tracedFetch: typeof fetch = (input, init) => {
  const traceparent = current.getStore();
  if (!traceparent) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('traceparent', traceparent);
  return fetch(input, { ...init, headers });
};
