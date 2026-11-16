// GitHub's JSON shapes for the REST v3 surface (and the MCP tools, which answer in the same shapes).
// Every URL is built on the request's own origin so clients that follow links stay on this server.

import type { Commit, Signature } from './git/objects.ts';
import type { Account, Comment, FileChange, Issue, Label, Repository } from './forge.ts';
import { globalId } from './ids.ts';

const nodeId = globalId;

export class Views {
  readonly api: string;
  readonly web: string;

  constructor(origin: string) {
    this.web = origin;
    this.api = `${origin}/api/v3`;
  }

  private readonly users = new Map<Account, Record<string, unknown>>();

  /** The user object (memoized per account: it is embedded in nearly every reply). */
  user(account: Account): Record<string, unknown> {
    let view = this.users.get(account);
    if (!view) {
      view = this.buildUser(account);
      this.users.set(account, view);
    }
    return view;
  }

  private buildUser(account: Account): Record<string, unknown> {
    const url = `${this.api}/users/${account.login}`;
    return {
      login: account.login,
      id: account.id,
      node_id: nodeId('User', account.id),
      avatar_url: `${this.web}/avatars/${account.login}`,
      gravatar_id: '',
      url,
      html_url: `${this.web}/${account.login}`,
      repos_url: `${url}/repos`,
      type: 'User',
      site_admin: false,
    };
  }

  repo(repo: Repository): Record<string, unknown> {
    const url = `${this.api}/repos/${repo.fullName}`;
    return {
      id: repo.id,
      node_id: nodeId('Repository', repo.id),
      name: repo.name,
      full_name: repo.fullName,
      private: repo.isPrivate,
      visibility: repo.isPrivate ? 'private' : 'public',
      owner: this.user(repo.owner),
      html_url: `${this.web}/${repo.fullName}`,
      description: repo.description,
      fork: false,
      url,
      issues_url: `${url}/issues{/number}`,
      pulls_url: `${url}/pulls{/number}`,
      contents_url: `${url}/contents/{+path}`,
      branches_url: `${url}/branches{/branch}`,
      commits_url: `${url}/commits{/sha}`,
      labels_url: `${url}/labels{/name}`,
      git_url: `git://${this.web.replace(/^https?:\/\//, '')}/${repo.fullName}.git`,
      clone_url: `${this.web}/${repo.fullName}.git`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.pushedAt,
      size: 0,
      default_branch: repo.defaultBranch,
      open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      archived: false,
      disabled: false,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    };
  }

  label(repo: Repository, label: Label): Record<string, unknown> {
    return {
      id: label.id,
      node_id: nodeId('Label', label.id),
      url: `${this.api}/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
      name: label.name,
      color: label.color,
      description: label.description,
      default: false,
    };
  }

  issue(repo: Repository, issue: Issue): Record<string, unknown> {
    const url = `${this.api}/repos/${repo.fullName}/issues/${issue.number}`;
    const view: Record<string, unknown> = {
      id: issue.id,
      node_id: nodeId(issue.pull ? 'PullRequest' : 'Issue', issue.id),
      url,
      repository_url: `${this.api}/repos/${repo.fullName}`,
      comments_url: `${url}/comments`,
      html_url: `${this.web}/${repo.fullName}/${issue.pull ? 'pull' : 'issues'}/${issue.number}`,
      number: issue.number,
      state: issue.state,
      state_reason: issue.stateReason,
      title: issue.title,
      body: issue.body,
      user: this.user(repo.owner),
      labels: issue.labels.map((label) => this.label(repo, label)),
      assignee: null,
      assignees: [],
      milestone: null,
      locked: false,
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      author_association: 'OWNER',
    };
    if (issue.pull) {
      view.pull_request = {
        url: `${this.api}/repos/${repo.fullName}/pulls/${issue.number}`,
        html_url: `${this.web}/${repo.fullName}/pull/${issue.number}`,
        merged_at: issue.pull.mergedAt,
      };
      view.draft = false;
    }
    return view;
  }

  comment(repo: Repository, issue: Issue, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: nodeId('IssueComment', comment.id),
      url: `${this.api}/repos/${repo.fullName}/issues/comments/${comment.id}`,
      html_url: `${this.web}/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
      issue_url: `${this.api}/repos/${repo.fullName}/issues/${issue.number}`,
      body: comment.body,
      user: this.user(repo.owner),
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      author_association: 'OWNER',
    };
  }

  private branchRef(repo: Repository, branch: string, sha: string): Record<string, unknown> {
    return { label: `${repo.owner.login}:${branch}`, ref: branch, sha, user: this.user(repo.owner), repo: this.repo(repo) };
  }

