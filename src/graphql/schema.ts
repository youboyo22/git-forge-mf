// The slice of GitHub's GraphQL v4 schema this forge serves: the viewer, repositories, issues, pull
// requests, comments, labels and refs, Relay nodes and connections, and the gh CLI's mutations.
// Sources are tagged objects ({__typename, ...}) so interfaces resolve to their concrete type.

import { ForgeError, type Comment, type FileChange, type Forge, type Issue, type Label, type Repository } from '../forge.ts';
import type { Commit } from '../git/objects.ts';
import { globalId, parseGlobalId } from '../ids.ts';
import type { RestApi } from '../rest.ts';
import { Executor, GraphQLError, type FieldDef, type Schema, type TypeDef } from './execute.ts';

export interface GqlContext {
  readonly forge: Forge;
  readonly rest: RestApi;
  readonly origin: string;
}

type Src = Record<string, any>;

const userSrc = (forge: Forge): Src => ({ __typename: 'User', account: forge.viewer });
const repoSrc = (repo: Repository): Src => ({ __typename: 'Repository', repo });
const issueSrc = (repo: Repository, issue: Issue): Src => ({ __typename: issue.pull ? 'PullRequest' : 'Issue', repo, issue });
const commentSrc = (repo: Repository, issue: Issue, comment: Comment): Src => ({ __typename: 'IssueComment', repo, issue, comment });
const labelSrc = (repo: Repository, label: Label): Src => ({ __typename: 'Label', repo, label });
const commitSrc = (repo: Repository, sha: string): Src | null => {
  const commit = repo.commit(sha);
  return commit ? { __typename: 'Commit', repo, sha, commit } : null;
};
const refSrc = (repo: Repository, name: string): Src | null => {
  const sha = repo.refs.get(name);
  return sha ? { __typename: 'Ref', repo, name, sha } : null;
};

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ------------------------------------------------------------------------------------------------ connections

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:v2:${index}`).toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const m = /^cursor:v2:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  if (!m) throw new GraphQLError(`\`${cursor}\` does not appear to be a valid cursor.`, 'INVALID_CURSOR_ARGUMENTS');
  return Number(m[1]);
}

/** Relay pagination over a materialised list (first/after/last/before). */
function connection(typename: string, items: unknown[], args: Record<string, any>): Src {
  const first = args.first;
  const last = args.last;
  for (const [name, v] of [['first', first], ['last', last]] as const) {
    if (v !== undefined && v !== null && (typeof v !== 'number' || v < 0 || v > 100)) {
      throw new GraphQLError(`Requesting ${v} records on the \`${typename}\` connection exceeds the \`${name}\` limit of 100 records.`, 'EXCESSIVE_PAGE_SIZE');
    }
  }
  const after = decodeCursor(args.after);
  const before = decodeCursor(args.before);
  let start = after === null ? 0 : after + 1;
  let end = before === null ? items.length : Math.min(before, items.length);
  if (typeof first === 'number') end = Math.min(end, start + first);
  if (typeof last === 'number') start = Math.max(start, end - last);
  const slice = items.slice(start, end).map((node, i) => ({ cursor: encodeCursor(start + i), node }));
  return {
    __typename: typename,
    totalCount: items.length,
    nodes: slice.map((e) => e.node),
    edges: slice.map((e) => ({ __typename: typename.replace(/Connection$/, 'Edge'), ...e })),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? slice[0].cursor : null,
      endCursor: slice.length ? slice[slice.length - 1].cursor : null,
    },
  };
}

const PAGE_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

function connectionTypes(node: string): TypeDef[] {
  return [
    {
      kind: 'OBJECT',
      name: `${node}Connection`,
      fields: {
        edges: { type: `[${node}Edge]` },
        nodes: { type: `[${node}]` },
        pageInfo: { type: 'PageInfo!' },
        totalCount: { type: 'Int!' },
      },
    },
    { kind: 'OBJECT', name: `${node}Edge`, fields: { cursor: { type: 'String!' }, node: { type: node } } },
  ];
}

// ------------------------------------------------------------------------------------------------ lookups

function requireRepo(forge: Forge, id: unknown): Repository {
  const parsed = parseGlobalId(id);
  const repo = parsed?.kind === 'Repository' ? forge.repoById(Number(parsed.id)) : undefined;
  if (!repo) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
  return repo;
}

function requireIssue(forge: Forge, id: unknown, kinds: string[]): { repo: Repository; issue: Issue } {
  const parsed = parseGlobalId(id);
  const found = parsed && kinds.includes(parsed.kind) ? forge.findIssue(Number(parsed.id)) : undefined;
  if (!found || (parsed!.kind === 'PullRequest') !== Boolean(found.issue.pull)) {
    throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
  }
  return found;
}

