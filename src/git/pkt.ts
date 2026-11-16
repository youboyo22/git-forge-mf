// pkt-line framing (gitprotocol-common): four hex digits of length (header included), then payload.
// 0000 is flush, 0001 delim, 0002 response-end. Side-band frames prefix a payload with a band byte.

export const FLUSH = Buffer.from('0000', 'latin1');
export const DELIM = Buffer.from('0001', 'latin1');

/** Largest pkt-line payload (65520 total minus the 4-byte header). */
const MAX_PAYLOAD = 65516;

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}

export type Packet =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' };

export class PktError extends Error {}

/** Read pkt-lines from `buf` starting at `start`. Stops after `stopAtFlush` flush, or at the end. */
export function readPackets(buf: Buffer, start = 0, stopAtFlush = false): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new PktError(`bad pkt-line header ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) { packets.push({ kind: 'delim' }); pos += 4; continue; }
    if (len === 2) { packets.push({ kind: 'end' }); pos += 4; continue; }
    if (len < 4 || pos + len > buf.length) throw new PktError('truncated pkt-line');
    packets.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, offset: pos };
}

/** A data packet's text with one trailing LF removed. */
export function packetText(p: Packet): string | null {
  if (p.kind !== 'data') return null;
  const text = p.data.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Frame `payload` as side-band packets on `band`. */
export function sideband(band: number, payload: Buffer): Buffer {
  const chunk = MAX_PAYLOAD - 1;
  const parts: Buffer[] = [];
  const bandByte = Buffer.from([band]);
  for (let i = 0; i < payload.length; i += chunk) {
    parts.push(pkt(Buffer.concat([bandByte, payload.subarray(i, i + chunk)])));
  }
  return Buffer.concat(parts);
}
