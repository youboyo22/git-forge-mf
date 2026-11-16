// Git's object model: SHA-1 ids over "<type> <size>\0<body>", and the byte formats of trees,
// commits and annotated tags. Everything here is pure and works on Buffers.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_ID = '0000000000000000000000000000000000000000';
export const DIR_MODE = '40000';
export const FILE_MODE = '100644';
export const GITLINK_MODE = '160000';

const OBJECT_ID = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

export function hashObject(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

// ------------------------------------------------------------------------------------------------ trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly id: string;
}

/** Git orders tree entries by name bytes, with a directory compared as if it ended in "/". */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === DIR_MODE ? `${entry.name}/` : entry.name, 'utf8');
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const keyed = entries.map((entry) => ({ entry, key: treeSortKey(entry) }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Buffer[] = [];
  for (const { entry } of keyed) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.id, 'hex'));
  }
  return Buffer.concat(parts);
}

export function decodeTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('latin1', pos, space),
      name: data.toString('utf8', space + 1, nul),
      id: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

// ------------------------------------------------------------------------------------------------ commits

export interface Signature {
  readonly name: string;
  readonly email: string;
  readonly seconds: number;
  readonly offset: string;
}

export interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
}

const SIGNATURE = /^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/;

export function parseSignature(text: string): Signature {
  const m = SIGNATURE.exec(text);
  if (!m) return { name: text, email: '', seconds: 0, offset: '+0000' };
  return { name: m[1], email: m[2], seconds: Number(m[3]), offset: m[4] };
}

export function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.seconds} ${sig.offset}`;
}

/** Split an object's header block ("key value" lines) from its message at the first blank line. */
function splitHeaders(data: Buffer): { headers: Array<[string, string]>; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const headers: Array<[string, string]> = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length > 0) {
      // continuation line (e.g. a gpgsig block)
      const last = headers[headers.length - 1];
      last[1] += `\n${line.slice(1)}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space > 0) headers.push([line.slice(0, space), line.slice(space + 1)]);
  }
  return { headers, message };
}

export function decodeCommit(data: Buffer): Commit {
  const { headers, message } = splitHeaders(data);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const [key, value] of headers) {
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author: parseSignature(author), committer: parseSignature(committer || author), message };
}

export function encodeCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatSignature(commit.author)}`, `committer ${formatSignature(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** The object an annotated tag points at, or null. */
export function tagTarget(data: Buffer): string | null {
  for (const [key, value] of splitHeaders(data).headers) if (key === 'object') return value;
  return null;
}
