// Model Context Protocol over streamable HTTP at POST /mcp: JSON-RPC 2.0 with plain JSON responses.
// Speaks the 2026-07-28 revision (server/discover, no session) and the earlier initialize handshake.
// Tools are thin wrappers over the REST layer, so their effects and shapes are the REST ones.

import { ForgeError, type Forge } from './forge.ts';
import type { RestApi, RestReply } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', title: 'Forge MCP server', version: '1.0.0' };
const INSTRUCTIONS = 'Tools for the repositories, issues and pull requests of this GitHub-compatible forge.';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface McpReply {
  status: number;
  body?: unknown;
}

interface Property {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

interface Tool {
  name: string;
  title: string;
  description: string;
  required: string[];
  properties: Record<string, Property>;
  readOnly: boolean;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => unknown;
}

interface ToolCtx {
  forge: Forge;
  rest: RestApi;
  origin: string;
}

class ToolFailure extends Error {}

const owner: Property = { type: 'string', description: 'The account that owns the repository (its login).' };
const repo: Property = { type: 'string', description: 'The repository name, without the owner.' };
const pageProps: Record<string, Property> = {
  page: { type: 'number', description: 'Page number, from 1.' },
  perPage: { type: 'number', description: 'Results per page (1-100).' },
};

/** Call one REST route; a non-2xx reply becomes a tool failure carrying GitHub's message. */
function call(ctx: ToolCtx, method: string, path: string, body: Record<string, unknown> = {}, query: Record<string, unknown> = {}): any {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const reply: RestReply = ctx.rest.handle({ method, path, query: q, body, origin: ctx.origin });
  if (reply.status >= 400) {
    const message = (reply.body as { message?: string } | undefined)?.message ?? `HTTP ${reply.status}`;
    throw new ToolFailure(`${method} ${path} failed (${reply.status}): ${message}`);
  }
  return reply.body ?? { status: reply.status };
}

const seg = (v: unknown): string => encodeURIComponent(String(v));
const repoPath = (a: Record<string, unknown>): string => `/repos/${seg(a.owner)}/${seg(a.repo)}`;

const TOOLS: Tool[] = [
  {
    name: 'get_me',
    title: 'Get my user',
    description: 'Get the authenticated user (the token owner): login, id and profile.',
    required: [],
    properties: {},
    readOnly: true,
    run: (_a, ctx) => call(ctx, 'GET', '/user'),
  },
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The new repository name.' },
      description: { type: 'string', description: 'A short description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      autoInit: { type: 'boolean', description: 'Create an initial commit with a README.' },
    },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'POST', '/user/repos', { name: a.name, description: a.description, private: a.private === true, auto_init: a.autoInit === true }),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: { owner, repo },
    readOnly: true,
    run: (a, ctx) => call(ctx, 'GET', repoPath(a)),
  },
  {
    name: 'list_repos',
    title: 'List my repositories',
    description: 'List the repositories the authenticated user owns.',
    required: [],
    properties: { ...pageProps },
    readOnly: true,
    run: (a, ctx) => ({ repositories: call(ctx, 'GET', '/user/repos', {}, { page: a.page, per_page: a.perPage ?? 100 }) }),
  },
  {
    name: 'list_branches',
    title: 'List branches',
    description: 'List the branches of a repository.',
    required: ['owner', 'repo'],
    properties: { owner, repo, ...pageProps },
    readOnly: true,
    run: (a, ctx) => ({ branches: call(ctx, 'GET', `${repoPath(a)}/branches`, {}, { page: a.page, per_page: a.perPage ?? 100 }) }),
  },
  {
    name: 'create_branch',
    title: 'Create branch',
    description: 'Create a branch from another branch (the default branch when from_branch is omitted).',
    required: ['owner', 'repo', 'branch'],
    properties: { owner, repo, branch: { type: 'string', description: 'The new branch name.' }, from_branch: { type: 'string', description: 'The branch to start from.' } },
    readOnly: false,
    run: (a, ctx) => {
      const r = call(ctx, 'GET', repoPath(a));
      const from = (a.from_branch as string) || r.default_branch;
      const tip = call(ctx, 'GET', `${repoPath(a)}/branches/${seg(from)}`).commit.sha;
      return call(ctx, 'POST', `${repoPath(a)}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: tip });
    },
  },
  {
    name: 'list_commits',
    title: 'List commits',
    description: 'List the commits of a branch, tag or sha (the default branch when sha is omitted).',
    required: ['owner', 'repo'],
    properties: { owner, repo, sha: { type: 'string', description: 'Branch, tag or commit sha to list from.' }, ...pageProps },
    readOnly: true,
    run: (a, ctx) => ({ commits: call(ctx, 'GET', `${repoPath(a)}/commits`, {}, { sha: a.sha, page: a.page, per_page: a.perPage ?? 30 }) }),
  },
  {
    name: 'get_file_contents',
    title: 'Get file or directory contents',
    description: 'Get the contents of a file (base64) or the listing of a directory.',
    required: ['owner', 'repo', 'path'],
    properties: { owner, repo, path: { type: 'string', description: 'The path in the repository.' }, ref: { type: 'string', description: 'Branch, tag or sha.' } },
    readOnly: true,
    run: (a, ctx) => {
      const out = call(ctx, 'GET', `${repoPath(a)}/contents/${String(a.path).split('/').map(seg).join('/')}`, {}, { ref: a.ref });
      return Array.isArray(out) ? { entries: out } : out;
    },
  },
  {
    name: 'create_or_update_file',
    title: 'Create or update file',
    description: 'Create or update one file with a commit on a branch. Pass sha (the current blob sha) to update an existing file.',
    required: ['owner', 'repo', 'path', 'content', 'message'],
    properties: {
      owner,
      repo,
      path: { type: 'string', description: 'The path of the file.' },
      content: { type: 'string', description: 'The new file content, as plain text.' },
      message: { type: 'string', description: 'The commit message.' },
      branch: { type: 'string', description: 'The branch (default: the default branch).' },
      sha: { type: 'string', description: 'The blob sha of the file being replaced.' },
    },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'PUT', `${repoPath(a)}/contents/${String(a.path).split('/').map(seg).join('/')}`, {
      message: a.message,
      content: Buffer.from(String(a.content), 'utf8').toString('base64'),
      branch: a.branch,
      sha: a.sha,
    }),
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open a new issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner,
      repo,
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body (Markdown).' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Names of existing labels to apply.' },
    },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'POST', `${repoPath(a)}/issues`, { title: a.title, body: a.body, labels: a.labels }),
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Get one issue by number.',
    required: ['owner', 'repo', 'issue_number'],
    properties: { owner, repo, issue_number: { type: 'number', description: 'The issue number.' } },
    readOnly: true,
    run: (a, ctx) => call(ctx, 'GET', `${repoPath(a)}/issues/${seg(a.issue_number)}`),
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, filtered by state (open, closed or all; default all).',
    required: ['owner', 'repo'],
    properties: {
      owner,
      repo,
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying all of these labels.' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction by creation.' },
      ...pageProps,
    },
    readOnly: true,
    run: (a, ctx) => {
      const issues = call(ctx, 'GET', `${repoPath(a)}/issues`, {}, {
        state: typeof a.state === 'string' ? a.state.toLowerCase() : 'all',
        labels: Array.isArray(a.labels) ? a.labels.join(',') : undefined,
        direction: a.direction,
        page: a.page,
        per_page: a.perPage ?? 100,
      });
      return { issues, count: issues.length };
    },
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description: 'Edit an issue: title, body, state (open or closed) or labels.',
    required: ['owner', 'repo', 'issue_number'],
    properties: {
      owner,
      repo,
      issue_number: { type: 'number', description: 'The issue number.' },
      title: { type: 'string', description: 'A new title.' },
      body: { type: 'string', description: 'A new body.' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'A new state.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Replace the labels.' },
    },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'PATCH', `${repoPath(a)}/issues/${seg(a.issue_number)}`, { title: a.title, body: a.body, state: a.state, labels: a.labels }),
  },
  {
    name: 'add_issue_comment',
    title: 'Comment on an issue',
    description: 'Add a comment to an issue or pull request.',
    required: ['owner', 'repo', 'issue_number', 'body'],
    properties: { owner, repo, issue_number: { type: 'number', description: 'The issue or pull request number.' }, body: { type: 'string', description: 'The comment text.' } },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'POST', `${repoPath(a)}/issues/${seg(a.issue_number)}/comments`, { body: a.body }),
  },
  {
    name: 'create_pull_request',
    title: 'Open pull request',
    description: 'Open a pull request that merges a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner,
      repo,
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The branch with the changes.' },
      base: { type: 'string', description: 'The branch to merge into.' },
      body: { type: 'string', description: 'The pull request description.' },
    },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'POST', `${repoPath(a)}/pulls`, { title: a.title, head: a.head, base: a.base, body: a.body }),
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request',
    description: 'Get one pull request by number.',
    required: ['owner', 'repo', 'pullNumber'],
    properties: { owner, repo, pullNumber: { type: 'number', description: 'The pull request number.' } },
    readOnly: true,
    run: (a, ctx) => call(ctx, 'GET', `${repoPath(a)}/pulls/${seg(a.pullNumber)}`),
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List the pull requests of a repository, filtered by state (open, closed or all; default open).',
    required: ['owner', 'repo'],
    properties: { owner, repo, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list.' }, ...pageProps },
    readOnly: true,
    run: (a, ctx) => {
      const pulls = call(ctx, 'GET', `${repoPath(a)}/pulls`, {}, { state: a.state, page: a.page, per_page: a.perPage ?? 100 });
      return { pull_requests: pulls, count: pulls.length };
    },
  },
  {
    name: 'get_pull_request_files',
    title: 'List pull request files',
    description: 'List the files a pull request changes, with their addition and deletion counts.',
    required: ['owner', 'repo', 'pullNumber'],
    properties: { owner, repo, pullNumber: { type: 'number', description: 'The pull request number.' } },
    readOnly: true,
    run: (a, ctx) => ({ files: call(ctx, 'GET', `${repoPath(a)}/pulls/${seg(a.pullNumber)}/files`, {}, { per_page: 100 }) }),
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request (merge, squash or rebase; default squash).',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner,
      repo,
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge.' },
      commit_title: { type: 'string', description: 'Title of the merge commit.' },
      commit_message: { type: 'string', description: 'Extra detail for the merge commit.' },
    },
    readOnly: false,
    run: (a, ctx) => call(ctx, 'PUT', `${repoPath(a)}/pulls/${seg(a.pull_number)}/merge`, {
      merge_method: a.merge_method ?? 'squash',
      commit_title: a.commit_title,
      commit_message: a.commit_message,
    }),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools/list payload, built once so every listing is byte-for-byte the same. */
const TOOL_LIST = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: { type: 'object', properties: t.properties, required: t.required, additionalProperties: false },
  annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
}));

/** Argument spellings other clients use, mapped onto each tool's own property names. */
const ALIASES: Record<string, string[]> = {
  owner: ['owner_login', 'org', 'organization', 'user', 'login', 'namespace', 'owner_name'],
  repo: ['repository', 'repo_name', 'repository_name', 'name'],
  name: ['repo', 'repository', 'repo_name', 'repository_name'],
  issue_number: ['number', 'issueNumber', 'issue', 'index'],
  pull_number: ['pullNumber', 'number', 'pr_number', 'pull_request_number', 'index'],
  pullNumber: ['pull_number', 'number', 'pr_number', 'pull_request_number', 'index'],
  head: ['head_branch', 'head_ref', 'source_branch', 'from_branch'],
  base: ['base_branch', 'base_ref', 'target_branch', 'into'],
  body: ['description', 'text', 'comment'],
};

function normalizeArgs(tool: Tool, raw: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...raw };
  for (const prop of Object.keys(tool.properties)) {
    if (args[prop] !== undefined) continue;
    for (const alias of ALIASES[prop] ?? []) {
      if (raw[alias] !== undefined && !(alias in tool.properties)) { args[prop] = raw[alias]; break; }
    }
  }
  if (typeof args.full_name === 'string' && args.owner === undefined && args.repo === undefined) {
    const [o, r] = String(args.full_name).split('/');
    args.owner = o;
    args.repo = r;
  }
  return args;
}

function missingArgs(tool: Tool, args: Record<string, unknown>): string[] {
  return tool.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function badTypes(tool: Tool, args: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const [name, prop] of Object.entries(tool.properties)) {
    const v = args[name];
    if (v === undefined || v === null) continue;
    if (prop.type === 'number') {
      if (typeof v === 'string' && /^\d+$/.test(v)) args[name] = Number(v);
      else if (typeof v !== 'number') bad.push(`${name} must be a number`);
    } else if (prop.type === 'string' && typeof v !== 'string') {
      if (typeof v === 'number') args[name] = String(v);
      else bad.push(`${name} must be a string`);
    } else if (prop.type === 'boolean' && typeof v !== 'boolean') {
      bad.push(`${name} must be a boolean`);
    } else if (prop.type === 'array' && !Array.isArray(v)) {
      bad.push(`${name} must be an array`);
    } else if (prop.enum && typeof v === 'string' && !prop.enum.includes(v.toLowerCase())) {
      bad.push(`${name} must be one of ${prop.enum.join(', ')}`);
    }
  }
  return bad;
}

export class McpServer {
  private readonly forge: Forge;
  private readonly rest: RestApi;

  constructor(forge: Forge, rest: RestApi) {
    this.forge = forge;
    this.rest = rest;
  }

  handle(raw: Buffer, authorized: boolean, origin: string): McpReply {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: the body is not JSON' } } };
    }
    if (Array.isArray(message)) {
      if (message.length === 0) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: empty batch' } } };
      const replies: unknown[] = [];
      for (const m of message) {
        const r = this.dispatch(m, authorized, origin);
        if (r.status === 401) return r;
        if (r.body !== undefined) replies.push(r.body);
      }
      return replies.length ? { status: 200, body: replies } : { status: 202 };
    }
    return this.dispatch(message, authorized, origin);
  }

  private dispatch(message: unknown, authorized: boolean, origin: string): McpReply {
    if (!message || typeof message !== 'object') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } } };
    }
    const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const isNotification = !('id' in m) || m.id === undefined;
    const id = isNotification ? null : (m.id as string | number | null);
    if (typeof m.method !== 'string') {
      // A response from the client (we never send requests) or garbage.
      if (m.result !== undefined || m.error !== undefined) return { status: 202 };
      return { status: 400, body: { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid Request: method must be a string' } } };
    }
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
    if (isNotification) return { status: 202 };

    const ok = (result: unknown): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
    const error = (code: number, text: string, data?: unknown): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, error: data === undefined ? { code, message: text } : { code, message: text, data } } });
    const open = m.method === 'initialize' || m.method === 'server/discover' || m.method === 'ping';
    if (!open && !authorized) {
      return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized: a valid Authorization: Bearer token is required' } } };
    }

    switch (m.method) {
      case 'server/discover':
        return ok({
          supportedVersions: [MCP_REVISION, ...LEGACY_REVISIONS],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = asked === MCP_REVISION || LEGACY_REVISIONS.includes(asked) ? asked : LEGACY_REVISIONS[0];
        return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOL_LIST });
      case 'tools/call':
        return this.callTool(params, origin, ok, error);
      case 'resources/list':
        return ok({ resources: [] });
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return error(METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  }

  private callTool(params: Record<string, unknown>, origin: string, ok: (r: unknown) => McpReply, error: (c: number, t: string, d?: unknown) => McpReply): McpReply {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return error(INVALID_PARAMS, `Unknown tool: ${name || '(no name)'}`, { tools: TOOLS.map((t) => t.name) });
    const raw = params.arguments;
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return error(INVALID_PARAMS, 'Invalid params: arguments must be an object');
    const args = normalizeArgs(tool, (raw ?? {}) as Record<string, unknown>);
    const problems = [...missingArgs(tool, args).map((n) => `missing required argument: ${n}`), ...badTypes(tool, args)];
    const failed = (text: string): McpReply => ok({ content: [{ type: 'text', text }], isError: true });
    if (problems.length) return failed(`Invalid arguments for ${tool.name}: ${problems.join('; ')}`);
    try {
      const result = tool.run(args, { forge: this.forge, rest: this.rest, origin });
      const structured = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
      return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: structured, isError: false });
    } catch (err) {
      if (err instanceof ToolFailure || err instanceof ForgeError) return failed(err.message);
      throw err;
    }
  }
}

