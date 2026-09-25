import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What an app_handle vouches for: package, app version, guide hash, the context it targets, and that context's service. */
export interface HandlePayload {
  p: string;
  v: string;
  g: string;
  c: string | null;
  s: string | null;
}

/** First 16 hex of sha256 over the guide text, or over "" for an app that ships none. */
export const guideHash = (guide: string | undefined): string => createHash('sha256').update(guide ?? '').digest('hex').slice(0, 16);

export function handleKeeper(key: Buffer) {
  const mac = (json: Buffer) => createHmac('sha256', key).update(json).digest();
  return {
    issue(payload: HandlePayload): string {
      const json = Buffer.from(JSON.stringify(payload), 'utf8');
      return `${json.toString('base64url')}.${mac(json).toString('base64url')}`;
    },
    /** The payload of a handle this keeper minted, or undefined for anything else. */
    read(handle: unknown): HandlePayload | undefined {
      if (typeof handle !== 'string') return undefined;
      const parts = handle.split('.');
      if (parts.length !== 2) return undefined;
      const json = Buffer.from(parts[0], 'base64url');
      const given = Buffer.from(parts[1], 'base64url');
      const expected = mac(json);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      return JSON.parse(json.toString('utf8')) as HandlePayload;
    },
  };
}

export type HandleKeeper = ReturnType<typeof handleKeeper>;

// One key per process, never persisted: a restart invalidates every handle, which select_app reissues.
export const handles = handleKeeper(randomBytes(32));
