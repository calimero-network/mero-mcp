import { RpcError } from '@calimero-network/mero-js';

/**
 * A guest (WASM app) error has no top-level `message` - only `type:
 * "FunctionCallError"` plus `data`, a Rust Debug-formatted string like
 * "the method call returned an error: [108, 97, 98, 101, 108, ...]" (the
 * error text's UTF-8 bytes as a decimal array, not JSON). Recover the real
 * message so callers see it instead of the opaque "FunctionCallError" type.
 */
export function decodeFunctionCallErrorData(data: unknown): string | undefined {
  if (typeof data !== 'string') return undefined;
  const match = data.match(/\[[\d,\s]+\]/);
  if (!match) return undefined;
  try {
    const bytes: unknown = JSON.parse(match[0]);
    if (!Array.isArray(bytes) || bytes.length === 0 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      return undefined;
    }
    const text = Buffer.from(bytes as number[]).toString('utf8').trim();
    if (!text) return undefined;
    // The guest serializes its error as a JSON string, so the decoded bytes
    // are themselves JSON-quoted (e.g. `"label must be..."`); unwrap it.
    try {
      const inner: unknown = JSON.parse(text);
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    } catch {
      /* not JSON-wrapped - use the raw decoded text below */
    }
    return text;
  } catch {
    return undefined;
  }
}

interface RpcErrorLike {
  type?: string;
  data?: unknown;
}

// RpcError resolves to `any` under NodeNext, so instanceof is the real check; read fields through this structural type instead of casting.
const isRpcErrorLike = (err: unknown): err is RpcErrorLike => err instanceof RpcError;

/** mero-js does not decode guest errors: a FunctionCallError carries the real message as bytes in `data`. */
export function toMessage(err: unknown): string {
  if (isRpcErrorLike(err) && err.type === 'FunctionCallError') {
    const decoded = decodeFunctionCallErrorData(err.data);
    if (decoded) return decoded;
  }
  return err instanceof Error ? err.message : String(err);
}

export function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? 'null');
  return { content: [{ type: 'text' as const, text }] };
}

export function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: `Error: ${toMessage(err)}` }], isError: true };
}
