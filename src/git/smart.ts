// Git smart HTTP (gitprotocol-http): GET info/refs advertisements, POST git-upload-pack (protocol v2
// ls-refs/fetch, and the v0 stateless fetch for clients that do not ask for v2) and POST
// git-receive-pack (v0 command list + pack, report-status in side-band-64k when asked).

import { ZERO_ID, decodeTree, GITLINK_MODE, isObjectId } from './objects.ts';
import { assemblePack, readPack } from './pack.ts';
import { DELIM, FLUSH, packetText, pkt, readPackets, sideband, type Packet } from './pkt.ts';
import type { Forge, Repository } from '../forge.ts';

const AGENT = 'agent=forge/1.0';

export interface GitReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

export interface GitRoute {
  readonly owner: string;
  readonly repo: string;
  readonly action: 'info/refs' | 'git-upload-pack' | 'git-receive-pack' | 'other';
}

/** Split /{owner}/{repo}.git/{action} (the .git suffix is optional on the repo segment). */
export function matchGitPath(pathname: string): GitRoute | null {
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.*)$/.exec(pathname);
  if (!m) return null;
  const action = m[3] === 'info/refs' || m[3] === 'git-upload-pack' || m[3] === 'git-receive-pack' ? m[3] : 'other';
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), action };
}

function text(status: number, message: string): GitReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`) };
}

export function handleGit(forge: Forge, route: GitRoute, method: string, service: string | null, protocol: string, body: Buffer): GitReply {
  const repo = forge.repo(route.owner, route.repo);
  if (!repo) return text(404, 'Repository not found');
  const wantsV2 = /(^|[:\s,])version=2(\s|$|[:,])/.test(protocol);

  if (route.action === 'info/refs') {
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method Not Allowed');
    if (service === 'git-upload-pack') {
      return advert('git-upload-pack', wantsV2 ? uploadPackV2Caps() : refAdvertisement(repo, uploadPackV0Caps(repo), true));
    }
    if (service === 'git-receive-pack') return advert('git-receive-pack', refAdvertisement(repo, RECEIVE_CAPS, false));
    return text(403, 'dumb HTTP is not supported; use a smart-HTTP git client');
  }
  if (route.action === 'git-upload-pack') {
    if (method !== 'POST') return text(405, 'Method Not Allowed');
    const reply = (payload: Buffer): GitReply => ({ status: 200, contentType: 'application/x-git-upload-pack-result', body: payload });
    try {
      return reply(wantsV2 || looksLikeV2(body) ? uploadPackV2(repo, body) : uploadPackV0(repo, body));
    } catch (err) {
      return reply(Buffer.concat([pkt(`ERR ${(err as Error).message}\n`), FLUSH]));
    }
  }
  if (route.action === 'git-receive-pack') {
    if (method !== 'POST') return text(405, 'Method Not Allowed');
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(forge, repo, body) };
  }
  return text(404, 'Not Found');
}

function advert(service: string, payload: Buffer): GitReply {
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat([pkt(`# service=${service}\n`), FLUSH, payload]),
  };
}

function looksLikeV2(body: Buffer): boolean {
  return body.length > 12 && body.toString('latin1', 4, 12) === 'command=';
}

// ------------------------------------------------------------------------------------------------ adverts

const RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet object-format=sha1 ${AGENT}`;

function uploadPackV0Caps(repo: Repository): string {
  const symref = repo.headTip ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
  return `side-band-64k side-band ofs-delta shallow deepen-relative no-progress include-tag thin-pack allow-tip-sha1-in-want allow-reachable-sha1-in-want${symref} object-format=sha1 ${AGENT}`;
}

function uploadPackV2Caps(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function sortedRefs(repo: Repository): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The v0 ref list: HEAD (upload-pack only) and every ref, capabilities on the first line. */
function refAdvertisement(repo: Repository, caps: string, withHead: boolean): Buffer {
  const lines: string[] = [];
  const head = repo.headTip;
  if (withHead && head) lines.push(`${head} HEAD`);
  for (const [name, id] of sortedRefs(repo)) {
    lines.push(`${id} ${name}`);
    if (withHead) {
      const peeled = repo.peel(id);
      if (peeled !== id) lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO_ID} capabilities^{}`);
  const out = lines.map((line, i) => pkt(i === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  return Buffer.concat([...out, FLUSH]);
}

// ------------------------------------------------------------------------------------------------ v2

interface V2Request {
  readonly command: string;
  readonly args: string[];
}

function parseV2(body: Buffer): V2Request {
  const { packets } = readPackets(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind === 'flush') break;
    const line = packetText(p);
    if (line === null) continue;
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }
  if (!command) throw new Error('protocol v2 request names no command');
  return { command, args };
}