function nodeFor(forge: Forge, id: unknown): Src | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const n = Number(parsed.id);
  switch (parsed.kind) {
    case 'Repository': {
      const repo = forge.repoById(n);
      return repo ? repoSrc(repo) : null;
    }
    case 'User':
      return n === forge.viewer.id ? userSrc(forge) : null;
    case 'Issue':
    case 'PullRequest': {
      const found = forge.findIssue(n);
      return found && (parsed.kind === 'PullRequest') === Boolean(found.issue.pull) ? issueSrc(found.repo, found.issue) : null;
    }
    case 'IssueComment': {
      const found = forge.findComment(n);
      return found ? commentSrc(found.repo, found.issue, found.comment) : null;
    }
    default:
      return null;
  }
}

/** Run a forge operation, turning its validation errors into GraphQL errors. */
function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ForgeError) throw new GraphQLError(err.message.replace(/^Validation Failed: /, ''), err.status === 404 ? 'NOT_FOUND' : 'UNPROCESSABLE');
    throw err;
  }
}

function issueState(issue: Issue): string {
  if (issue.pull?.merged) return 'MERGED';
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function orderIssues(list: Issue[], orderBy: any): Issue[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'ASC';
  const key = (i: Issue): number | string => (field === 'UPDATED_AT' ? i.updatedAt : field === 'COMMENTS' ? i.comments.length : i.number);
  const sorted = [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : a.number - b.number;
  });
  return direction === 'DESC' ? sorted.reverse() : sorted;
}

function filterStates(list: Issue[], states: unknown): Issue[] {
  if (!Array.isArray(states) || states.length === 0) return list;
  return list.filter((i) => states.includes(issueState(i)));
}

// ------------------------------------------------------------------------------------------------ the schema

const f = (type: string, resolve?: FieldDef['resolve'], args?: Record<string, string>, description?: string): FieldDef => ({ type, resolve, args, description });

function actorFields(): Record<string, FieldDef> {
  return {
    login: f('String!', (s) => s.account.login),
    avatarUrl: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/avatars/${s.account.login}`, { size: 'Int' }),
    url: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/${s.account.login}`),
    resourcePath: f('URI!', (s) => `/${s.account.login}`),
  };
}

