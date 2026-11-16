// GitHub REST v3 under /api/v3: a method + path-pattern route table over the forge model. Handlers
// return (status, body, headers); errors are thrown as ForgeError and rendered as {message}.

import { FILE_MODE, ForgeError, type Forge, type Issue, type Label, type Repository } from './forge.ts';
import { decodeTree, isObjectId, type Signature } from './git/objects.ts';
import { Views } from './views.ts';
import { globalId } from './ids.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown>;
  readonly origin: string;
}

interface Ctx extends RestRequest {
  readonly params: string[];
  readonly views: Views;
}

type Handler = (ctx: Ctx) => RestReply;

const DOCS = 'https://docs.github.com/rest';
export const INSTALLED_VERSION = '3.14.0';

function reply(status: number, body?: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function fail(status: number, message: string): never {
  throw new ForgeError(status, message);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function intParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Slice a list by per_page/page and emit GitHub's Link header (next/last/first/prev). */
function paginate<T>(ctx: Ctx, items: T[], render: (item: T) => unknown): RestReply {
  const perPage = intParam(ctx.query, 'per_page', 30, 1, 100);
  const page = intParam(ctx.query, 'page', 1, 1, 1_000_000);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const link = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${ctx.origin}/api/v3${ctx.path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page < last) links.push(`${link(page + 1)}; rel="next"`, `${link(last)}; rel="last"`);
  if (page > 1) links.push(`${link(1)}; rel="first"`, `${link(Math.min(page - 1, last))}; rel="prev"`);
  return reply(200, slice.map(render), links.length ? { link: links.join(', ') } : undefined);
}

function signatureFrom(value: unknown, forge: Forge): Signature | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const name = str(v.name);
  const email = str(v.email);
  if (!name || !email) return undefined;
  const date = str(v.date) ? Date.parse(v.date as string) : NaN;
  return { name, email, seconds: Number.isFinite(date) ? Math.floor(date / 1000) : forge.seconds(), offset: '+0000' };
}

function decodeBase64(value: string): Buffer {
  const clean = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) fail(422, 'Invalid request.\n\ncontent is not valid Base64');
  return Buffer.from(clean, 'base64');
}

export class RestApi {
  private readonly forge: Forge;
  private readonly views = new Map<string, Views>();
  /** Routes bucketed by their dispatch key (see keyOf), each bucket in registration order. */
  private readonly routes = new Map<string, Array<{ method: string; pattern: RegExp; handler: Handler }>>();

  constructor(forge: Forge) {
    this.forge = forge;
    this.register();
  }

  handle(request: RestRequest): RestReply {
    let views = this.views.get(request.origin);
    if (!views) {
      views = new Views(request.origin);
      if (this.views.size > 64) this.views.clear();
      this.views.set(request.origin, views);
    }
    // GitHub answers 404 (not 405) for a known path under the wrong method, so a miss is a miss.
    for (const route of this.routes.get(keyOf(request.path)) ?? []) {
      if (route.method !== request.method && !(route.method === 'GET' && request.method === 'HEAD')) continue;
      const m = route.pattern.exec(request.path);
      if (!m) continue;
      const params = m.slice(1).map((p) => (p === undefined ? '' : safeDecode(p)));
      try {
        return route.handler({ ...request, params, views });
      } catch (err) {
        if (err instanceof ForgeError) return reply(err.status, { message: err.message, documentation_url: DOCS, status: String(err.status) });
        throw err;
      }
    }
    return reply(404, { message: 'Not Found', documentation_url: DOCS, status: '404' });
  }

  // ---------------------------------------------------------------------------------------- helpers

  private repoOf(ctx: Ctx): Repository {
    const [owner, name] = ctx.params;
    const repo = this.forge.repo(owner, name);
    if (!repo) fail(404, 'Not Found');
    return repo;
  }

  private issueOf(repo: Repository, raw: string): Issue {
    const issue = /^\d+$/.test(raw) ? repo.issue(Number(raw)) : undefined;
    if (!issue) fail(404, 'Not Found');
    return issue;
  }

  private pullOf(repo: Repository, raw: string): Issue {
    const issue = this.issueOf(repo, raw);
    if (!issue.pull) fail(404, 'Not Found');
    return issue;
  }