function uploadPackV2(repo: Repository, body: Buffer): Buffer {
  const request = parseV2(body);
  if (request.command === 'ls-refs') return lsRefs(repo, request.args);
  if (request.command === 'fetch') return fetchV2(repo, request.args);
  throw new Error(`unknown command ${request.command}`);
}

function lsRefs(repo: Repository, args: string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const target = `refs/heads/${repo.defaultBranch}`;
  if (keep('HEAD')) {
    const head = repo.headTip;
    const symref = symrefs ? ` symref-target:${target}` : '';
    if (head) out.push(pkt(`${head} HEAD${symref}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${symref}\n`));
  }
  for (const [name, id] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${id} ${name}`;
    if (peel) {
      const peeled = repo.peel(id);
      if (peeled !== id) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  return Buffer.concat([...out, FLUSH]);
}

interface Negotiation {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  deepenRelative: boolean;
  includeTag: boolean;
  wantRefs: string[];
  done: boolean;
}

function parseFetchArgs(args: string[]): Negotiation {
  const n: Negotiation = { wants: [], haves: [], shallows: [], depth: null, deepenRelative: false, includeTag: false, wantRefs: [], done: false };
  for (const arg of args) {
    const [word, value = ''] = splitOnce(arg);
    if (word === 'want') n.wants.push(value.split(' ')[0]);
    else if (word === 'have') n.haves.push(value);
    else if (word === 'shallow') n.shallows.push(value);
    else if (word === 'deepen') n.depth = Math.max(1, parseInt(value, 10) || 1);
    else if (word === 'deepen-relative') n.deepenRelative = true;
    else if (word === 'include-tag') n.includeTag = true;
    else if (word === 'want-ref') n.wantRefs.push(value);
    else if (word === 'done') n.done = true;
  }
  return n;
}

function splitOnce(line: string): [string, string?] {
  const space = line.indexOf(' ');
  return space < 0 ? [line] : [line.slice(0, space), line.slice(space + 1)];
}

function fetchV2(repo: Repository, args: string[]): Buffer {
  const n = parseFetchArgs(args);
  const sections: Buffer[][] = [];

  const wantedRefs: string[] = [];
  for (const ref of n.wantRefs) {
    const id = repo.refs.get(ref);
    if (!id) throw new Error(`unknown ref ${ref}`);
    n.wants.push(id);
    wantedRefs.push(`${id} ${ref}`);
  }
  for (const want of n.wants) if (!isObjectId(want) || !repo.get(want)) throw new Error(`not our ref ${want}`);

  const common = n.haves.filter((id) => repo.get(id) !== undefined);
  if (!n.done) {
    const acks = common.map((id) => pkt(`ACK ${id}\n`));
    sections.push([pkt('acknowledgments\n'), ...(acks.length ? acks : [pkt('NAK\n')]), pkt('ready\n')]);
  }

  const plan = planPack(repo, { ...n, haves: common });
  if (plan.shallow.length || plan.unshallow.length) {
    sections.push([
      pkt('shallow-info\n'),
      ...plan.shallow.map((id) => pkt(`shallow ${id}\n`)),
      ...plan.unshallow.map((id) => pkt(`unshallow ${id}\n`)),
    ]);
  }
  if (wantedRefs.length) sections.push([pkt('wanted-refs\n'), ...wantedRefs.map((line) => pkt(`${line}\n`))]);
  sections.push([pkt('packfile\n'), sideband(1, assemblePack(plan.objects.map((id) => repo.packed(id))))]);

  const parts: Buffer[] = [];
  sections.forEach((section, i) => {
    if (i > 0) parts.push(DELIM);
    parts.push(...section);
  });
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------ v0 fetch

function uploadPackV0(repo: Repository, body: Buffer): Buffer {
  const { packets } = readPackets(body);
  const args: string[] = [];
  let caps = '';
  for (const p of packets as Packet[]) {
    const line = packetText(p);
    if (line === null) continue;
    let value = line;
    if (args.length === 0 && line.startsWith('want ')) {
      const parts = line.split(' ');
      value = `want ${parts[1]}`;
      caps = parts.slice(2).join(' ');
    }
    args.push(value);
  }
  const n = parseFetchArgs(args);
  if (n.wants.length === 0) return Buffer.alloc(0);
  for (const want of n.wants) if (!isObjectId(want) || !repo.get(want)) throw new Error(`not our ref ${want}`);
  const capSet = new Set(caps.split(' ').filter(Boolean));
  n.includeTag = capSet.has('include-tag');
  const common = n.haves.filter((id) => repo.get(id) !== undefined);
  const plan = planPack(repo, { ...n, haves: common });
  const parts: Buffer[] = [];
  if (n.depth !== null || n.shallows.length) {
    for (const id of plan.shallow) parts.push(pkt(`shallow ${id}\n`));
    for (const id of plan.unshallow) parts.push(pkt(`unshallow ${id}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt(common.length ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  const pack = assemblePack(plan.objects.map((id) => repo.packed(id)));
  if (capSet.has('side-band-64k') || capSet.has('side-band')) parts.push(sideband(1, pack), FLUSH);
  else parts.push(pack);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------ pack planning

interface PackPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

/** Choose the objects to send: everything reachable from the wants, less what the haves imply. */
function planPack(repo: Repository, n: Negotiation): PackPlan {
  const clientShallow = new Set(n.shallows);

  // What the client already holds: its haves' commits and, through their trees, every object
  // they reach (stopping at the client's own shallow boundary).
  const heldCommits = new Set<string>();
  const stack = [...n.haves];
  while (stack.length) {
    const id = stack.pop()!;
    if (heldCommits.has(id)) continue;
    const commit = repo.commit(id);
    if (!commit) continue;
    heldCommits.add(id);
    if (!clientShallow.has(id)) stack.push(...commit.parents);
  }

  const send: string[] = [];
  const queued = new Set<string>();
  const add = (id: string): void => {
    if (!queued.has(id)) { queued.add(id); send.push(id); }
  };

  // Peel wanted tags to their commits; tag objects themselves are sent.
  const roots: string[] = [];
  for (const want of n.wants) {
    let id = want;
    for (let guard = 0; guard < 64; guard++) {
      const object = repo.get(id);
      if (!object || object.type !== 'tag') break;
      add(id);
      const target = tagTargetOf(repo, id);
      if (!target) break;
      id = target;
    }
    const object = repo.get(id);
    if (object?.type === 'commit') roots.push(id);
    else if (object) addTreeOrBlob(repo, id, add, new Set());
  }

  const commits: string[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (n.depth !== null) {
    // Breadth-first to `depth` generations; commits at the edge with parents become shallow.
    const depthOf = new Map<string, number>();
    const queue: string[] = [];
    for (const root of roots) if (!depthOf.has(root)) { depthOf.set(root, 1); queue.push(root); }
    if (n.deepenRelative) {
      for (const s of clientShallow) if (repo.commit(s) && !depthOf.has(s)) { depthOf.set(s, 1); queue.push(s); }
    }
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const d = depthOf.get(id)!;
      const commit = repo.commit(id)!;
      commits.push(id);
      if (d >= n.depth) {
        if (commit.parents.length) shallow.push(id);
        continue;
      }
      for (const parent of commit.parents) {
        if (!depthOf.has(parent) && repo.commit(parent)) { depthOf.set(parent, d + 1); queue.push(parent); }
      }
    }
    const shallowSet = new Set(shallow);
    for (const s of clientShallow) if (depthOf.has(s) && !shallowSet.has(s)) unshallow.push(s);
    // A client-shallow commit that stays shallow needs no re-announcement.
    for (let i = shallow.length - 1; i >= 0; i--) if (clientShallow.has(shallow[i])) shallow.splice(i, 1);
  } else {
    const seen = new Set<string>();
    const walk = [...roots];
    while (walk.length) {
      const id = walk.pop()!;
      if (seen.has(id) || heldCommits.has(id)) continue;
      seen.add(id);
      const commit = repo.commit(id);
      if (!commit) continue;
      commits.push(id);
      if (!clientShallow.has(id)) walk.push(...commit.parents);
    }
  }

  // Objects reachable from what the client holds are not sent.
  const held = new Set<string>();
  for (const id of heldCommits) {
    held.add(id);
    collectTree(repo, repo.commit(id)!.tree, held);
  }

  for (const id of commits) if (!heldCommits.has(id)) add(id);
  const visited = new Set<string>(held);
  for (const id of commits) {
    if (heldCommits.has(id)) continue;
    const tree = repo.commit(id)!.tree;
    if (visited.has(tree)) continue;
    addTreeOrBlob(repo, tree, add, visited);
  }

  if (n.includeTag) {
    for (const [name, id] of repo.refs) {
      if (!name.startsWith('refs/tags/') || queued.has(id) || held.has(id)) continue;
      const object = repo.get(id);
      if (object?.type === 'tag' && queued.has(repo.peel(id))) add(id);
    }
  }
  return { objects: send, shallow, unshallow };
}

function tagTargetOf(repo: Repository, id: string): string | null {
  const data = repo.get(id)!.data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(data);
  return m ? m[1] : null;
}

function collectTree(repo: Repository, treeId: string, into: Set<string>): void {
  const stack = [treeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (into.has(id)) continue;
    const object = repo.get(id);
    if (!object) continue;
    into.add(id);
    if (object.type === 'tree') {
      for (const entry of decodeTree(object.data)) if (entry.mode !== GITLINK_MODE && !into.has(entry.id)) stack.push(entry.id);
    }
  }
}

function addTreeOrBlob(repo: Repository, rootId: string, add: (id: string) => void, visited: Set<string>): void {
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const object = repo.get(id);
    if (!object) continue;
    add(id);
    if (object.type === 'tree') {
      const entries = decodeTree(object.data);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.mode !== GITLINK_MODE && !visited.has(entry.id)) stack.push(entry.id);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ receive-pack

interface RefCommand {
  readonly oldId: string;
  readonly newId: string;
  readonly ref: string;
}

function receivePack(forge: Forge, repo: Repository, body: Buffer): Buffer {
  const commands: RefCommand[] = [];
  const caps = new Set<string>();
  let offset = 0;
  let parseError: string | null = null;
  try {
    const read = readPackets(body, 0, true);
    offset = read.offset;
    for (const p of read.packets) {
      if (p.kind !== 'data') continue;
      let line = p.data.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap) caps.add(cap);
        line = line.slice(0, nul);
      }
      if (line.startsWith('shallow ')) continue;
      const [oldId, newId, ref] = line.split(' ');
      if (isObjectId(oldId) && isObjectId(newId) && ref) commands.push({ oldId, newId, ref });
      else parseError = 'malformed command';
    }
  } catch (err) {
    parseError = (err as Error).message;
  }

  let unpack = 'ok';
  if (parseError) unpack = parseError;
  else {
    const rest = body.subarray(offset);
    if (rest.length > 0) {
      try {
        for (const object of readPack(rest, (id) => repo.get(id))) repo.putKnown(object.id, object);
      } catch (err) {
        unpack = `index-pack failed: ${(err as Error).message}`;
      }
    }
  }

  const hadHeads = repo.branches().length > 0;
  const results: string[] = [];
  for (const cmd of commands) {
    const reason = unpack === 'ok' ? applyCommand(repo, cmd) : 'unpacker error';
    results.push(reason === null ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${reason}`);
  }
  if (commands.some((c, i) => results[i].startsWith('ok ') && c.newId !== ZERO_ID)) {
    repo.pushedAt = forge.timestamp();
    if (!hadHeads && !repo.headTip) {
      const firstHead = commands.find((c, i) => results[i].startsWith('ok ') && c.ref.startsWith('refs/heads/') && c.newId !== ZERO_ID);
      if (firstHead) repo.defaultBranch = firstHead.ref.slice(11);
    }
  }

  const report = Buffer.concat([pkt(`unpack ${unpack}\n`), ...results.map((line) => pkt(`${line}\n`)), FLUSH]);
  if (caps.has('side-band-64k') || caps.has('side-band')) return Buffer.concat([sideband(1, report), FLUSH]);
  if (caps.has('report-status') || caps.has('report-status-v2')) return report;
  return Buffer.alloc(0);
}

/** Apply one ref update; null on success, else the ng reason. */
function applyCommand(repo: Repository, cmd: RefCommand): string | null {
  if (!/^refs\/[^\0\s~^:?*[\\]+$/.test(cmd.ref) || cmd.ref.includes('..') || cmd.ref.endsWith('/') || cmd.ref.endsWith('.lock')) {
    return 'funny refname';
  }
  const current = repo.refs.get(cmd.ref);
  if (cmd.newId === ZERO_ID) {
    if (current !== undefined && cmd.oldId !== ZERO_ID && cmd.oldId !== current) return 'stale info';
    repo.refs.delete(cmd.ref);
    return null;
  }
  const object = repo.get(cmd.newId);
  if (!object) return 'missing necessary objects';
  if (current === undefined) {
    if (cmd.oldId !== ZERO_ID) return 'stale info';
    if (cmd.ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
    repo.refs.set(cmd.ref, cmd.newId);
    return null;
  }
  if (cmd.oldId !== current) return cmd.oldId === ZERO_ID ? 'already exists' : 'stale info';
  if (cmd.ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return 'not a commit';
    if (!repo.isAncestor(current, cmd.newId)) return 'non-fast-forward';
  } else if (cmd.ref.startsWith('refs/tags/')) {
    return 'already exists';
  }
  repo.refs.set(cmd.ref, cmd.newId);
  return null;
}