function issueLikeFields(): Record<string, FieldDef> {
  return {
    id: f('ID!', (s) => globalId(s.issue.pull ? 'PullRequest' : 'Issue', s.issue.id)),
    databaseId: f('Int', (s) => s.issue.id),
    number: f('Int!', (s) => s.issue.number),
    title: f('String!', (s) => s.issue.title),
    body: f('String!', (s) => s.issue.body),
    bodyText: f('String!', (s) => s.issue.body),
    closed: f('Boolean!', (s) => s.issue.state === 'closed'),
    closedAt: f('DateTime', (s) => s.issue.closedAt),
    createdAt: f('DateTime!', (s) => s.issue.createdAt),
    updatedAt: f('DateTime!', (s) => s.issue.updatedAt),
    url: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/${s.repo.fullName}/${s.issue.pull ? 'pull' : 'issues'}/${s.issue.number}`),
    resourcePath: f('URI!', (s) => `/${s.repo.fullName}/${s.issue.pull ? 'pull' : 'issues'}/${s.issue.number}`),
    author: f('Actor', (_s, _a, c: GqlContext) => userSrc(c.forge)),
    authorAssociation: f('CommentAuthorAssociation!', () => 'OWNER'),
    repository: f('Repository!', (s) => repoSrc(s.repo)),
    locked: f('Boolean!', () => false),
    labels: f('LabelConnection', (s, a) => connection('LabelConnection', s.issue.labels.map((l: Label) => labelSrc(s.repo, l)), a), { ...PAGE_ARGS, orderBy: 'LabelOrder' }),
    comments: f('IssueCommentConnection!', (s, a) => connection('IssueCommentConnection', s.issue.comments.map((c: Comment) => commentSrc(s.repo, s.issue, c)), a), { ...PAGE_ARGS, orderBy: 'IssueCommentOrder' }),
    assignees: f('UserConnection!', (_s, a) => connection('UserConnection', [], a), PAGE_ARGS),
    viewerCanUpdate: f('Boolean!', () => true),
  };
}

export function buildSchema(): Schema {
  const types: TypeDef[] = [];
  const add = (...defs: TypeDef[]): void => void types.push(...defs);

  for (const name of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'GitTimestamp']) add({ kind: 'SCALAR', name });

  add({ kind: 'INTERFACE', name: 'Node', fields: { id: f('ID!') } });
  add({ kind: 'INTERFACE', name: 'Actor', fields: actorFields() });
  add({ kind: 'INTERFACE', name: 'RepositoryOwner', fields: { ...actorFields(), id: f('ID!') } });
  add({ kind: 'INTERFACE', name: 'GitObject', fields: { id: f('ID!'), oid: f('GitObjectID!') } });
  add({ kind: 'UNION', name: 'IssueOrPullRequest', types: ['Issue', 'PullRequest'] });

  add({
    kind: 'OBJECT',
    name: 'Query',
    fields: {
      viewer: f('User!', (_s, _a, c: GqlContext) => userSrc(c.forge)),
      user: f('User', (_s, a, c: GqlContext) => (String(a.login).toLowerCase() === c.forge.viewer.login.toLowerCase() ? userSrc(c.forge) : null), { login: 'String!' }),
      repositoryOwner: f('RepositoryOwner', (_s, a, c: GqlContext) => (String(a.login).toLowerCase() === c.forge.viewer.login.toLowerCase() ? userSrc(c.forge) : null), { login: 'String!' }),
      repository: f('Repository', (_s, a, c: GqlContext) => {
        const repo = c.forge.repo(String(a.owner), String(a.name));
        return repo ? repoSrc(repo) : null;
      }, { owner: 'String!', name: 'String!', followRenames: 'Boolean' }),
      node: f('Node', (_s, a, c: GqlContext) => nodeFor(c.forge, a.id), { id: 'ID!' }),
      nodes: f('[Node]!', (_s, a, c: GqlContext) => (Array.isArray(a.ids) ? a.ids.map((id: unknown) => nodeFor(c.forge, id)) : []), { ids: '[ID!]!' }),
      rateLimit: f('RateLimit', () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '1970-01-01T01:00:00Z', nodeCount: 0 }), { dryRun: 'Boolean' }),
    },
  });
  add({ kind: 'OBJECT', name: 'RateLimit', fields: { limit: f('Int!'), cost: f('Int!'), remaining: f('Int!'), used: f('Int!'), resetAt: f('DateTime!'), nodeCount: f('Int!') } });

  add({
    kind: 'OBJECT',
    name: 'User',
    interfaces: ['Node', 'Actor', 'RepositoryOwner'],
    fields: {
      ...actorFields(),
      id: f('ID!', (s) => globalId('User', s.account.id)),
      databaseId: f('Int', (s) => s.account.id),
      name: f('String', (s) => s.account.name),
      email: f('String!', (s) => s.account.email),
      repositories: f('RepositoryConnection!', (_s, a, c: GqlContext) => connection('RepositoryConnection', c.forge.list().map(repoSrc), a), { ...PAGE_ARGS, privacy: 'RepositoryPrivacy', orderBy: 'RepositoryOrder', ownerAffiliations: '[RepositoryAffiliation]' }),
      repository: f('Repository', (s, a, c: GqlContext) => {
        const repo = c.forge.repo(s.account.login, String(a.name));
        return repo ? repoSrc(repo) : null;
      }, { name: 'String!' }),
    },
  });

  add({
    kind: 'OBJECT',
    name: 'Repository',
    interfaces: ['Node'],
    fields: {
      id: f('ID!', (s) => globalId('Repository', s.repo.id)),
      databaseId: f('Int', (s) => s.repo.id),
      name: f('String!', (s) => s.repo.name),
      nameWithOwner: f('String!', (s) => s.repo.fullName),
      owner: f('RepositoryOwner!', (_s, _a, c: GqlContext) => userSrc(c.forge)),
      description: f('String', (s) => s.repo.description || null),
      url: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/${s.repo.fullName}`),
      sshUrl: f('GitSSHRemote!', (s, _a, c: GqlContext) => `git@${c.origin.replace(/^https?:\/\//, '')}:${s.repo.fullName}.git`),
      resourcePath: f('URI!', (s) => `/${s.repo.fullName}`),
      isPrivate: f('Boolean!', (s) => s.repo.isPrivate),
      visibility: f('RepositoryVisibility!', (s) => (s.repo.isPrivate ? 'PRIVATE' : 'PUBLIC')),
      isFork: f('Boolean!', () => false),
      isArchived: f('Boolean!', () => false),
      isEmpty: f('Boolean!', (s) => s.repo.refs.size === 0),
      isTemplate: f('Boolean!', () => false),
      createdAt: f('DateTime!', (s) => s.repo.createdAt),
      updatedAt: f('DateTime!', (s) => s.repo.updatedAt),
      pushedAt: f('DateTime', (s) => s.repo.pushedAt),
      hasIssuesEnabled: f('Boolean!', () => true),
      hasWikiEnabled: f('Boolean!', () => false),
      hasProjectsEnabled: f('Boolean!', () => false),
      viewerPermission: f('RepositoryPermission', () => 'ADMIN'),
      viewerCanAdminister: f('Boolean!', () => true),
      mergeCommitAllowed: f('Boolean!', () => true),
      squashMergeAllowed: f('Boolean!', () => true),
      rebaseMergeAllowed: f('Boolean!', () => true),
      defaultBranchRef: f('Ref', (s) => refSrc(s.repo, `refs/heads/${s.repo.defaultBranch}`)),
      ref: f('Ref', (s, a) => refSrc(s.repo, String(a.qualifiedName).startsWith('refs/') ? String(a.qualifiedName) : `refs/heads/${a.qualifiedName}`), { qualifiedName: 'String!' }),
      refs: f('RefConnection', (s, a) => {
        const prefix = String(a.refPrefix ?? 'refs/');
        const names = [...s.repo.refs.keys()].filter((n: string) => n.startsWith(prefix)).sort();
        return connection('RefConnection', names.map((n: string) => refSrc(s.repo, n)), a);
      }, { ...PAGE_ARGS, refPrefix: 'String!', query: 'String', orderBy: 'RefOrder', direction: 'OrderDirection' }),
      object: f('GitObject', (s, a) => {
        const sha = a.oid ?? (a.expression ? s.repo.resolve(String(a.expression)) : undefined);
        return sha ? commitSrc(s.repo, String(sha)) : null;
      }, { oid: 'GitObjectID', expression: 'String' }),
      issue: f('Issue', (s, a) => {
        const issue = s.repo.issue(a.number);
        return issue && !issue.pull ? issueSrc(s.repo, issue) : null;
      }, { number: 'Int!' }),
      issueOrPullRequest: f('IssueOrPullRequest', (s, a) => {
        const issue = s.repo.issue(a.number);
        return issue ? issueSrc(s.repo, issue) : null;
      }, { number: 'Int!' }),
      issues: f('IssueConnection!', (s, a) => {
        let list = s.repo.issues.filter((i: Issue) => !i.pull);
        list = filterStates(list, a.states);
        if (Array.isArray(a.labels) && a.labels.length) list = list.filter((i: Issue) => a.labels.some((n: string) => i.labels.some((l) => l.name.toLowerCase() === String(n).toLowerCase())));
        return connection('IssueConnection', orderIssues(list, a.orderBy).map((i) => issueSrc(s.repo, i)), a);
      }, { ...PAGE_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' }),
      pullRequest: f('PullRequest', (s, a) => {
        const issue = s.repo.issue(a.number);
        return issue?.pull ? issueSrc(s.repo, issue) : null;
      }, { number: 'Int!' }),
      pullRequests: f('PullRequestConnection!', (s, a) => {
        let list = s.repo.issues.filter((i: Issue) => i.pull);
        list = filterStates(list, a.states);
        if (a.headRefName) list = list.filter((i: Issue) => i.pull!.head === a.headRefName);
        if (a.baseRefName) list = list.filter((i: Issue) => i.pull!.base === a.baseRefName);
        return connection('PullRequestConnection', orderIssues(list, a.orderBy).map((i) => issueSrc(s.repo, i)), a);
      }, { ...PAGE_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', headRefName: 'String', baseRefName: 'String', labels: '[String!]' }),
      labels: f('LabelConnection', (s, a) => {
        let labels = [...s.repo.labels.values()].sort((x: Label, y: Label) => x.id - y.id);
        if (a.query) labels = labels.filter((l: Label) => l.name.toLowerCase().includes(String(a.query).toLowerCase()));
        return connection('LabelConnection', labels.map((l: Label) => labelSrc(s.repo, l)), a);
      }, { ...PAGE_ARGS, query: 'String', orderBy: 'LabelOrder' }),
      label: f('Label', (s, a) => {
        const label = s.repo.label(String(a.name));
        return label ? labelSrc(s.repo, label) : null;
      }, { name: 'String!' }),
    },
  });

  add({
    kind: 'OBJECT',
    name: 'Ref',
    interfaces: ['Node'],
    fields: {
      id: f('ID!', (s) => globalId('Ref', `${s.repo.id}:${s.name}`)),
      name: f('String!', (s) => s.name.replace(/^refs\/(heads|tags)\//, '')),
      prefix: f('String!', (s) => (/^refs\/(heads|tags)\//.exec(s.name)?.[0] ?? 'refs/')),
      repository: f('Repository!', (s) => repoSrc(s.repo)),
      target: f('GitObject', (s) => commitSrc(s.repo, s.repo.peel(s.sha))),
    },
  });

  add({
    kind: 'OBJECT',
    name: 'Commit',
    interfaces: ['Node', 'GitObject'],
    fields: {
      id: f('ID!', (s) => globalId('Commit', s.sha)),
      oid: f('GitObjectID!', (s) => s.sha),
      abbreviatedOid: f('String!', (s) => s.sha.slice(0, 7)),
      message: f('String!', (s) => (s.commit as Commit).message.replace(/\n+$/, '')),
      messageHeadline: f('String!', (s) => (s.commit as Commit).message.split('\n')[0]),
      messageBody: f('String!', (s) => (s.commit as Commit).message.split('\n').slice(1).join('\n').trim()),
      committedDate: f('DateTime!', (s) => iso((s.commit as Commit).committer.seconds)),
      authoredDate: f('DateTime!', (s) => iso((s.commit as Commit).author.seconds)),
      url: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/${s.repo.fullName}/commit/${s.sha}`),
      author: f('GitActor', (s) => ({ name: s.commit.author.name, email: s.commit.author.email, date: iso(s.commit.author.seconds) })),
      committer: f('GitActor', (s) => ({ name: s.commit.committer.name, email: s.commit.committer.email, date: iso(s.commit.committer.seconds) })),
      parents: f('CommitConnection!', (s, a) => connection('CommitConnection', (s.commit as Commit).parents.map((p) => commitSrc(s.repo, p)).filter(Boolean), a), PAGE_ARGS),
      history: f('CommitHistoryConnection!', (s, a) => connection('CommitHistoryConnection', s.repo.log(s.sha).map((e: { sha: string }) => commitSrc(s.repo, e.sha)), a), PAGE_ARGS),
      repository: f('Repository!', (s) => repoSrc(s.repo)),
    },
  });
  add({ kind: 'OBJECT', name: 'GitActor', fields: { name: f('String'), email: f('String'), date: f('GitTimestamp') } });
  add({ kind: 'SCALAR', name: 'GitSSHRemote' });

  add({ kind: 'OBJECT', name: 'Issue', interfaces: ['Node'], fields: { ...issueLikeFields(), state: f('IssueState!', (s) => issueState(s.issue)), stateReason: f('IssueStateReason', (s) => s.issue.stateReason?.toUpperCase() ?? null) } });

  add({
    kind: 'OBJECT',
    name: 'PullRequest',
    interfaces: ['Node'],
    fields: {
      ...issueLikeFields(),
      state: f('PullRequestState!', (s) => issueState(s.issue)),
      merged: f('Boolean!', (s) => s.issue.pull.merged),
      mergedAt: f('DateTime', (s) => s.issue.pull.mergedAt),
      mergedBy: f('Actor', (s, _a, c: GqlContext) => (s.issue.pull.merged ? userSrc(c.forge) : null)),
      mergeable: f('MergeableState!', (s) => (s.issue.state !== 'open' ? 'UNKNOWN' : s.repo.mergeable(s.issue) ? 'MERGEABLE' : 'CONFLICTING')),
      isDraft: f('Boolean!', () => false),
      headRefName: f('String!', (s) => s.issue.pull.head),
      baseRefName: f('String!', (s) => s.issue.pull.base),
      headRefOid: f('GitObjectID!', (s) => s.repo.syncPull(s.issue).headSha),
      baseRefOid: f('GitObjectID!', (s) => s.repo.syncPull(s.issue).baseSha),
      headRef: f('Ref', (s) => refSrc(s.repo, `refs/heads/${s.issue.pull.head}`)),
      baseRef: f('Ref', (s) => refSrc(s.repo, `refs/heads/${s.issue.pull.base}`)),
      headRepository: f('Repository', (s) => repoSrc(s.repo)),
      baseRepository: f('Repository', (s) => repoSrc(s.repo)),
      headRepositoryOwner: f('RepositoryOwner', (_s, _a, c: GqlContext) => userSrc(c.forge)),
      isCrossRepository: f('Boolean!', () => false),
      mergeCommit: f('Commit', (s) => (s.issue.pull.mergeCommitSha ? commitSrc(s.repo, s.issue.pull.mergeCommitSha) : null)),
      additions: f('Int!', (s) => s.repo.pullFiles(s.issue).reduce((n: number, x: FileChange) => n + x.additions, 0)),
      deletions: f('Int!', (s) => s.repo.pullFiles(s.issue).reduce((n: number, x: FileChange) => n + x.deletions, 0)),
      changedFiles: f('Int!', (s) => s.repo.pullFiles(s.issue).length),
      files: f('PullRequestChangedFileConnection', (s, a) => connection('PullRequestChangedFileConnection', s.repo.pullFiles(s.issue).map((x: FileChange) => ({
        __typename: 'PullRequestChangedFile',
        path: x.filename,
        additions: x.additions,
        deletions: x.deletions,
        changeType: x.status === 'added' ? 'ADDED' : x.status === 'removed' ? 'DELETED' : 'MODIFIED',
      })), a), PAGE_ARGS),
      commits: f('PullRequestCommitConnection!', (s, a) => {
        const pull = s.repo.syncPull(s.issue);
        const excluded = s.repo.ancestors(pull.baseSha);
        const list = s.repo.log(pull.headSha).filter((e: { sha: string }) => !excluded.has(e.sha)).reverse();
        return connection('PullRequestCommitConnection', list.map((e: { sha: string }) => ({ __typename: 'PullRequestCommit', commit: commitSrc(s.repo, e.sha), id: globalId('Commit', e.sha) })), a);
      }, PAGE_ARGS),
    },
  });
  add({ kind: 'OBJECT', name: 'PullRequestCommit', interfaces: ['Node'], fields: { id: f('ID!'), commit: f('Commit!') } });
  add({ kind: 'OBJECT', name: 'PullRequestChangedFile', fields: { path: f('String!'), additions: f('Int!'), deletions: f('Int!'), changeType: f('PatchStatus!') } });

  add({
    kind: 'OBJECT',
    name: 'IssueComment',
    interfaces: ['Node'],
    fields: {
      id: f('ID!', (s) => globalId('IssueComment', s.comment.id)),
      databaseId: f('Int', (s) => s.comment.id),
      body: f('String!', (s) => s.comment.body),
      bodyText: f('String!', (s) => s.comment.body),
      createdAt: f('DateTime!', (s) => s.comment.createdAt),
      updatedAt: f('DateTime!', (s) => s.comment.createdAt),
      author: f('Actor', (_s, _a, c: GqlContext) => userSrc(c.forge)),
      authorAssociation: f('CommentAuthorAssociation!', () => 'OWNER'),
      url: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/${s.repo.fullName}/issues/${s.issue.number}#issuecomment-${s.comment.id}`),
      issue: f('Issue!', (s) => issueSrc(s.repo, s.issue)),
      repository: f('Repository!', (s) => repoSrc(s.repo)),
    },
  });

  add({
    kind: 'OBJECT',
    name: 'Label',
    interfaces: ['Node'],
    fields: {
      id: f('ID!', (s) => globalId('Label', s.label.id)),
      name: f('String!', (s) => s.label.name),
      color: f('String!', (s) => s.label.color),
      description: f('String', (s) => s.label.description || null),
      isDefault: f('Boolean!', () => false),
      url: f('URI!', (s, _a, c: GqlContext) => `${c.origin}/${s.repo.fullName}/labels/${encodeURIComponent(s.label.name)}`),
    },
  });

  add({ kind: 'OBJECT', name: 'PageInfo', fields: { hasNextPage: f('Boolean!'), hasPreviousPage: f('Boolean!'), startCursor: f('String'), endCursor: f('String') } });
  for (const node of ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'Label', 'User', 'Ref', 'Commit', 'CommitHistory', 'PullRequestChangedFile', 'PullRequestCommit']) {
    const [conn, edge] = connectionTypes(node);
    if (node === 'CommitHistory') {
      (conn as { fields: Record<string, FieldDef> }).fields.nodes = f('[Commit]');
      (edge as { fields: Record<string, FieldDef> }).fields.node = f('Commit');
    }
    add(conn, edge);
  }

  // enums
  add({ kind: 'ENUM', name: 'IssueState', values: ['OPEN', 'CLOSED'] });
  add({ kind: 'ENUM', name: 'IssueStateReason', values: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'] });
  add({ kind: 'ENUM', name: 'PullRequestState', values: ['OPEN', 'CLOSED', 'MERGED'] });
  add({ kind: 'ENUM', name: 'MergeableState', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] });
  add({ kind: 'ENUM', name: 'PullRequestMergeMethod', values: ['MERGE', 'SQUASH', 'REBASE'] });
  add({ kind: 'ENUM', name: 'RepositoryPermission', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] });
  add({ kind: 'ENUM', name: 'RepositoryVisibility', values: ['PRIVATE', 'PUBLIC', 'INTERNAL'] });
  add({ kind: 'ENUM', name: 'RepositoryPrivacy', values: ['PRIVATE', 'PUBLIC'] });
  add({ kind: 'ENUM', name: 'RepositoryAffiliation', values: ['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER'] });
  add({ kind: 'ENUM', name: 'CommentAuthorAssociation', values: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] });
  add({ kind: 'ENUM', name: 'OrderDirection', values: ['ASC', 'DESC'] });
  add({ kind: 'ENUM', name: 'IssueOrderField', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] });
  add({ kind: 'ENUM', name: 'PatchStatus', values: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'] });
  add({ kind: 'ENUM', name: 'SearchType', values: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'] });

  // inputs
  add({ kind: 'INPUT_OBJECT', name: 'IssueOrder', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } });
  add({ kind: 'INPUT_OBJECT', name: 'IssueFilters', inputFields: { states: '[IssueState!]', labels: '[String!]' } });
  for (const name of ['LabelOrder', 'IssueCommentOrder', 'RepositoryOrder', 'RefOrder']) add({ kind: 'INPUT_OBJECT', name, inputFields: { field: 'String!', direction: 'OrderDirection!' } });
  add({ kind: 'INPUT_OBJECT', name: 'CreateIssueInput', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'CloseIssueInput', inputFields: { issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'ReopenIssueInput', inputFields: { issueId: 'ID!', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'UpdateIssueInput', inputFields: { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', labelIds: '[ID!]', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'AddCommentInput', inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput', inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'MergePullRequestInput', inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'ClosePullRequestInput', inputFields: { pullRequestId: 'ID!', clientMutationId: 'String' } });
  add({ kind: 'INPUT_OBJECT', name: 'CreateRepositoryInput', inputFields: { name: 'String!', visibility: 'RepositoryVisibility!', description: 'String', clientMutationId: 'String' } });
  add({ kind: 'ENUM', name: 'IssueClosedStateReason', values: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'] });

  // mutations and their payloads
  const payload = (name: string, fields: Record<string, FieldDef>): void => add({ kind: 'OBJECT', name, fields: { clientMutationId: f('String'), ...fields } });
  payload('CreateIssuePayload', { issue: f('Issue') });
  payload('CloseIssuePayload', { issue: f('Issue') });
  payload('ReopenIssuePayload', { issue: f('Issue') });
  payload('UpdateIssuePayload', { issue: f('Issue') });
  payload('AddCommentPayload', { commentEdge: f('IssueCommentEdge'), subject: f('Node'), timelineEdge: f('IssueCommentEdge') });
  payload('CreatePullRequestPayload', { pullRequest: f('PullRequest') });
  payload('MergePullRequestPayload', { pullRequest: f('PullRequest'), actor: f('Actor') });
  payload('ClosePullRequestPayload', { pullRequest: f('PullRequest') });
  payload('CreateRepositoryPayload', { repository: f('Repository') });

  const input = (a: Record<string, any>): Record<string, any> => {
    if (!a.input || typeof a.input !== 'object') throw new GraphQLError("Argument 'input' on Field is required", 'INVALID_ARGUMENTS');
    return a.input;
  };
  const labelsByIds = (repo: Repository, ids: unknown): Label[] => {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => {
      const parsed = parseGlobalId(id);
      const label = parsed?.kind === 'Label' ? [...repo.labels.values()].find((l) => l.id === Number(parsed.id)) : undefined;
      if (!label) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
      return label;
    });
  };

  add({
    kind: 'OBJECT',
    name: 'Mutation',
    fields: {
      createIssue: f('CreateIssuePayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const repo = requireRepo(c.forge, i.repositoryId);
        const issue = attempt(() => c.rest.createIssue(repo, { title: i.title, body: i.body ?? '' }));
        issue.labels = labelsByIds(repo, i.labelIds);
        return { clientMutationId: i.clientMutationId ?? null, issue: issueSrc(repo, issue) };
      }, { input: 'CreateIssueInput!' }),
      closeIssue: f('CloseIssuePayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const { repo, issue } = requireIssue(c.forge, i.issueId, ['Issue']);
        repo.setState(issue, 'closed', typeof i.stateReason === 'string' ? i.stateReason.toLowerCase() : 'completed');
        return { clientMutationId: i.clientMutationId ?? null, issue: issueSrc(repo, issue) };
      }, { input: 'CloseIssueInput!' }),
      reopenIssue: f('ReopenIssuePayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const { repo, issue } = requireIssue(c.forge, i.issueId, ['Issue']);
        repo.setState(issue, 'open', 'reopened');
        return { clientMutationId: i.clientMutationId ?? null, issue: issueSrc(repo, issue) };
      }, { input: 'ReopenIssueInput!' }),
      updateIssue: f('UpdateIssuePayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const { repo, issue } = requireIssue(c.forge, i.id, ['Issue']);
        attempt(() => c.rest.updateIssue(repo, issue, { title: i.title ?? undefined, body: i.body ?? undefined, state: typeof i.state === 'string' ? i.state.toLowerCase() : undefined }));
        if (Array.isArray(i.labelIds)) issue.labels = labelsByIds(repo, i.labelIds);
        return { clientMutationId: i.clientMutationId ?? null, issue: issueSrc(repo, issue) };
      }, { input: 'UpdateIssueInput!' }),
      addComment: f('AddCommentPayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const { repo, issue } = requireIssue(c.forge, i.subjectId, ['Issue', 'PullRequest']);
        if (typeof i.body !== 'string' || i.body === '') throw new GraphQLError('Body cannot be blank', 'UNPROCESSABLE');
        const comment = repo.addComment(issue, i.body);
        const edge = { __typename: 'IssueCommentEdge', cursor: encodeCursor(issue.comments.length - 1), node: commentSrc(repo, issue, comment) };
        return { clientMutationId: i.clientMutationId ?? null, commentEdge: edge, timelineEdge: edge, subject: issueSrc(repo, issue) };
      }, { input: 'AddCommentInput!' }),
      createPullRequest: f('CreatePullRequestPayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const repo = requireRepo(c.forge, i.repositoryId);
        const issue = attempt(() => c.rest.createPull(repo, { title: i.title, body: i.body ?? '', head: i.headRefName, base: i.baseRefName }));
        return { clientMutationId: i.clientMutationId ?? null, pullRequest: issueSrc(repo, issue) };
      }, { input: 'CreatePullRequestInput!' }),
      mergePullRequest: f('MergePullRequestPayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const { repo, issue } = requireIssue(c.forge, i.pullRequestId, ['PullRequest']);
        attempt(() => c.rest.mergePull(repo, issue, {
          merge_method: typeof i.mergeMethod === 'string' ? i.mergeMethod.toLowerCase() : 'merge',
          commit_title: i.commitHeadline ?? undefined,
          commit_message: i.commitBody ?? undefined,
          sha: i.expectedHeadOid ?? undefined,
        }));
        return { clientMutationId: i.clientMutationId ?? null, pullRequest: issueSrc(repo, issue), actor: userSrc(c.forge) };
      }, { input: 'MergePullRequestInput!' }),
      closePullRequest: f('ClosePullRequestPayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const { repo, issue } = requireIssue(c.forge, i.pullRequestId, ['PullRequest']);
        repo.setState(issue, 'closed', null);
        return { clientMutationId: i.clientMutationId ?? null, pullRequest: issueSrc(repo, issue) };
      }, { input: 'ClosePullRequestInput!' }),
      createRepository: f('CreateRepositoryPayload', (_s, a, c: GqlContext) => {
        const i = input(a);
        const repo = attempt(() => c.forge.create(String(i.name ?? ''), String(i.description ?? ''), i.visibility === 'PRIVATE'));
        return { clientMutationId: i.clientMutationId ?? null, repository: repoSrc(repo) };
      }, { input: 'CreateRepositoryInput!' }),
    },
  });

  return { types: new Map(types.map((t) => [t.name, t])), query: 'Query', mutation: 'Mutation' };
}

export class GraphQLApi {
  private readonly executor = new Executor(buildSchema());
  private readonly forge: Forge;
  private readonly rest: RestApi;

  constructor(forge: Forge, rest: RestApi) {
    this.forge = forge;
    this.rest = rest;
  }

  /** One request body: a single operation object, or an array of them (batching). */
  handle(body: unknown, origin: string): unknown {
    const ctx: GqlContext = { forge: this.forge, rest: this.rest, origin };
    const one = (op: unknown): unknown => {
      if (!op || typeof op !== 'object' || Array.isArray(op)) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
      const o = op as Record<string, unknown>;
      return this.executor.run(o.query, o.variables, o.operationName, ctx);
    };
    return Array.isArray(body) ? body.map(one) : one(body);
  }
}
