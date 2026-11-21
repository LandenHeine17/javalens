// Share links: the program, its input, the open tab and the current step, packed into the URL's
// #hash (deflated, then base64url) so one link reopens exactly what's on screen. The hash never
// reaches the server.

export interface Shared {
  code: string;
  stdin?: string;
  tab?: string;
  step?: number;
}

const PREFIX = '#s=';

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The "#s=..." hash for this state. */
export async function encodeShare(state: Shared): Promise<string> {
  const json = JSON.stringify(state);
  const packed = await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return PREFIX + toBase64Url(packed);
}

/** The state in a "#s=..." hash, or null when the hash isn't a share link (or is damaged). */
export async function decodeShare(hash: string): Promise<Shared | null> {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const bytes = await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream('deflate-raw'));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof data?.code !== 'string') return null;
    return {
      code: data.code,
      stdin: typeof data.stdin === 'string' ? data.stdin : undefined,
      tab: typeof data.tab === 'string' ? data.tab : undefined,
      step: Number.isInteger(data.step) && data.step >= 0 ? data.step : undefined,
    };
  } catch {
    return null;
  }
}