  private labelsFrom(repo: Repository, value: unknown): Label[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail(422, 'Invalid request.\n\nFor \'properties/labels\', it is not an array.');
    const out: Label[] = [];
    for (const entry of value) {
      const name = typeof entry === 'string' ? entry : str((entry as Record<string, unknown>)?.name);
      if (!name) fail(422, 'Validation Failed: label names must be strings');
      const label = repo.label(name);
      if (!label) fail(422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }

  private route(method: string, pattern: string, handler: Handler): void {
    // {name} matches one segment; {name+} matches the rest of the path (slashes included).
    const source = pattern
      .replace(/[.*^$()|[\]\\]/g, '\\$&') // '?' is only ever the optional-placeholder marker
      .replace(/\{[a-z_]+\+\}/g, '(.+)')
      .replace(/\{[a-z_]+\?\}/g, '(.*)')
      .replace(/\{[a-z_]+\}/g, '([^/]+)');
    const key = keyOf(pattern);
    const bucket = this.routes.get(key) ?? [];
    bucket.push({ method, pattern: new RegExp(`^${source}/?$`), handler });
    this.routes.set(key, bucket);
  }

  // ---------------------------------------------------------------------------------------- routes

  private register(): void {
    const R = '/repos/{owner}/{repo}';
    this.route('GET', '', (ctx) => reply(200, {
      current_user_url: `${ctx.views.api}/user`,
      repository_url: `${ctx.views.api}/repos/{owner}/{repo}`,
      user_url: `${ctx.views.api}/users/{user}`,
      user_repositories_url: `${ctx.views.api}/user/repos`,
      issues_url: `${ctx.views.api}/issues`,
      rate_limit_url: `${ctx.views.api}/rate_limit`,
    }));
    this.route('GET', '/meta', () => reply(200, { verifiable_password_authentication: false, installed_version: INSTALLED_VERSION }));
    this.route('GET', '/rate_limit', () => {
      const core = { limit: 5000, used: 0, remaining: 5000, reset: 0 };
      return reply(200, { resources: { core, graphql: core, search: core }, rate: core });
    });
    this.route('GET', '/user', (ctx) => reply(200, { ...ctx.views.user(this.forge.viewer), name: this.forge.viewer.name, email: this.forge.viewer.email }));
    this.route('GET', '/users/{login}', (ctx) => {
      if (ctx.params[0].toLowerCase() !== this.forge.viewer.login.toLowerCase()) fail(404, 'Not Found');
      return reply(200, { ...ctx.views.user(this.forge.viewer), name: this.forge.viewer.name });
    });
    this.route('GET', '/user/repos', (ctx) => this.listRepos(ctx));
    this.route('GET', '/users/{login}/repos', (ctx) => {
      if (ctx.params[0].toLowerCase() !== this.forge.viewer.login.toLowerCase()) fail(404, 'Not Found');
      return this.listRepos(ctx);
    });
    this.route('POST', '/user/repos', (ctx) => this.createRepo(ctx));

    this.route('GET', R, (ctx) => reply(200, ctx.views.repo(this.repoOf(ctx))));
    this.route('PATCH', R, (ctx) => this.patchRepo(ctx));
    this.route('DELETE', R, (ctx) => {
      this.forge.remove(this.repoOf(ctx));
      return reply(204);
    });

    // branches and refs
    this.route('GET', `${R}/branches`, (ctx) => {
      const repo = this.repoOf(ctx);
      return paginate(ctx, repo.branches(), (b) => this.branchView(ctx, repo, b.name, b.sha, false));
    });
    this.route('GET', `${R}/branches/{branch+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const sha = repo.branchTip(ctx.params[2]);
      if (!sha) fail(404, 'Branch not found');
      return reply(200, this.branchView(ctx, repo, ctx.params[2], sha, true));
    });
    this.route('GET', `${R}/git/refs`, (ctx) => this.listRefs(ctx, ''));
    this.route('GET', `${R}/git/refs/{ref+}`, (ctx) => this.getRef(ctx, true));
    this.route('GET', `${R}/git/matching-refs/{ref?}`, (ctx) => this.listRefs(ctx, ctx.params[2]));
    this.route('GET', `${R}/git/ref/{ref+}`, (ctx) => this.getRef(ctx, false));
    this.route('POST', `${R}/git/refs`, (ctx) => this.createRef(ctx));
    this.route('PATCH', `${R}/git/refs/{ref+}`, (ctx) => this.updateRef(ctx));
    this.route('DELETE', `${R}/git/refs/{ref+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const ref = `refs/${ctx.params[2]}`;
      if (!repo.refs.delete(ref)) fail(422, 'Reference does not exist');
      return reply(204);
    });
    this.route('GET', `${R}/git/commits/{sha}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const commit = repo.commit(ctx.params[2]);
      if (!commit) fail(404, 'Not Found');
      return reply(200, ctx.views.gitCommit(repo, ctx.params[2], commit));
    });
    this.route('GET', `${R}/git/trees/{sha+}`, (ctx) => this.getTree(ctx));
    this.route('GET', `${R}/git/blobs/{sha}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const blob = repo.get(ctx.params[2]);
      if (!blob || blob.type !== 'blob') fail(404, 'Not Found');
      return reply(200, { sha: ctx.params[2], node_id: '', size: blob.data.length, url: `${ctx.views.api}/repos/${repo.fullName}/git/blobs/${ctx.params[2]}`, content: blob.data.toString('base64'), encoding: 'base64' });
    });

    // commits
    this.route('GET', `${R}/commits`, (ctx) => this.listCommits(ctx));
    this.route('GET', `${R}/commits/{ref+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const sha = repo.resolve(ctx.params[2]);
      const commit = sha ? repo.commit(sha) : undefined;
      if (!sha || !commit) fail(422, `No commit found for SHA: ${ctx.params[2]}`);
      return reply(200, ctx.views.commit(repo, sha, commit, repo.diff(commit.parents[0], sha)));
    });

    // contents
    this.route('GET', `${R}/contents{path?}`, (ctx) => this.getContents(ctx));
    this.route('PUT', `${R}/contents/{path+}`, (ctx) => this.putContents(ctx));
    this.route('DELETE', `${R}/contents/{path+}`, (ctx) => this.deleteContents(ctx));
    this.route('GET', `${R}/readme`, (ctx) => {
      const repo = this.repoOf(ctx);
      const tip = repo.resolve(ctx.query.get('ref') ?? repo.defaultBranch);
      const path = [...repo.files(tip).keys()].find((p) => /^readme(\.|$)/i.test(p));
      if (!tip || !path) fail(404, 'Not Found');
      return this.fileReply(ctx, repo, tip, path, ctx.query.get('ref') ?? repo.defaultBranch);
    });

    // labels
    this.route('GET', `${R}/labels`, (ctx) => {
      const repo = this.repoOf(ctx);
      return paginate(ctx, [...repo.labels.values()].sort((a, b) => a.id - b.id), (l) => ctx.views.label(repo, l));
    });
    this.route('POST', `${R}/labels`, (ctx) => {
      const repo = this.repoOf(ctx);
      const name = str(ctx.body.name)?.trim();
      if (!name) fail(422, 'Validation Failed: name is required');
      if (repo.label(name)) fail(422, 'Validation Failed: label already_exists');
      const color = (str(ctx.body.color) ?? 'ededed').replace(/^#/, '').toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(color)) fail(422, 'Validation Failed: color is invalid');
      return reply(201, ctx.views.label(repo, repo.addLabel(name, color, str(ctx.body.description) ?? '')));
    });
    this.route('GET', `${R}/labels/{name+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const label = repo.label(ctx.params[2]);
      if (!label) fail(404, 'Not Found');
      return reply(200, ctx.views.label(repo, label));
    });
    this.route('PATCH', `${R}/labels/{name+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const label = repo.label(ctx.params[2]);
      if (!label) fail(404, 'Not Found');
      const newName = str(ctx.body.new_name) ?? str(ctx.body.name);
      if (newName && newName.toLowerCase() !== label.name.toLowerCase()) {
        if (repo.label(newName)) fail(422, 'Validation Failed: label already_exists');
        repo.labels.delete(label.name.toLowerCase());
        repo.labels.set(newName.toLowerCase(), label);
      }
      if (newName) label.name = newName;
      if (str(ctx.body.color)) label.color = (ctx.body.color as string).replace(/^#/, '').toLowerCase();
      if (str(ctx.body.description) !== undefined) label.description = ctx.body.description as string;
      return reply(200, ctx.views.label(repo, label));
    });
    this.route('DELETE', `${R}/labels/{name+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const label = repo.label(ctx.params[2]);
      if (!label) fail(404, 'Not Found');
      repo.labels.delete(label.name.toLowerCase());
      for (const issue of repo.issues) issue.labels = issue.labels.filter((l) => l !== label);
      return reply(204);
    });

    // issues
    this.route('GET', `${R}/issues`, (ctx) => this.listIssues(ctx));
    this.route('POST', `${R}/issues`, (ctx) => {
      const repo = this.repoOf(ctx);
      return reply(201, ctx.views.issue(repo, this.createIssue(repo, ctx.body)));
    });
    this.route('GET', `${R}/issues/comments`, (ctx) => {
      const repo = this.repoOf(ctx);
      const all = repo.issues.flatMap((issue) => issue.comments.map((comment) => ({ issue, comment })));
      all.sort((a, b) => a.comment.id - b.comment.id);
      return paginate(ctx, all, ({ issue, comment }) => ctx.views.comment(repo, issue, comment));
    });
    this.route('GET', `${R}/issues/comments/{id}`, (ctx) => {
      const { repo, issue, comment } = this.commentOf(ctx);
      return reply(200, ctx.views.comment(repo, issue, comment));
    });
    this.route('PATCH', `${R}/issues/comments/{id}`, (ctx) => {
      const { repo, issue, comment } = this.commentOf(ctx);
      const body = str(ctx.body.body);
      if (body === undefined) fail(422, 'Validation Failed: body is required');
      const updated = { ...comment, body };
      issue.comments[issue.comments.indexOf(comment)] = updated;
      return reply(200, ctx.views.comment(repo, issue, updated));
    });
    this.route('DELETE', `${R}/issues/comments/{id}`, (ctx) => {
      const { issue, comment } = this.commentOf(ctx);
      issue.comments.splice(issue.comments.indexOf(comment), 1);
      return reply(204);
    });
    this.route('GET', `${R}/issues/{number}`, (ctx) => {
      const repo = this.repoOf(ctx);
      return reply(200, ctx.views.issue(repo, this.issueOf(repo, ctx.params[2])));
    });
    this.route('PATCH', `${R}/issues/{number}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.issueOf(repo, ctx.params[2]);
      this.updateIssue(repo, issue, ctx.body);
      return reply(200, ctx.views.issue(repo, issue));
    });
    this.route('GET', `${R}/issues/{number}/comments`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.issueOf(repo, ctx.params[2]);
      return paginate(ctx, issue.comments, (c) => ctx.views.comment(repo, issue, c));
    });
    this.route('POST', `${R}/issues/{number}/comments`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.issueOf(repo, ctx.params[2]);
      const body = str(ctx.body.body);
      if (body === undefined || body === '') fail(422, 'Validation Failed: body is required');
      return reply(201, ctx.views.comment(repo, issue, repo.addComment(issue, body)));
    });
    this.route('GET', `${R}/issues/{number}/labels`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.issueOf(repo, ctx.params[2]);
      return paginate(ctx, issue.labels, (l) => ctx.views.label(repo, l));
    });
    const addLabels = (replace: boolean): Handler => (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.issueOf(repo, ctx.params[2]);
      const raw = Array.isArray(ctx.body) ? ctx.body : ctx.body.labels;
      const labels = this.labelsFrom(repo, raw ?? []);
      issue.labels = replace ? labels : [...issue.labels, ...labels.filter((l) => !issue.labels.includes(l))];
      return reply(200, issue.labels.map((l) => ctx.views.label(repo, l)));
    };
    this.route('POST', `${R}/issues/{number}/labels`, addLabels(false));
    this.route('PUT', `${R}/issues/{number}/labels`, addLabels(true));
    this.route('DELETE', `${R}/issues/{number}/labels`, (ctx) => {
      const repo = this.repoOf(ctx);
      this.issueOf(repo, ctx.params[2]).labels = [];
      return reply(204);
    });
    this.route('DELETE', `${R}/issues/{number}/labels/{name+}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.issueOf(repo, ctx.params[2]);
      const label = repo.label(ctx.params[3]);
      if (!label || !issue.labels.includes(label)) fail(404, 'Label does not exist');
      issue.labels = issue.labels.filter((l) => l !== label);
      return reply(200, issue.labels.map((l) => ctx.views.label(repo, l)));
    });

    // pulls
    this.route('GET', `${R}/pulls`, (ctx) => this.listPulls(ctx));
    this.route('POST', `${R}/pulls`, (ctx) => {
      const repo = this.repoOf(ctx);
      return reply(201, ctx.views.pull(repo, this.createPull(repo, ctx.body), true));
    });
    this.route('GET', `${R}/pulls/{number}`, (ctx) => {
      const repo = this.repoOf(ctx);
      return reply(200, ctx.views.pull(repo, this.pullOf(repo, ctx.params[2]), true));
    });
    this.route('PATCH', `${R}/pulls/{number}`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.pullOf(repo, ctx.params[2]);
      if (ctx.body.state === 'open' && issue.pull!.merged) fail(422, 'Validation Failed: a merged pull request cannot be reopened');
      this.updateIssue(repo, issue, { title: ctx.body.title, body: ctx.body.body, state: ctx.body.state });
      return reply(200, ctx.views.pull(repo, issue, true));
    });
    this.route('GET', `${R}/pulls/{number}/files`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.pullOf(repo, ctx.params[2]);
      return paginate(ctx, repo.pullFiles(issue), (f) => ctx.views.file(repo, f));
    });
    this.route('GET', `${R}/pulls/{number}/commits`, (ctx) => {
      const repo = this.repoOf(ctx);
      const pull = repo.syncPull(this.pullOf(repo, ctx.params[2]));
      const excluded = repo.ancestors(pull.baseSha);
      const commits = repo.log(pull.headSha).filter((c) => !excluded.has(c.sha)).reverse();
      return paginate(ctx, commits, (c) => ctx.views.commit(repo, c.sha, c.commit));
    });
    this.route('GET', `${R}/pulls/{number}/merge`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.pullOf(repo, ctx.params[2]);
      if (!issue.pull!.merged) fail(404, 'Not Found');
      return reply(204);
    });
    this.route('PUT', `${R}/pulls/{number}/merge`, (ctx) => {
      const repo = this.repoOf(ctx);
      const issue = this.pullOf(repo, ctx.params[2]);
      return this.mergePull(repo, issue, ctx.body);
    });
  }

  // ---------------------------------------------------------------------------------------- repos

  private listRepos(ctx: Ctx): RestReply {
    let repos = this.forge.list();
    const visibility = ctx.query.get('visibility') ?? ctx.query.get('type');
    if (visibility === 'private') repos = repos.filter((r) => r.isPrivate);
    if (visibility === 'public') repos = repos.filter((r) => !r.isPrivate);
    // Default: creation order, so a page walk stays stable while repositories are being created.
    // An explicit sort picks GitHub's orders (full_name ascending, the dates descending by default).
    const sort = ctx.query.get('sort');
    const direction = ctx.query.get('direction') ?? (sort === null || sort === 'full_name' ? 'asc' : 'desc');
    if (sort === 'full_name') repos.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id);
    else repos.sort((a, b) => a.id - b.id);
    if (direction === 'desc') repos.reverse();
    return paginate(ctx, repos, (r) => ctx.views.repo(r));
  }

  private createRepo(ctx: Ctx): RestReply {
    const name = str(ctx.body.name)?.trim();
    if (!name) fail(422, 'Validation Failed: name is required');
    const repo = this.forge.create(name, str(ctx.body.description) ?? '', ctx.body.private === true || ctx.body.visibility === 'private');
    if (ctx.body.auto_init === true) {
      const readme = repo.put('blob', Buffer.from(`# ${name}\n${repo.description ? `\n${repo.description}\n` : ''}`));
      const sha = repo.commitFiles(new Map([['README.md', { id: readme, mode: FILE_MODE }]]), [], 'Initial commit');
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, sha);
    }
    return reply(201, ctx.views.repo(repo));
  }

  private patchRepo(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const b = ctx.body;
    if (b.name !== undefined) {
      const name = str(b.name)?.trim();
      if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) fail(422, 'Validation Failed: name is invalid');
      this.forge.rename(repo, name);
    }
    if (b.description !== undefined) repo.description = b.description === null ? '' : String(b.description);
    if (typeof b.private === 'boolean') repo.isPrivate = b.private;
    if (b.visibility === 'private' || b.visibility === 'public') repo.isPrivate = b.visibility === 'private';
    if (b.default_branch !== undefined) {
      const branch = str(b.default_branch);
      if (!branch || (repo.branches().length > 0 && !repo.branchTip(branch))) fail(422, 'Validation Failed: default_branch does not exist');
      repo.defaultBranch = branch;
    }
    repo.updatedAt = this.forge.timestamp();
    return reply(200, ctx.views.repo(repo));
  }

  // ---------------------------------------------------------------------------------------- refs

  private branchView(ctx: Ctx, repo: Repository, name: string, sha: string, full: boolean): Record<string, unknown> {
    const base = {
      name,
      commit: { sha, url: `${ctx.views.api}/repos/${repo.fullName}/commits/${sha}` },
      protected: false,
    };
    if (!full) return base;
    const commit = repo.commit(sha);
    return {
      ...base,
      commit: commit ? ctx.views.commit(repo, sha, commit) : base.commit,
      _links: { self: `${ctx.views.api}/repos/${repo.fullName}/branches/${name}`, html: `${ctx.views.web}/${repo.fullName}/tree/${name}` },
      protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
      protection_url: `${ctx.views.api}/repos/${repo.fullName}/branches/${name}/protection`,
    };
  }

  private refView(ctx: Ctx, repo: Repository, ref: string, sha: string): Record<string, unknown> {
    const type = repo.get(sha)?.type ?? 'commit';
    return {
      ref,
      node_id: globalId('Ref', `${repo.id}:${ref}`),
      url: `${ctx.views.api}/repos/${repo.fullName}/git/${ref}`,
      object: { sha, type, url: `${ctx.views.api}/repos/${repo.fullName}/git/${type}s/${sha}` },
    };
  }

  private listRefs(ctx: Ctx, prefix: string): RestReply {
    const repo = this.repoOf(ctx);
    const full = prefix ? `refs/${prefix}` : 'refs/';
    const refs = [...repo.refs.entries()].filter(([name]) => name.startsWith(full)).sort(([a], [b]) => (a < b ? -1 : 1));
    return paginate(ctx, refs, ([name, sha]) => this.refView(ctx, repo, name, sha));
  }

  private getRef(ctx: Ctx, allowPrefix: boolean): RestReply {
    const repo = this.repoOf(ctx);
    const ref = `refs/${ctx.params[2]}`;
    const sha = repo.refs.get(ref);
    if (sha) return reply(200, this.refView(ctx, repo, ref, sha));
    if (allowPrefix) {
      const matches = [...repo.refs.entries()].filter(([name]) => name.startsWith(`${ref}/`)).sort(([a], [b]) => (a < b ? -1 : 1));
      if (matches.length) return reply(200, matches.map(([name, id]) => this.refView(ctx, repo, name, id)));
    }
    fail(404, 'Not Found');
  }

  private createRef(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const ref = str(ctx.body.ref);
    const sha = str(ctx.body.sha)?.toLowerCase();
    if (!ref || !/^refs\/[^\s~^:?*[\\]+$/.test(ref) || ref.split('/').length < 3 || ref.includes('..')) {
      fail(422, 'Reference name is invalid: it must start with \'refs\' and have at least two slashes.');
    }
    if (!sha || !isObjectId(sha) || !repo.get(sha)) fail(422, 'Object does not exist');
    if (repo.refs.has(ref)) fail(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return reply(201, this.refView(ctx, repo, ref, sha), { location: `${ctx.views.api}/repos/${repo.fullName}/git/${ref}` });
  }

  private updateRef(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const ref = `refs/${ctx.params[2]}`;
    const current = repo.refs.get(ref);
    if (!current) fail(422, 'Reference does not exist');
    const sha = str(ctx.body.sha)?.toLowerCase();
    if (!sha || !isObjectId(sha) || !repo.get(sha)) fail(422, 'Object does not exist');
    if (ctx.body.force !== true && ref.startsWith('refs/heads/') && !repo.isAncestor(current, sha)) fail(422, 'Update is not a fast forward');
    repo.refs.set(ref, sha);
    return reply(200, this.refView(ctx, repo, ref, sha));
  }

  private getTree(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const raw = ctx.params[2];
    let id = isObjectId(raw) ? raw : undefined;
    if (!id || repo.get(id)?.type !== 'tree') {
      const commit = repo.resolve(raw);
      id = commit ? repo.commit(commit)?.tree : id;
    }
    const tree = id ? repo.get(id) : undefined;
    if (!id || !tree || tree.type !== 'tree') fail(404, 'Not Found');
    const recursive = ctx.query.has('recursive') && ctx.query.get('recursive') !== '0' && ctx.query.get('recursive') !== 'false';
    const entries: unknown[] = [];
    const walk = (treeId: string, prefix: string): void => {
      for (const e of decodeTree(repo.get(treeId)!.data)) {
        const path = prefix + e.name;
        const object = repo.get(e.id);
        const type = e.mode === '40000' ? 'tree' : e.mode === '160000' ? 'commit' : 'blob';
        entries.push({ path, mode: e.mode.padStart(6, '0'), type, sha: e.id, ...(type === 'blob' ? { size: object?.data.length ?? 0 } : {}), url: `${ctx.views.api}/repos/${repo.fullName}/git/${type}s/${e.id}` });
        if (recursive && type === 'tree' && object) walk(e.id, `${path}/`);
      }
    };
    walk(id, '');
    return reply(200, { sha: id, url: `${ctx.views.api}/repos/${repo.fullName}/git/trees/${id}`, tree: entries, truncated: false });
  }

  // ---------------------------------------------------------------------------------------- commits

  private listCommits(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const ref = ctx.query.get('sha');
    const tip = ref ? repo.resolve(ref) : repo.headTip;
    if (!tip) {
      if (!ref && repo.branches().length === 0) fail(409, 'Git Repository is empty.');
      fail(404, `No commit found for SHA: ${ref}`);
    }
    let commits = repo.log(tip);
    const path = ctx.query.get('path');
    if (path) {
      commits = commits.filter(({ sha, commit }) => {
        const now = repo.files(sha);
        const before = repo.files(commit.parents[0]);
        const changed = (p: string): boolean => now.get(p)?.id !== before.get(p)?.id;
        return [...new Set([...now.keys(), ...before.keys()])].some((p) => (p === path || p.startsWith(`${path}/`)) && changed(p));
      });
    }
    const author = ctx.query.get('author');
    if (author) commits = commits.filter(({ commit }) => commit.author.email === author || commit.author.name === author || (author === repo.owner.login && commit.author.email === repo.owner.email));
    return paginate(ctx, commits, ({ sha, commit }) => ctx.views.commit(repo, sha, commit));
  }

  // ---------------------------------------------------------------------------------------- contents

  private contentPath(raw: string): string {
    return raw.split('/').filter((p) => p !== '' && p !== '.').join('/');
  }

  private fileReply(ctx: Ctx, repo: Repository, tip: string, path: string, ref: string): RestReply {
    const entry = repo.files(tip).get(path);
    if (!entry) fail(404, 'Not Found');
    const blob = repo.get(entry.id);
    const type = entry.mode === '160000' ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'file';
    const data = blob?.data ?? Buffer.alloc(0);
    return reply(200, ctx.views.content(repo, path, entry.id, type, data.length, ref, type === 'file' || type === 'symlink' ? data : undefined));
  }

  private getContents(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const path = this.contentPath(ctx.params[2]);
    const ref = ctx.query.get('ref') || repo.defaultBranch;
    const tip = repo.resolve(ref);
    if (!tip) fail(404, repo.branches().length === 0 ? 'This repository is empty.' : `No commit found for the ref ${ref}`);
    const files = repo.files(tip);
    if (path && files.has(path)) return this.fileReply(ctx, repo, tip, path, ref);
    const entries = repo.directory(tip, path);
    if (!entries) fail(404, 'Not Found');
    const listing = entries
      .map((e) => {
        const full = path ? `${path}/${e.name}` : e.name;
        const type = e.mode === '40000' ? 'dir' : e.mode === '160000' ? 'submodule' : e.mode === '120000' ? 'symlink' : 'file';
        const size = type === 'dir' ? 0 : repo.get(e.id)?.data.length ?? 0;
        return ctx.views.content(repo, full, e.id, type, size, ref);
      })
      .sort((a, b) => ((a.type === 'dir') === (b.type === 'dir') ? String(a.name).localeCompare(String(b.name)) : a.type === 'dir' ? -1 : 1));
    return reply(200, listing);
  }

  /** The branch a contents write lands on, and its tip (undefined for an empty repository). */
  private writeTarget(repo: Repository, body: Record<string, unknown>): { branch: string; tip: string | undefined } {
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (!tip && repo.branches().length > 0) fail(404, `Branch ${branch} not found`);
    return { branch, tip };
  }

  private commitWrite(repo: Repository, branch: string, files: Map<string, { id: string; mode: string }>, parent: string | undefined, body: Record<string, unknown>, message: string): string {
    const author = signatureFrom(body.author, this.forge) ?? signatureFrom(body.committer, this.forge);
    const committer = signatureFrom(body.committer, this.forge) ?? author;
    const sha = repo.commitFiles(files, parent ? [parent] : [], message.endsWith('\n') ? message : `${message}\n`, author, committer);
    repo.refs.set(`refs/heads/${branch}`, sha);
    if (!parent && repo.branches().length === 1) repo.defaultBranch = branch;
    repo.pushedAt = this.forge.timestamp();
    return sha;
  }

  private putContents(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const path = this.contentPath(ctx.params[2]);
    const message = str(ctx.body.message);
    const content = str(ctx.body.content);
    if (!path) fail(422, 'Validation Failed: path is required');
    if (message === undefined) fail(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
    if (content === undefined) fail(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
    const data = decodeBase64(content);
    const { branch, tip } = this.writeTarget(repo, ctx.body);
    const files = repo.files(tip);
    const existing = files.get(path);
    const given = str(ctx.body.sha)?.toLowerCase();
    if (existing) {
      if (!given) fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
      if (given !== existing.id) fail(409, `${path} does not match ${given}`);
    } else if (given) {
      fail(409, `${path} does not match ${given}`);
    }
    for (const p of files.keys()) {
      if (p.startsWith(`${path}/`) || path.startsWith(`${p}/`)) fail(422, 'Validation Failed: path conflicts with an existing file or directory');
    }
    const blob = repo.put('blob', data);
    files.set(path, { id: blob, mode: existing?.mode ?? FILE_MODE });
    const sha = this.commitWrite(repo, branch, files, tip, ctx.body, message);
    const commit = repo.commit(sha)!;
    return reply(existing ? 200 : 201, {
      content: { ...ctx.views.content(repo, path, blob, 'file', data.length, branch), encoding: 'base64' },
      commit: { ...ctx.views.gitCommit(repo, sha, commit), html_url: `${ctx.views.web}/${repo.fullName}/commit/${sha}` },
    });
  }

  private deleteContents(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const path = this.contentPath(ctx.params[2]);
    const message = str(ctx.body.message);
    if (message === undefined) fail(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
    const { branch, tip } = this.writeTarget(repo, ctx.body);
    const files = repo.files(tip);
    const existing = files.get(path);
    if (!existing) fail(404, 'Not Found');
    const given = str(ctx.body.sha)?.toLowerCase();
    if (!given) fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (given !== existing.id) fail(409, `${path} does not match ${given}`);
    files.delete(path);
    const sha = this.commitWrite(repo, branch, files, tip, ctx.body, message);
    return reply(200, { content: null, commit: { ...ctx.views.gitCommit(repo, sha, repo.commit(sha)!), html_url: `${ctx.views.web}/${repo.fullName}/commit/${sha}` } });
  }

  // ---------------------------------------------------------------------------------------- issues

  createIssue(repo: Repository, body: Record<string, unknown>): Issue {
    const title = typeof body.title === 'number' ? String(body.title) : str(body.title);
    if (!title || !title.trim()) fail(422, 'Validation Failed: title is required');
    const labels = this.labelsFrom(repo, body.labels);
    return repo.openIssue(title, str(body.body) ?? '', labels, null);
  }

  updateIssue(repo: Repository, issue: Issue, body: Record<string, unknown>): void {
    if (body.title !== undefined) {
      const title = str(body.title);
      if (!title) fail(422, 'Validation Failed: title cannot be blank');
      issue.title = title;
    }
    if (body.body !== undefined) issue.body = body.body === null ? '' : String(body.body);
    if (body.labels !== undefined) issue.labels = this.labelsFrom(repo, body.labels);
    if (body.state !== undefined) {
      if (body.state !== 'open' && body.state !== 'closed') fail(422, 'Validation Failed: state must be open or closed');
      repo.setState(issue, body.state, str(body.state_reason) ?? (body.state === 'closed' ? 'completed' : 'reopened'));
    }
    issue.updatedAt = this.forge.timestamp();
  }

  listIssueRecords(repo: Repository, query: URLSearchParams): Issue[] {
    const state = (query.get('state') ?? 'open').toLowerCase();
    let list = repo.issues.filter((i) => state === 'all' || i.state === state);
    const labels = (query.get('labels') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (labels.length) list = list.filter((i) => labels.every((name) => i.labels.some((l) => l.name.toLowerCase() === name)));
    const sort = query.get('sort') ?? 'created';
    const key = (i: Issue): number | string => (sort === 'comments' ? i.comments.length : sort === 'updated' ? i.updatedAt : i.number);
    list = [...list].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return x < y ? -1 : x > y ? 1 : a.number - b.number;
    });
    if ((query.get('direction') ?? 'desc').toLowerCase() !== 'asc') list.reverse();
    return list;
  }

  private listIssues(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    return paginate(ctx, this.listIssueRecords(repo, ctx.query), (i) => ctx.views.issue(repo, i));
  }

  private commentOf(ctx: Ctx): { repo: Repository; issue: Issue; comment: Issue['comments'][number] } {
    const repo = this.repoOf(ctx);
    const id = Number(ctx.params[2]);
    for (const issue of repo.issues) {
      const comment = issue.comments.find((c) => c.id === id);
      if (comment) return { repo, issue, comment };
    }
    fail(404, 'Not Found');
  }

  // ---------------------------------------------------------------------------------------- pulls

  createPull(repo: Repository, body: Record<string, unknown>): Issue {
    const rawHead = str(body.head);
    const base = str(body.base);
    let title = str(body.title);
    if (!rawHead) fail(422, 'Validation Failed: head is required');
    if (!base) fail(422, 'Validation Failed: base is required');
    const colon = rawHead.indexOf(':');
    if (colon >= 0 && rawHead.slice(0, colon).toLowerCase() !== repo.owner.login.toLowerCase()) fail(422, 'Validation Failed: head must be a branch of this repository');
    const head = colon >= 0 ? rawHead.slice(colon + 1) : rawHead;
    if (!title) {
      const issueNumber = Number(body.issue);
      const issue = Number.isInteger(issueNumber) ? repo.issue(issueNumber) : undefined;
      title = issue?.title;
    }
    if (!title) fail(422, 'Validation Failed: title is required');
    const headSha = repo.branchTip(head);
    const baseSha = repo.branchTip(base);
    if (headSha && baseSha && repo.isAncestor(headSha, baseSha)) fail(422, `Validation Failed: No commits between ${base} and ${head}`);
    return repo.openPull(title, str(body.body) ?? '', head, base);
  }

  private listPulls(ctx: Ctx): RestReply {
    const repo = this.repoOf(ctx);
    const state = (ctx.query.get('state') ?? 'open').toLowerCase();
    let list = repo.issues.filter((i) => i.pull && (state === 'all' || i.state === state));
    const head = ctx.query.get('head');
    if (head) list = list.filter((i) => i.pull!.head === head.slice(head.indexOf(':') + 1));
    const base = ctx.query.get('base');
    if (base) list = list.filter((i) => i.pull!.base === base);
    const sort = ctx.query.get('sort') ?? 'created';
    if (sort === 'updated') list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
    else list.sort((a, b) => a.number - b.number);
    if ((ctx.query.get('direction') ?? 'desc').toLowerCase() !== 'asc') list.reverse();
    return paginate(ctx, list, (i) => ctx.views.pull(repo, i, false));
  }

  mergePull(repo: Repository, issue: Issue, body: Record<string, unknown>): RestReply {
    const method = str(body.merge_method) ?? 'merge';
    if (!['merge', 'squash', 'rebase'].includes(method)) fail(422, 'Validation Failed: merge_method must be merge, squash or rebase');
    const pull = repo.syncPull(issue);
    const expected = str(body.sha);
    if (expected && expected.toLowerCase() !== pull.headSha) fail(409, 'Head branch was modified. Review and try the merge again.');
    const sha = repo.merge(issue, method, str(body.commit_title), str(body.commit_message));
    return reply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
}

/**
 * The dispatch key of a path or pattern: its first segment, plus the fourth under /repos (the
 * resource after /repos/{owner}/{repo}). Patterns never put a placeholder in those positions.
 */
function keyOf(path: string): string {
  const parts = path.split('/');
  if (parts[1] !== 'repos') return parts[1] ?? '';
  const sub = parts[4] ?? '';
  const brace = sub.indexOf('{');
  return `repos/${brace >= 0 ? sub.slice(0, brace) : sub}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
