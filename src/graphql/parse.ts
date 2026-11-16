// A GraphQL executable-document parser (October 2021 spec, minus type-system definitions): operations,
// fragments, selections, arguments, variables, directives and every literal form.

export type Value =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int' | 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: Value[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: Value }> };

export interface Directive {
  name: string;
  args: Map<string, Value>;
}

export type Selection =
  | { kind: 'Field'; alias: string | null; name: string; args: Map<string, Value>; directives: Directive[]; selections: Selection[] | null; line: number; column: number }
  | { kind: 'FragmentSpread'; name: string; directives: Directive[] }
  | { kind: 'InlineFragment'; typeCondition: string | null; directives: Directive[]; selections: Selection[] };

export interface VariableDefinition {
  name: string;
  type: string;
  defaultValue: Value | null;
}

export interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinition[];
  selections: Selection[];
}

export interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

export class GraphQLSyntaxError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`Syntax Error: ${message}`);
    this.line = line;
    this.column = column;
  }
}

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  value: string;
  line: number;
  column: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const at = (): { line: number; column: number } => ({ line, column: i - lineStart + 1 });
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { i++; line++; lineStart = i; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const pos = at();
    if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...', ...pos }); i += 3; continue; }
    if ('!$&()[]{}:=@|'.includes(c)) { tokens.push({ kind: 'punct', value: c, ...pos }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j), ...pos });
      i = j;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!m) throw new GraphQLSyntaxError(`Invalid number, unexpected character ${JSON.stringify(c)}.`, pos.line, pos.column);
      tokens.push({ kind: m[2] || m[3] ? 'float' : 'int', value: m[0], ...pos });
      i += m[0].length;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end < 0) throw new GraphQLSyntaxError('Unterminated string.', pos.line, pos.column);
      const raw = source.slice(i + 3, end).replace(/\\"""/g, '"""');
      for (const ch of raw) if (ch === '\n') line++;
      tokens.push({ kind: 'string', value: blockString(raw), ...pos });
      i = end + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= source.length || source[j] === '\n') throw new GraphQLSyntaxError('Unterminated string.', pos.line, pos.column);
        const ch = source[j];
        if (ch === '"') break;
        if (ch === '\\') {
          const e = source[j + 1];
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e in simple) { out += simple[e]; j += 2; continue; }
          if (e === 'u') {
            const hex = /^[0-9a-fA-F]{4}/.exec(source.slice(j + 2));
            if (!hex) throw new GraphQLSyntaxError('Invalid Unicode escape sequence.', line, j - lineStart + 1);
            out += String.fromCharCode(parseInt(hex[0], 16));
            j += 6;
            continue;
          }
          throw new GraphQLSyntaxError(`Invalid character escape sequence: \\${e}.`, line, j - lineStart + 1);
        }
        out += ch;
        j++;
      }
      tokens.push({ kind: 'string', value: out, ...pos });
      i = j + 1;
      continue;
    }
    throw new GraphQLSyntaxError(`Unexpected character: ${JSON.stringify(c)}.`, pos.line, pos.column);
  }
  tokens.push({ kind: 'eof', value: '<EOF>', line, column: i - lineStart + 1 });
  return tokens;
}

