// Packfile v2 encode and decode (gitformat-pack). Writing emits whole objects only; reading resolves
// OFS_DELTA and REF_DELTA entries, with REF_DELTA bases looked up in the pack or the caller's store
// (thin packs).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type ObjectType } from './objects.ts';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

/** Pack entry header: type in bits 4-6 of the first byte, size as a little-endian base-128 varint. */
function entryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_CODES[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** The deflated body plus entry header for one object; callers may cache it per object id. */
export function packEntry(object: GitObject): Buffer {
  return Buffer.concat([entryHeader(object.type, object.data.length), deflateSync(object.data, { level: 1 })]);
}

/** Assemble a pack from already-encoded entries (see packEntry). */
export function assemblePack(entries: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  return assemblePack(objects.map(packEntry));
}

// ------------------------------------------------------------------------------------------------ read

export class PackError extends Error {}

/** Inflate one zlib stream at `offset`; returns the bytes and how much input the stream used. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; used: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, used: result.engine.bytesWritten };
}

function readVarint(buf: Buffer, pos: number): { value: number; pos: number } {
  let value = 0;
  let scale = 1;
  let byte: number;
  do {
    if (pos >= buf.length) throw new PackError('truncated delta header');
    byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return { value, pos };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) throw new PackError('delta base size mismatch');
  const target = readVarint(delta, source.pos);
  const out = Buffer.alloc(target.value);
  let pos = target.pos;
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset += delta[pos++] * 0x1000000;
      if (op & 0x10) size |= delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > out.length) throw new PackError('delta copy out of range');
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op > 0) {
      if (pos + op > delta.length || written + op > out.length) throw new PackError('delta insert out of range');
      delta.copy(out, written, pos, pos + op);
      pos += op;
      written += op;
    } else {
      throw new PackError('delta opcode 0 is reserved');
    }
  }
  if (written !== out.length) throw new PackError('delta result size mismatch');
  return out;
}

export interface UnpackedObject extends GitObject {
  readonly id: string;
}

interface RawEntry {
  readonly offset: number;
  readonly code: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseId?: string;
}

/** Parse and verify a pack, resolving every delta. `lookup` supplies bases the pack does not hold. */
export function readPack(pack: Buffer, lookup: (id: string) => GitObject | undefined): UnpackedObject[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new PackError('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const end = pack.length - 20;
  const checksum = createHash('sha1').update(pack.subarray(0, end)).digest();
  if (!checksum.equals(pack.subarray(end))) throw new PackError('pack checksum mismatch');

  const count = pack.readUInt32BE(8);
  const raws: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    if (pos >= end) throw new PackError('pack truncated');
    const offset = pos;
    let byte = pack[pos++];
    const code = (byte >> 4) & 0x07;
    while (byte & 0x80) byte = pack[pos++]; // the size is re-derived from the inflated data
    let baseOffset: number | undefined;
    let baseId: string | undefined;
    if (code === OFS_DELTA) {
      byte = pack[pos++];
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = offset - distance;
    } else if (code === REF_DELTA) {
      baseId = pack.toString('hex', pos, pos + 20);
      pos += 20;
    } else if (!CODE_TYPES[code]) {
      throw new PackError(`unknown pack object type ${code}`);
    }
    const { data, used } = inflateAt(pack.subarray(0, end), pos);
    pos += used;
    raws.push({ offset, code, data, baseOffset, baseId });
  }

  const byOffset = new Map<number, RawEntry>();
  for (const raw of raws) byOffset.set(raw.offset, raw);
  const resolvedByOffset = new Map<number, UnpackedObject>();
  const resolvedById = new Map<string, UnpackedObject>();
  const pendingRef: RawEntry[] = [];

  const finish = (raw: RawEntry, type: ObjectType, data: Buffer): UnpackedObject => {
    const object = { type, data, id: hashObject(type, data) };
    resolvedByOffset.set(raw.offset, object);
    resolvedById.set(object.id, object);
    return object;
  };

  // Resolve iteratively (a delta chain may be long): each entry walks its OFS chain down to a resolved
  // base; REF_DELTA entries whose base is not yet known are retried after the others.
  const resolve = (raw: RawEntry): UnpackedObject | null => {
    const chain: RawEntry[] = [];
    let cursor: RawEntry | undefined = raw;
    let base: GitObject | undefined;
    while (cursor) {
      const done = resolvedByOffset.get(cursor.offset);
      if (done) { base = done; break; }
      const type = CODE_TYPES[cursor.code];
      if (type) { base = finish(cursor, type, cursor.data); break; }
      chain.push(cursor);
      if (cursor.code === OFS_DELTA) {
        const next = byOffset.get(cursor.baseOffset!);
        if (!next) throw new PackError('ofs-delta base not in pack');
        cursor = next;
      } else {
        base = resolvedById.get(cursor.baseId!) ?? lookup(cursor.baseId!);
        if (!base) return null;
        break;
      }
    }
    if (!base) return null;
    let current: GitObject = base;
    for (let i = chain.length - 1; i >= 0; i--) current = finish(chain[i], current.type, applyDelta(current.data, chain[i].data));
    return resolvedByOffset.get(raw.offset) ?? null;
  };

  for (const raw of raws) if (!resolve(raw)) pendingRef.push(raw);
  let remaining = pendingRef;
  while (remaining.length > 0) {
    const next = remaining.filter((raw) => !resolve(raw));
    if (next.length === remaining.length) throw new PackError('ref-delta base missing');
    remaining = next;
  }
  return raws.map((raw) => resolvedByOffset.get(raw.offset)!);
}
