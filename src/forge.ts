// The forge's state: one viewer account, its repositories, and per repository a git object store,
// refs, labels, and one shared numbering for issues and pull requests (a pull request is an issue
// with a `pull` part, as on GitHub). Every surface (git, REST, GraphQL, MCP) works on this model.
//
// Nothing here reads a wall clock or a random source: times derive from MAKEFUN_TRIAL_NOW plus a
// counter, ids from counters, so a replay of the same requests produces the same bytes.

import {
  DIR_MODE,
  FILE_MODE,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  hashObject,
  isObjectId,
  tagTarget,
  type Commit,
  type GitObject,
  type ObjectType,
  type Signature,
  type TreeEntry,
} from './git/objects.ts';
import { packEntry } from './git/pack.ts';
import { lineChanges } from './diff.ts';

export interface Account {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface PullPart {
  readonly head: string;
  readonly base: string;
  /** Head and base tips, kept current while open and frozen when merged or closed. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** The changed files, frozen at merge time (a merged pull keeps reporting what it merged). */
  frozenFiles: FileChange[] | null;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: Label[];
  comments: Comment[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly pull: PullPart | null;
}

export interface FileEntry {
  readonly id: string;
  readonly mode: string;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
}

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Repository {
  readonly id: number;
  readonly owner: Account;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string | null = null;

  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  private readonly byNumber = new Map<number, Issue>();
  private lastNumber = 0;

  private readonly commitCache = new Map<string, Commit>();
  private readonly packCache = new Map<string, Buffer>();
  private readonly forge: Forge;

  constructor(forge: Forge, id: number, owner: Account, name: string, description: string, isPrivate: boolean) {
    this.forge = forge;
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = forge.timestamp();
    this.updatedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.owner.login}/${this.name}`;
  }

  // ---------------------------------------------------------------------------------------- objects

  put(type: ObjectType, data: Buffer): string {
    const id = hashObject(type, data);
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
    return id;
  }

  /** Store an object whose id the caller already computed (pack ingestion). */
  putKnown(id: string, object: GitObject): void {
    if (!this.objects.has(id)) this.objects.set(id, { type: object.type, data: object.data });
  }

  get(id: string): GitObject | undefined {
    return this.objects.get(id);
  }

  commit(id: string): Commit | undefined {
    const cached = this.commitCache.get(id);
    if (cached) return cached;
    const object = this.objects.get(id);
    if (!object || object.type !== 'commit') return undefined;
    const parsed = decodeCommit(object.data);
    this.commitCache.set(id, parsed);
    return parsed;
  }

  /** The pack entry bytes for an object, deflated once and reused by every later fetch. */
  packed(id: string): Buffer {
    let entry = this.packCache.get(id);
    if (!entry) {
      entry = packEntry(this.objects.get(id)!);
      this.packCache.set(id, entry);
    }
    return entry;
  }

  /** Follow annotated tags down to the first non-tag object. */
  peel(id: string): string {
    let current = id;
    for (let i = 0; i < 64; i++) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      const target = tagTarget(object.data);
      if (!target) return current;
      current = target;
    }
    return current;
  }

  // ---------------------------------------------------------------------------------------- refs

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  get headTip(): string | undefined {
    return this.branchTip(this.defaultBranch);
  }

  branches(): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of this.refs) if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice(11), sha });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** A branch name, a full ref, HEAD, a tag or a commit id → commit id. */
  resolve(ref: string): string | undefined {
    if (ref === 'HEAD') return this.headTip;
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const name of candidates) {
      const sha = this.refs.get(name);
      if (sha) return this.peel(sha);
    }
    const lower = ref.toLowerCase();
    if (isObjectId(lower) && this.objects.has(lower)) return this.peel(lower);
    if (/^[0-9a-f]{7,39}$/.test(lower)) {
      for (const id of this.objects.keys()) if (id.startsWith(lower) && this.objects.get(id)!.type === 'commit') return id;
    }
    return undefined;
  }

  /** Whether `ancestor` is reachable from `descendant` (inclusive); walks parents breadth-first. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>([descendant]);
    const queue = [descendant];
    for (let i = 0; i < queue.length; i++) {
      const commit = this.commit(queue[i]);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
      }
    }
    return false;
  }

  ancestors(tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      const commit = this.commit(id);
      if (!commit) continue;
      seen.add(id);
      for (const parent of commit.parents) stack.push(parent);
    }
    return seen;
  }

  /** The nearest common ancestor of two commits (breadth-first from `b`), or null. */
  mergeBase(a: string, b: string): string | null {
    const fromA = this.ancestors(a);
    const seen = new Set<string>([b]);
    const queue = [b];
    for (let i = 0; i < queue.length; i++) {
      if (fromA.has(queue[i])) return queue[i];
      const commit = this.commit(queue[i]);
      if (!commit) continue;
      for (const parent of commit.parents) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first by committer time (ties: discovery order). */
  log(tip: string, limit = Infinity): Array<{ sha: string; commit: Commit }> {
    const out: Array<{ sha: string; commit: Commit; order: number }> = [];
    const seen = new Set<string>([tip]);
    const queue = [tip];
    for (let i = 0; i < queue.length && out.length < limit * 4 + 64; i++) {
      const commit = this.commit(queue[i]);
      if (!commit) continue;
      out.push({ sha: queue[i], commit, order: i });
      for (const parent of commit.parents) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
    out.sort((x, y) => y.commit.committer.seconds - x.commit.committer.seconds || x.order - y.order);
    return out.slice(0, limit === Infinity ? out.length : limit).map(({ sha, commit }) => ({ sha, commit }));
  }

  // ---------------------------------------------------------------------------------------- trees

  /** Every file path under a commit's tree. */
  files(commitId: string | undefined): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    if (!commitId) return out;
    const commit = this.commit(commitId);
    if (commit) this.walk(commit.tree, '', out);
    return out;
  }

  private walk(treeId: string, prefix: string, out: Map<string, FileEntry>): void {
    const tree = this.objects.get(treeId);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of decodeTree(tree.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === DIR_MODE) this.walk(entry.id, path, out);
      else out.set(path, { id: entry.id, mode: entry.mode });
    }
  }

  /** The entries of the tree at `path` in a commit (root for ''), or null when it is not a directory. */
  directory(commitId: string, path: string): TreeEntry[] | null {
    const commit = this.commit(commitId);
    if (!commit) return null;
    let treeId = commit.tree;
    for (const part of path.split('/').filter(Boolean)) {
      const tree = this.objects.get(treeId);
      if (!tree || tree.type !== 'tree') return null;
      const entry = decodeTree(tree.data).find((e) => e.name === part);
      if (!entry || entry.mode !== DIR_MODE) return null;
      treeId = entry.id;
    }
    const tree = this.objects.get(treeId);
    return tree && tree.type === 'tree' ? decodeTree(tree.data) : null;
  }

  /** Write nested trees for a flat path map; returns the root tree id. */
  writeTree(files: Map<string, FileEntry>): string {
    interface Dir { files: Map<string, FileEntry>; dirs: Map<string, Dir> }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.dirs.get(part);
        if (!next) { next = { files: new Map(), dirs: new Map() }; dir.dirs.set(part, next); }
        dir = next;
      }
      dir.files.set(parts[parts.length - 1], entry);
    }
    const write = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, id: entry.id });
      for (const [name, sub] of dir.dirs) entries.push({ mode: DIR_MODE, name, id: write(sub) });
      return this.put('tree', encodeTree(entries));
    };
    return write(root);
  }

  /** Commit a file map on top of `parents`; returns the new commit id (refs are the caller's). */
  commitFiles(files: Map<string, FileEntry>, parents: string[], message: string, author?: Signature, committer?: Signature): string {
    const tree = this.writeTree(files);
    const who = author ?? this.forge.signature();
    const data = encodeCommit({ tree, parents, author: who, committer: committer ?? who, message });
    return this.put('commit', data);
  }

  // ---------------------------------------------------------------------------------------- diffs

  /** Files changed from `from` to `to` (commit ids), sorted by path. */
  diff(from: string | undefined, to: string | undefined): FileChange[] {
    const before = this.files(from);
    const after = this.files(to);
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const out: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const a = before.get(path);
      const b = after.get(path);
      if (a && b && a.id === b.id) continue;
      const oldText = a ? this.objects.get(a.id)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const newText = b ? this.objects.get(b.id)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
      const { additions, deletions } = lineChanges(oldText, newText);
      out.push({
        filename: path,
        status: !a ? 'added' : !b ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        sha: (b ?? a)!.id,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------- issues

  issue(number: number): Issue | undefined {
    return this.byNumber.get(number);
  }

  openIssue(title: string, body: string, labels: Label[], pull: PullPart | null): Issue {
    const now = this.forge.timestamp();
    this.lastNumber += 1;
    const issue: Issue = {
      id: this.forge.nextId('issue'),
      number: this.lastNumber,
      title,
      body,
      state: 'open',
      stateReason: null,
      labels,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      pull,
    };
    this.issues.push(issue);
    this.byNumber.set(issue.number, issue);
    return issue;
  }

  setState(issue: Issue, state: 'open' | 'closed', reason?: string | null): void {
    if (issue.state === state) return;
    const now = this.forge.timestamp();
    issue.state = state;
    issue.updatedAt = now;
    issue.closedAt = state === 'closed' ? now : null;
    issue.stateReason = state === 'closed' ? reason ?? 'completed' : reason === undefined ? 'reopened' : reason;
  }

  addComment(issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.forge.nextId('comment'), body, createdAt: this.forge.timestamp() };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  label(name: string): Label | undefined {
    return this.labels.get(name.toLowerCase());
  }

  addLabel(name: string, color: string, description: string): Label {
    const label: Label = { id: this.forge.nextId('label'), name, color, description };
    this.labels.set(name.toLowerCase(), label);
    return label;
  }

  // ---------------------------------------------------------------------------------------- pulls

  openPull(title: string, body: string, head: string, base: string): Issue {
    const headSha = this.branchTip(head);
    const baseSha = this.branchTip(base);
    if (!headSha) throw new ForgeError(422, `Validation Failed: head branch ${head} does not exist`);
    if (!baseSha) throw new ForgeError(422, `Validation Failed: base branch ${base} does not exist`);
    if (head === base) throw new ForgeError(422, 'Validation Failed: head and base must be different branches');
    for (const other of this.issues) {
      if (other.pull && other.state === 'open' && other.pull.head === head && other.pull.base === base) {
        throw new ForgeError(422, `Validation Failed: A pull request already exists for ${this.owner.login}:${head}.`);
      }
    }
    const part: PullPart = { head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, frozenFiles: null };
    return this.openIssue(title, body, [], part);
  }

  /** Refresh an open pull's tips from its branches (a push may have moved them). */
  syncPull(issue: Issue): PullPart {
    const pull = issue.pull!;
    if (issue.state === 'open') {
      pull.headSha = this.branchTip(pull.head) ?? pull.headSha;
      pull.baseSha = this.branchTip(pull.base) ?? pull.baseSha;
    }
    return pull;
  }

  pullFiles(issue: Issue): FileChange[] {
    const pull = this.syncPull(issue);
    if (pull.frozenFiles) return pull.frozenFiles;
    const base = this.mergeBase(pull.baseSha, pull.headSha) ?? undefined;
    return this.diff(base, pull.headSha);
  }

  /** Whether the pull's changes apply to the current base without overlapping edits. */
  mergeable(issue: Issue): boolean {
    const pull = this.syncPull(issue);
    if (pull.merged || issue.state !== 'open') return false;
    return this.squash(pull) !== null;
  }

  /** The three-way squash result as a file map, or null when both sides changed a path differently. */
  private squash(pull: PullPart): Map<string, FileEntry> | null {
    const base = this.mergeBase(pull.baseSha, pull.headSha) ?? undefined;
    const ancestor = this.files(base);
    const ours = this.files(pull.baseSha);
    const theirs = this.files(pull.headSha);
    const result = new Map(ours);
    const paths = new Set<string>([...ancestor.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const o = ancestor.get(path)?.id;
      const t = theirs.get(path)?.id;
      if (o === t) continue; // head did not touch it
      const b = ours.get(path)?.id;
      if (b !== o && b !== t) return null; // both sides changed it, differently
      const entry = theirs.get(path);
      if (entry) result.set(path, entry);
      else result.delete(path);
    }
    return result;
  }

  merge(issue: Issue, method: string, title?: string, message?: string): string {
    const pull = this.syncPull(issue);
    if (pull.merged) throw new ForgeError(405, 'Pull Request is not mergeable: it was already merged');
    if (issue.state !== 'open') throw new ForgeError(405, 'Pull Request is not mergeable: it is closed');
    const files = this.squash(pull);
    if (!files) throw new ForgeError(405, 'Pull Request is not mergeable: merge conflict');
    const frozen = this.pullFiles(issue);
    const subject = title ?? (method === 'merge' ? `Merge pull request #${issue.number} from ${this.owner.login}/${pull.head}` : `${issue.title} (#${issue.number})`);
    const text = message === undefined || message === '' ? (method === 'merge' ? issue.title : '') : message;
    const full = text ? `${subject}\n\n${text}\n` : `${subject}\n`;
    let sha: string;
    if (method === 'rebase' || (method !== 'merge' && pull.headSha === pull.baseSha)) {
      sha = this.commitFiles(files, [pull.baseSha], full);
    } else if (method === 'merge') {
      sha = this.commitFiles(files, [pull.baseSha, pull.headSha], full);
    } else {
      sha = this.commitFiles(files, [pull.baseSha], full);
    }
    this.refs.set(`refs/heads/${pull.base}`, sha);
    const now = this.forge.timestamp();
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = sha;
    pull.frozenFiles = frozen;
    this.setState(issue, 'closed', 'completed');
    this.pushedAt = now;
    return sha;
  }
}

/** Counter-based ids and trial-clock timestamps, shared by every repository. */
export class Forge {
  readonly viewer: Account;
  private readonly repos = new Map<string, Repository>();
  private readonly counters = new Map<string, number>();
  private readonly epoch: number;
  private ticks = 0;

