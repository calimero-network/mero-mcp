import type { AppIdentity } from './abi.ts';

const FENCE = /^ *```/;
const PROCEDURES_HEADING = '## Procedures';
export const GUIDE_URI_TEMPLATE = 'calimero://apps/{package}/{version}/guide';

/**
 * An app's metadata rides the wire as raw bytes; for display, recover the JSON object it usually
 * encodes, fall back to the plain string, or drop it - never dump the byte array itself.
 */
export function displayMetadata(bytes: number[]): unknown {
  if (bytes.length === 0) return undefined;
  const buf = Buffer.from(bytes);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return undefined; // not valid UTF-8: nothing readable to show
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string field of an app's metadata object; empty or non-string counts as absent. */
export function metadataField(bytes: number[], key: string): string | undefined {
  const metadata = displayMetadata(bytes);
  const value = isRecord(metadata) ? metadata[key] : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

export const guideOf = (bytes: number[]): string | undefined => metadataField(bytes, 'guide');

/** The `###` titles under `## Procedures`, by the registry's heading and fence rules. */
export function procedures(guide: string): string[] {
  const titles: string[] = [];
  let fenced = false;
  let inProcedures = false;
  for (const raw of guide.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (FENCE.test(line)) {
      fenced = !fenced;
    } else if (!fenced && line.startsWith('## ')) {
      inProcedures = line === PROCEDURES_HEADING;
    } else if (!fenced && inProcedures && line.startsWith('### ')) {
      titles.push(line.slice(4).trim());
    }
  }
  return titles;
}

/** A listing leaves the guide out, since it runs to 16 KiB, and names its procedures instead. */
export function listing(bytes: number[]): { metadata: unknown; procedures: string[] } {
  const metadata = displayMetadata(bytes);
  if (!isRecord(metadata)) return { metadata, procedures: [] };
  const { guide, ...rest } = metadata;
  return { metadata: rest, procedures: typeof guide === 'string' ? procedures(guide) : [] };
}

/** The guide resource uri, which only an app with a package and a version has. */
export const guideUri = ({ package: pkg, version }: Pick<AppIdentity, 'package' | 'version'>) =>
  pkg && version ? `calimero://apps/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/guide` : undefined;

/** The guide as an embedded resource, labelled so the agent reads it as the author's text, never as this server's. */
export function guideBlocks(app: AppIdentity) {
  if (!app.guide) return [];
  const pkg = app.package ?? app.id;
  const uri = guideUri(app);
  const label = { type: 'text' as const, text: `App guide, provided by the app's author (package ${pkg}, signer ${app.signerId}):` };
  if (!uri) return [label, { type: 'text' as const, text: app.guide }];
  const _meta = { package: pkg, appVersion: app.version, signerId: app.signerId ?? null };
  return [label, { type: 'resource' as const, resource: { uri, mimeType: 'text/markdown', text: app.guide, _meta } }];
}
