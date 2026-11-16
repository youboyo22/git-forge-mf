// The HTTP front: one node:http server routing to health, git smart HTTP, REST v3, GraphQL v4 and MCP,
// all over one Forge. Auth is a bearer (or "token") credential equal to MAKEFUN_SHOP_TOKEN.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, type Account } from './forge.ts';
import { handleGit, matchGitPath } from './git/smart.ts';
import { GraphQLApi } from './graphql/schema.ts';
import { McpServer, MCP_REVISION } from './mcp.ts';
import { RestApi } from './rest.ts';

export interface ServerOptions {
  /** The token every API request must carry; when empty, any non-empty token is accepted. */
  token: string;
  /** The trial clock (ISO 8601); never the wall clock, so replays are byte-identical. */
  now: string;
  viewer: Account;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SCOPES = 'repo, read:org, workflow, gist';
const MAX_BODY = 512 * 1024 * 1024;

export function defaultOptions(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const login = env.FORGE_VIEWER_LOGIN || 'adaiversen';
  return {
    token: env.MAKEFUN_SHOP_TOKEN ?? '',
    now: env.MAKEFUN_TRIAL_NOW || '2026-01-01T00:00:00Z',
    viewer: {
      id: Number(env.FORGE_VIEWER_ID) || 1000,
      login,
      name: env.FORGE_VIEWER_NAME || 'ada iversen',
      email: env.FORGE_VIEWER_EMAIL || `${login}@example.invalid`,
    },
  };
}

export function createForgeServer(options: ServerOptions = defaultOptions()): Server {
  const forge = new Forge(options.viewer, options.now);
  const rest = new RestApi(forge);
  const graphql = new GraphQLApi(forge, rest);
  const mcp = new McpServer(forge, rest);
  let requestSeq = 0;

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const m = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(header);
    if (!m) {
      // git clients may send Basic credentials with the token as the password
      const basic = /^basic\s+(\S+)$/i.exec(header);
      if (!basic) return false;
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const password = decoded.slice(decoded.indexOf(':') + 1);
      return options.token ? password === options.token : password.length > 0;
    }
    return options.token ? m[1] === options.token : true;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requestSeq += 1;
    const requestId = `F0RG:${requestSeq.toString(16).toUpperCase().padStart(8, '0')}`;
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const qmark = rawUrl.indexOf('?');
    const query = new URLSearchParams(qmark >= 0 ? rawUrl.slice(qmark + 1) : '');
    const rawPath = qmark >= 0 ? rawUrl.slice(0, qmark) : rawUrl;
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const path = rawPath.includes('//') ? rawPath.replace(/\/{2,}/g, '/') : rawPath;

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      if (status >= 400 && process.env.FORGE_DEBUG_LOG === '1') process.stderr.write(`DBG ${method} ${req.url} -> ${status} ${JSON.stringify(body).slice(0, 200)}\n`);
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        'content-type': JSON_TYPE,
        'x-github-request-id': requestId,
        ...(text ? { 'content-length': String(Buffer.byteLength(text)) } : { 'content-length': '0' }),
        ...headers,
      });
      res.end(method === 'HEAD' ? undefined : text);
    };
    const notFound = (): void => send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });

    if (path === '/healthz' || path === '/health') {
      if (method !== 'GET' && method !== 'HEAD') return send(405, { message: 'Method Not Allowed' });
      return send(200, { ok: true });
    }

    const gitRoute = matchGitPath(path);
    if (gitRoute) {
      const body = method === 'POST' ? await readBody(req, MAX_BODY) : Buffer.alloc(0);
      // Pushes and private repositories need credentials; anonymous clones of public ones do not.
      const pushing = gitRoute.action === 'git-receive-pack' || query.get('service') === 'git-receive-pack';
      const target = forge.repo(gitRoute.owner, gitRoute.repo);
      const credentialed = req.headers.authorization !== undefined;
      if ((credentialed && !authorized(req)) || (!credentialed && (pushing || target?.isPrivate))) {
        const text = credentialed ? 'Bad credentials\n' : 'Authentication required\n';
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(text.length), 'www-authenticate': 'Basic realm="forge"', 'x-github-request-id': requestId });
        res.end(text);
        return;
      }
      const reply = handleGit(forge, gitRoute, method, query.get('service'), String(req.headers['git-protocol'] ?? ''), body);
      res.writeHead(reply.status, {
        'content-type': reply.contentType,
        'content-length': String(reply.body.length),
        'cache-control': 'no-cache, max-age=0, must-revalidate',
        expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
        pragma: 'no-cache',
        'x-github-request-id': requestId,
      });
      res.end(reply.body);
      return;
    }

    if (path === '/mcp' || path === '/mcp/') {
      if (method === 'GET') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This server does not offer an SSE stream; POST JSON-RPC messages' } }, { allow: 'POST' });
      if (method === 'DELETE') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'There is no session to end' } }, { allow: 'POST' });
      if (method !== 'POST') return send(405, { message: 'Method Not Allowed' }, { allow: 'POST' });
      const reply = mcp.handle(await readBody(req, MAX_BODY), authorized(req), origin);
      const headers: Record<string, string> = { 'mcp-protocol-version': String(req.headers['mcp-protocol-version'] ?? MCP_REVISION) };
      if (reply.status === 401) headers['www-authenticate'] = 'Bearer realm="forge"';
      if (reply.body === undefined) {
        res.writeHead(reply.status, { 'x-github-request-id': requestId, 'content-length': '0', ...headers });
        res.end();
        return;
      }
      return send(reply.status, reply.body, headers);
    }

    if (path === '/api/graphql' || path === '/graphql' || path === '/api/graphql/') {
      if (method !== 'POST') return send(405, { message: 'Method Not Allowed' }, { allow: 'POST' });
      const raw = await readBody(req, MAX_BODY);
      if (!authorized(req)) return send(401, { message: 'This endpoint requires you to be authenticated.', documentation_url: 'https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' });
      }
      return send(200, graphql.handle(parsed, origin), { 'x-oauth-scopes': SCOPES });
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, MAX_BODY);
      if (!authorized(req)) {
        const bad = req.headers.authorization !== undefined;
        return send(401, { message: bad ? 'Bad credentials' : 'Requires authentication', documentation_url: 'https://docs.github.com/rest', status: '401' });
      }
      let body: Record<string, unknown> = {};
      if (raw.length > 0 && raw.toString('utf8').trim() !== '') {
        try {
          const parsed = JSON.parse(raw.toString('utf8'));
          if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
          body = parsed as Record<string, unknown>;
        } catch {
          return send(400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest', status: '400' });
        }
      }
      const reply = rest.handle({ method, path: path.slice('/api/v3'.length).replace(/\/$/, ''), query: query, body, origin });
      // Kept to what clients act on (scopes, pagination links): every extra header is parse time
      // on the client for each of thousands of calls.
      const headers: Record<string, string> = { 'x-oauth-scopes': SCOPES, 'x-github-media-type': 'github.v3; format=json', ...(reply.headers ?? {}) };
      if (reply.status === 204) {
        res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
        res.end();
        return;
      }
      return send(reply.status, reply.body, headers);
    }

    return notFound();
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] ${req.method} ${req.url}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        const text = JSON.stringify({ message: 'Server Error' });
        res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)) });
        res.end(text);
      } else {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  return server;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