  constructor(viewer: Account, nowIso: string) {
    this.viewer = viewer;
    const parsed = Date.parse(nowIso);
    this.epoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_767_225_600;
  }

  nextId(kind: string): number {
    // Repository ids start at 5000 (as GitHub's look nothing like issue numbers); the rest at 1.
    const next = (this.counters.get(kind) ?? (kind === 'repo' ? 4999 : 0)) + 1;
    this.counters.set(kind, next);
    return next;
  }

  /** Seconds on the trial clock: MAKEFUN_TRIAL_NOW plus one second per event. */
  seconds(): number {
    this.ticks += 1;
    return this.epoch + this.ticks;
  }

  timestamp(): string {
    return new Date(this.seconds() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  signature(): Signature {
    return { name: this.viewer.name, email: this.viewer.email, seconds: this.seconds(), offset: '+0000' };
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  repo(owner: string, name: string): Repository | undefined {
    return this.repos.get(this.key(owner, name));
  }

  repoById(id: number): Repository | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  list(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  create(name: string, description: string, isPrivate: boolean): Repository {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
      throw new ForgeError(422, 'Repository creation failed: name is invalid');
    }
    if (this.repo(this.viewer.login, name)) throw new ForgeError(422, 'Repository creation failed: name already exists on this account');
    const repo = new Repository(this, this.nextId('repo'), this.viewer, name, description, isPrivate);
    this.repos.set(this.key(this.viewer.login, name), repo);
    return repo;
  }

  rename(repo: Repository, name: string): void {
    if (name === repo.name) return;
    if (this.repo(repo.owner.login, name)) throw new ForgeError(422, 'Repository rename failed: name already exists on this account');
    this.repos.delete(this.key(repo.owner.login, repo.name));
    repo.name = name;
    this.repos.set(this.key(repo.owner.login, name), repo);
  }

  remove(repo: Repository): void {
    this.repos.delete(this.key(repo.owner.login, repo.name));
  }

  /** Find the repository and issue an issue/pull database id belongs to. */
  findIssue(id: number): { repo: Repository; issue: Issue } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues) if (issue.id === id) return { repo, issue };
    }
    return undefined;
  }

  /** Find a comment by database id. */
  findComment(id: number): { repo: Repository; issue: Issue; comment: Comment } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues) for (const comment of issue.comments) if (comment.id === id) return { repo, issue, comment };
    }
    return undefined;
  }
}

export { FILE_MODE };
