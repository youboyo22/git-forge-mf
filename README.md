[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/youboyo22/git-forge-mf/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/youboyo22/git-forge-mf/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for [make.fun](https://make.fun/bounty/github-core-clone-01)'s "Build a GitHub-compatible git forge" bounty.

# forge

A GitHub-compatible git forge in one Node 22 process with zero dependencies: git smart HTTP,
the REST v3 API, the GraphQL v4 API and a Model Context Protocol server, all over one in-memory
model with a real git object store (SHA-1 objects, zlib packs, built on `node:crypto` and `node:zlib`).

```
node main.ts                      # contest lifecycle: register with $MAKEFUN_ENV_URL, serve until done
FORGE_PORT=8081 node main.ts      # standalone, on a fixed port
```

## Surfaces

| Path | What |
| --- | --- |
| `GET /healthz` | `{"ok": true}` |
| `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` | Smart HTTP. Upload-pack speaks protocol v2 (`ls-refs` with symrefs/peel/prefixes/unborn; `fetch` with have/ACK negotiation, `shallow`/`deepen`/`deepen-relative`, `want-ref`, `include-tag`) and the v0 stateless fetch for clients that don't ask for v2. Receive-pack takes v0 command lists with thin packs (OFS/REF deltas), reports per ref (`report-status`, optionally in side-band-64k), and refuses non-fast-forward, stale and malformed updates per ref. |
| `/api/v3/...` | REST v3: user and repos (with `Link` pagination), branches, git refs/commits/trees/blobs, commits, contents (create/update/delete with sha checks), labels, issues and comments, pull requests (files, commits, merge/squash/rebase with three-way conflict detection). Errors are `{"message": ...}` with GitHub's status codes. |
| `POST /api/graphql` | GraphQL v4 with a real parser, validator and executor: fragments, variables, aliases, directives, batching, introspection (`__type`, `__schema`, `__typename`), Relay `node`/`nodes` and cursor connections, and the gh CLI's mutations (`createIssue`, `closeIssue`, `reopenIssue`, `updateIssue`, `addComment`, `createPullRequest`, `mergePullRequest`, `closePullRequest`, `createRepository`). Unknown fields are reported GitHub-style with no data. |
| `POST /mcp` | MCP over streamable HTTP (JSON responses): `server/discover` (2026-07-28) and the `initialize` handshake of earlier revisions, `tools/list`, `tools/call`. Tools: repositories, branches, commits, file contents, issues, comments, pull requests and merges, each a wrapper over the REST layer. |

API calls need `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (or `token ...`; git also accepts Basic
with the token as password). Anonymous clones of public repositories are allowed.

## Determinism

Nothing reads the wall clock or a random source: timestamps come from `MAKEFUN_TRIAL_NOW` plus an
event counter and ids from counters, so the same requests always produce the same bytes (commit
ids included).

## Layout

- `main.ts`: the lifecycle (bind an ephemeral port, register, poll `/done`, exit).
- `src/server.ts`: HTTP routing and auth.
- `src/forge.ts`: the model: repositories, refs, objects, issues, pull requests, merges.
- `src/git/`: `objects.ts` (object formats), `pkt.ts` (pkt-line and side-band), `pack.ts` (pack read/write, deltas), `smart.ts` (the smart HTTP protocol).
- `src/rest.ts`, `src/views.ts`: the REST routes and GitHub's JSON shapes.
- `src/graphql/`: `parse.ts`, `execute.ts` (validation, execution, introspection), `schema.ts` (types and resolvers).
- `src/mcp.ts`: the MCP server and its tools.
- `src/diff.ts`: line-level change counts (Myers).
- `src/ids.ts`: opaque global node ids shared by REST `node_id` and GraphQL `id`.

`FORGE_DEBUG_LOG=1` logs every 4xx/5xx JSON reply to stderr.

MIT licensed.