  pull(repo: Repository, issue: Issue, detailed: boolean): Record<string, unknown> {
    const pull = repo.syncPull(issue);
    const url = `${this.api}/repos/${repo.fullName}/pulls/${issue.number}`;
    const view: Record<string, unknown> = {
      id: issue.id,
      node_id: nodeId('PullRequest', issue.id),
      url,
      html_url: `${this.web}/${repo.fullName}/pull/${issue.number}`,
      diff_url: `${this.web}/${repo.fullName}/pull/${issue.number}.diff`,
      issue_url: `${this.api}/repos/${repo.fullName}/issues/${issue.number}`,
      commits_url: `${url}/commits`,
      comments_url: `${this.api}/repos/${repo.fullName}/issues/${issue.number}/comments`,
      number: issue.number,
      state: issue.state,
      locked: false,
      title: issue.title,
      body: issue.body,
      user: this.user(repo.owner),
      labels: issue.labels.map((label) => this.label(repo, label)),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      assignee: null,
      assignees: [],
      requested_reviewers: [],
      draft: false,
      head: this.branchRef(repo, pull.head, pull.headSha),
      base: this.branchRef(repo, pull.base, pull.baseSha),
      author_association: 'OWNER',
      merged: pull.merged,
    };
    if (detailed) {
      const files = repo.pullFiles(issue);
      const open = issue.state === 'open';
      view.mergeable = open ? repo.mergeable(issue) : null;
      view.mergeable_state = open ? (view.mergeable ? 'clean' : 'dirty') : 'unknown';
      view.merged_by = pull.merged ? this.user(repo.owner) : null;
      view.comments = issue.comments.length;
      view.review_comments = 0;
      view.commits = this.pullCommitCount(repo, pull.baseSha, pull.headSha);
      view.additions = files.reduce((n, f) => n + f.additions, 0);
      view.deletions = files.reduce((n, f) => n + f.deletions, 0);
      view.changed_files = files.length;
    }
    return view;
  }

  private pullCommitCount(repo: Repository, base: string, head: string): number {
    const excluded = repo.ancestors(base);
    let count = 0;
    for (const id of repo.ancestors(head)) if (!excluded.has(id)) count++;
    return count;
  }

  file(repo: Repository, change: FileChange): Record<string, unknown> {
    return {
      sha: change.sha,
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: `${this.web}/${repo.fullName}/blob/${change.sha}/${change.filename}`,
      raw_url: `${this.web}/${repo.fullName}/raw/${change.sha}/${change.filename}`,
      contents_url: `${this.api}/repos/${repo.fullName}/contents/${change.filename}`,
    };
  }

  private person(sig: Signature): Record<string, unknown> {
    return { name: sig.name, email: sig.email, date: new Date(sig.seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  /** The git-data commit shape (GET /git/commits/{sha}, and the inner `commit` of a REST commit). */
  gitCommit(repo: Repository, sha: string, commit: Commit): Record<string, unknown> {
    return {
      sha,
      node_id: nodeId('Commit', sha),
      url: `${this.api}/repos/${repo.fullName}/git/commits/${sha}`,
      author: this.person(commit.author),
      committer: this.person(commit.committer),
      message: commit.message.replace(/\n+$/, ''),
      tree: { sha: commit.tree, url: `${this.api}/repos/${repo.fullName}/git/trees/${commit.tree}` },
      parents: commit.parents.map((p) => ({ sha: p, url: `${this.api}/repos/${repo.fullName}/git/commits/${p}` })),
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    };
  }

  commit(repo: Repository, sha: string, commit: Commit, files?: FileChange[]): Record<string, unknown> {
    const inner = this.gitCommit(repo, sha, commit);
    delete inner.sha;
    delete inner.node_id;
    delete inner.parents;
    const view: Record<string, unknown> = {
      sha,
      node_id: nodeId('Commit', sha),
      commit: { ...inner, comment_count: 0 },
      url: `${this.api}/repos/${repo.fullName}/commits/${sha}`,
      html_url: `${this.web}/${repo.fullName}/commit/${sha}`,
      author: commit.author.email === repo.owner.email ? this.user(repo.owner) : null,
      committer: commit.committer.email === repo.owner.email ? this.user(repo.owner) : null,
      parents: commit.parents.map((p) => ({ sha: p, url: `${this.api}/repos/${repo.fullName}/commits/${p}`, html_url: `${this.web}/${repo.fullName}/commit/${p}` })),
    };
    if (files) {
      const additions = files.reduce((n, f) => n + f.additions, 0);
      const deletions = files.reduce((n, f) => n + f.deletions, 0);
      view.stats = { total: additions + deletions, additions, deletions };
      view.files = files.map((f) => this.file(repo, f));
    }
    return view;
  }

  /** A contents entry; `content` adds the base64 body (single-file reads). */
  content(repo: Repository, path: string, sha: string, type: 'file' | 'dir' | 'submodule' | 'symlink', size: number, ref: string, content?: Buffer): Record<string, unknown> {
    const url = `${this.api}/repos/${repo.fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    const view: Record<string, unknown> = {
      type,
      name: path.split('/').pop() ?? path,
      path,
      sha,
      size,
      url,
      html_url: `${this.web}/${repo.fullName}/${type === 'dir' ? 'tree' : 'blob'}/${ref}/${path}`,
      git_url: `${this.api}/repos/${repo.fullName}/git/${type === 'dir' ? 'trees' : 'blobs'}/${sha}`,
      download_url: type === 'file' ? `${this.web}/${repo.fullName}/raw/${ref}/${path}` : null,
    };
    if (content) {
      view.encoding = 'base64';
      view.content = (content.toString('base64').match(/.{1,60}/g) ?? ['']).join('\n') + (content.length ? '\n' : '');
    }
    view._links = { self: url, git: view.git_url, html: view.html_url };
    return view;
  }
}