function blockString(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let common: number | null = null;
  for (const l of lines.slice(1)) {
    const indent = l.length - l.trimStart().length;
    if (indent < l.length && (common === null || indent < common)) common = indent;
  }
  const out = lines.map((l, idx) => (idx === 0 || common === null ? l : l.slice(common)));
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private is(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new GraphQLSyntaxError(`Expected "${value}", found ${describe(t)}.`, t.line, t.column);
    return t;
  }

  private name(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new GraphQLSyntaxError(`Expected Name, found ${describe(t)}.`, t.line, t.column);
    return t.value;
  }

  document(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (this.is('{')) {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.selectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        this.next();
        const name = this.peek().kind === 'name' ? this.name() : null;
        const variables = this.is('(') ? this.variableDefinitions() : [];
        this.directives();
        operations.push({ kind: t.value, name, variables, selections: this.selectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.name();
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new GraphQLSyntaxError(`Expected "on", found ${describe(on)}.`, on.line, on.column);
        const typeCondition = this.name();
        this.directives();
        fragments.set(name, { name, typeCondition, selections: this.selectionSet() });
      } else {
        throw new GraphQLSyntaxError(`Unexpected ${describe(t)}.`, t.line, t.column);
      }
    }
    return { operations, fragments };
  }

  private variableDefinitions(): VariableDefinition[] {
    this.expect('(');
    const defs: VariableDefinition[] = [];
    while (!this.is(')')) {
      this.expect('$');
      const name = this.name();
      this.expect(':');
      const type = this.typeRef();
      const defaultValue = this.is('=') ? (this.next(), this.value(true)) : null;
      this.directives();
      defs.push({ name, type, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  private typeRef(): string {
    let type: string;
    if (this.is('[')) {
      this.next();
      type = `[${this.typeRef()}]`;
      this.expect(']');
    } else {
      type = this.name();
    }
    if (this.is('!')) { this.next(); type += '!'; }
    return type;
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.is('}')) {
      if (this.peek().kind === 'eof') { const t = this.peek(); throw new GraphQLSyntaxError('Expected Name, found <EOF>.', t.line, t.column); }
      selections.push(this.selection());
    }
    this.expect('}');
    return selections;
  }

  private selection(): Selection {
    if (this.is('...')) {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value !== 'on') {
        const name = this.name();
        return { kind: 'FragmentSpread', name, directives: this.directives() };
      }
      let typeCondition: string | null = null;
      if (t.kind === 'name' && t.value === 'on') { this.next(); typeCondition = this.name(); }
      const directives = this.directives();
      return { kind: 'InlineFragment', typeCondition, directives, selections: this.selectionSet() };
    }
    const start = this.peek();
    let name = this.name();
    let alias: string | null = null;
    if (this.is(':')) { this.next(); alias = name; name = this.name(); }
    const args = this.is('(') ? this.arguments(false) : new Map<string, Value>();
    const directives = this.directives();
    const selections = this.is('{') ? this.selectionSet() : null;
    return { kind: 'Field', alias, name, args, directives, selections, line: start.line, column: start.column };
  }

  private arguments(constant: boolean): Map<string, Value> {
    this.expect('(');
    const args = new Map<string, Value>();
    while (!this.is(')')) {
      const name = this.name();
      this.expect(':');
      args.set(name, this.value(constant));
    }
    this.expect(')');
    return args;
  }

  private directives(): Directive[] {
    const out: Directive[] = [];
    while (this.is('@')) {
      this.next();
      const name = this.name();
      out.push({ name, args: this.is('(') ? this.arguments(false) : new Map() });
    }
    return out;
  }

  private value(constant: boolean): Value {
    const t = this.next();
    if (t.kind === 'punct') {
      if (t.value === '$' && !constant) return { kind: 'Variable', name: this.name() };
      if (t.value === '[') {
        const values: Value[] = [];
        while (!this.is(']')) values.push(this.value(constant));
        this.next();
        return { kind: 'List', values };
      }
      if (t.value === '{') {
        const fields: Array<{ name: string; value: Value }> = [];
        while (!this.is('}')) {
          const name = this.name();
          this.expect(':');
          fields.push({ name, value: this.value(constant) });
        }
        this.next();
        return { kind: 'Object', fields };
      }
    }
    if (t.kind === 'int') return { kind: 'Int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'Float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'String', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true' || t.value === 'false') return { kind: 'Boolean', value: t.value === 'true' };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    throw new GraphQLSyntaxError(`Unexpected ${describe(t)}.`, t.line, t.column);
  }
}

function describe(t: Token): string {
  if (t.kind === 'eof') return '<EOF>';
  if (t.kind === 'punct') return `"${t.value}"`;
  if (t.kind === 'name') return `Name "${t.value}"`;
  return `${t.kind} ${JSON.stringify(t.value)}`;
}

export function parse(source: string): Document {
  return new Parser(source).document();
}

/** Resolve a literal against the request's variables into a plain JS value. */
export function valueToJs(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'Variable': return variables[value.name] ?? null;
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
    case 'Enum': return value.value;
    case 'Null': return null;
    case 'List': return value.values.map((v) => valueToJs(v, variables));
    case 'Object': return Object.fromEntries(value.fields.map((f) => [f.name, valueToJs(f.value, variables)]));
  }
}
