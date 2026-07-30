import { RpcError } from '@calimero-network/mero-js';

/**
 * A guest (WASM app) error has no top-level `message` - only `type:
 * "FunctionCallError"` plus `data`, which core emits in one of two shapes:
 * a Rust Debug-formatted string like "the method call returned an error:
 * [108, 97, 98, 101, 108, ...]" (the error text's UTF-8 bytes as a decimal
 * array, not JSON), or a plain string such as a guest panic message. Recover
 * the real message so callers see it instead of the opaque "FunctionCallError"
 * type.
 */
export function decodeFunctionCallErrorData(data: unknown): string | undefined {
  if (typeof data !== 'string') return undefined;
  const match = data.match(/\[[\d,\s]+\]/);
  // No embedded byte array: treat non-blank data as the message itself (e.g. a guest panic).
  if (!match) {
    const trimmed = data.trim();
    return trimmed || undefined;
  }
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
const isRpcErrorLike = (err: unknown): err is Error & RpcErrorLike => err instanceof RpcError;

// mero-js ships HTTPError behind an extensionless barrel NodeNext will not resolve,
// so these are the fields we read and the check is structural.
interface HttpErrorLike {
  status: number;
  url?: string;
  bodyText?: string;
}

export const isHttpError = (err: unknown): err is Error & HttpErrorLike =>
  err instanceof Error && typeof (err as Partial<HttpErrorLike>).status === 'number';

/** Core answers every handled failure with `{"error": "..."}`; a route it never registered has no body. */
export function nodeMessage(bodyText?: string): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown } | null;
    return typeof parsed?.error === 'string' && parsed.error ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** A query string can carry a credential, and the path is what names the call. */
const endpoint = (url?: string) => url?.split('?')[0];

/** Enough of an unstructured body to diagnose from, short of pasting a whole HTML error page. */
const BODY_LIMIT = 300;

/**
 * HTTPError.message is only `HTTP <status> <statusText>`, so the node's own explanation has to
 * come out of the body; with no body, name the endpoint so the status at least says what failed.
 */
function httpMessage(err: Error & HttpErrorLike): string {
  const message = nodeMessage(err.bodyText);
  if (message) return message;
  const where = endpoint(err.url);
  const body = err.bodyText?.trim();
  // status 0 is this process failing to reach the node, which is nothing the node rejected.
  if (err.status === 0) return `Cannot reach the node${where ? ` at ${where}` : ''}: ${body || 'network error'}`;
  return `${err.message}${where ? ` from ${where}` : ''} - ${body ? `the node said: ${body.slice(0, BODY_LIMIT)}` : 'the node returned no message'}`;
}

/** mero-js surfaces neither guest errors nor node error bodies: both arrive as a type name or a bare status line. */
export function toMessage(err: unknown): string {
  if (isRpcErrorLike(err)) {
    const decoded = decodeFunctionCallErrorData(err.data);
    if (decoded && err.type === 'FunctionCallError') return decoded;
    // Core tags every other server error the same way, and mero-js falls back to the tag when
    // there is no `message`, so a ParseError reads as that bare word with the reason in `data`.
    if (decoded && err.message === err.type) return `${err.type}: ${decoded}`;
  }
  if (isHttpError(err)) return httpMessage(err);
  return err instanceof Error ? err.message : String(err);
}

export function textResult(data: unknown) {
  const text = typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? 'null');
  return { content: [{ type: 'text' as const, text }] };
}

export function errorResult(err: unknown) {
  return { content: [{ type: 'text' as const, text: `Error: ${toMessage(err)}` }], isError: true };
}
