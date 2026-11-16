// Opaque global (Relay) node ids, in GitHub's "<prefix>_<payload>" style. The same id is the REST
// node_id and the GraphQL id of an object, and it decodes back to its kind and database id.

const PREFIX: Record<string, string> = {
  User: 'U',
  Repository: 'R',
  Issue: 'I',
  PullRequest: 'PR',
  IssueComment: 'IC',
  Label: 'LA',
  Ref: 'REF',
  Commit: 'C',
};
const KIND = Object.fromEntries(Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind]));

export function globalId(kind: string, id: number | string): string {
  const prefix = PREFIX[kind] ?? 'N';
  return `${prefix}_kw${Buffer.from(`${kind}:${id}`).toString('base64url')}`;
}

export function parseGlobalId(value: unknown): { kind: string; id: string } | null {
  if (typeof value !== 'string') return null;
  const m = /^([A-Z]+)_kw([A-Za-z0-9_-]+)$/.exec(value);
  if (!m) return null;
  const decoded = Buffer.from(m[2], 'base64url').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  const kind = decoded.slice(0, colon);
  if (KIND[m[1]] !== kind) return null;
  return { kind, id: decoded.slice(colon + 1) };
}
