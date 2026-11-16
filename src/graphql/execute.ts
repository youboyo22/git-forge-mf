// A GraphQL executor over a code-first schema: validates the document against the schema (unknown
// fields and arguments are reported the way GitHub words them, with no data), then resolves fields
// depth-first with null propagation and per-field errors. Introspection (__type, __schema,
// __typename) is answered from the same schema.

import { parse, valueToJs, GraphQLSyntaxError, type Document, type Fragment, type Operation, type Selection } from './parse.ts';

export interface FieldDef {
  type: string;
  args?: Record<string, string>;
  description?: string;
  resolve?: (source: any, args: Record<string, any>, ctx: any) => unknown;
}

export type TypeDef =
  | { kind: 'OBJECT'; name: string; description?: string; interfaces?: string[]; fields: Record<string, FieldDef> }
  | { kind: 'INTERFACE'; name: string; description?: string; fields: Record<string, FieldDef> }
  | { kind: 'UNION'; name: string; description?: string; types: string[] }
  | { kind: 'ENUM'; name: string; description?: string; values: string[] }
  | { kind: 'INPUT_OBJECT'; name: string; description?: string; inputFields: Record<string, string> }
  | { kind: 'SCALAR'; name: string; description?: string };

export interface Schema {
  types: Map<string, TypeDef>;
  query: string;
  mutation: string;
}

export class GraphQLError extends Error {
  readonly type: string;
  constructor(message: string, type = 'UNPROCESSABLE') {
    super(message);
    this.type = type;
  }
}

interface ErrorEntry {
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
  type?: string;
  extensions?: Record<string, unknown>;
}

export interface ExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: ErrorEntry[];
}

/** Named type of a type reference: "[Issue!]!" -> "Issue". */
function namedType(ref: string): string {
  return ref.replace(/[[\]!]/g, '');
}

export function typenameOf(value: any): string | undefined {
  return value && typeof value === 'object' && typeof value.__typename === 'string' ? value.__typename : undefined;
}

export class Executor {
  private readonly schema: Schema;

  constructor(schema: Schema) {
    this.schema = schema;
  }

  run(query: unknown, variables: unknown, operationName: unknown, ctx: unknown): ExecutionResult {
    if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    let doc: Document;
    try {
      doc = parse(query);
    } catch (err) {
      if (err instanceof GraphQLSyntaxError) {
        return { errors: [{ message: `Parse error on ${err.message.replace(/^Syntax Error: /, '')}`, locations: [{ line: err.line, column: err.column }] }] };
      }
      throw err;
    }
    const named = typeof operationName === 'string' && operationName !== '' ? operationName : null;
    const op = named ? doc.operations.find((o) => o.name === named) : doc.operations.length === 1 ? doc.operations[0] : undefined;
    if (!op) {
      return { errors: [{ message: named ? `Unknown operation named "${named}".` : 'An operation name is required when the document holds several operations.' }] };
    }
    if (op.kind === 'subscription') return { errors: [{ message: 'Subscriptions are not supported' }] };

    const vars: Record<string, unknown> = { ...((variables && typeof variables === 'object' && !Array.isArray(variables)) ? (variables as Record<string, unknown>) : {}) };
    const errors: ErrorEntry[] = [];
    for (const def of op.variables) {
      if (vars[def.name] === undefined && def.defaultValue) vars[def.name] = valueToJs(def.defaultValue, {});
      if ((vars[def.name] === undefined || vars[def.name] === null) && def.type.endsWith('!')) {
        errors.push({ message: `Variable $${def.name} of type ${def.type} was provided invalid value`, extensions: { code: 'variableMismatch' } });
      }
    }
    const rootName = op.kind === 'mutation' ? this.schema.mutation : this.schema.query;
    this.validate(op.selections, rootName, doc.fragments, [op.kind === 'mutation' ? 'mutation' : 'query'], errors, new Set());
    if (errors.length) return { errors };

    const state = { vars, ctx, fragments: doc.fragments, errors: [] as ErrorEntry[] };
    const data = this.executeSelections(op.selections, rootName, {}, [], state);
    return state.errors.length ? { data, errors: state.errors } : { data };
  }

  // ---------------------------------------------------------------------------------------- validation

  private fieldsOf(typeName: string): Record<string, FieldDef> | null {
    const type = this.schema.types.get(typeName);
    if (!type) return null;
    if (type.kind === 'OBJECT' || type.kind === 'INTERFACE') return type.fields;
    return null;
  }

  private validate(selections: Selection[], typeName: string, fragments: Map<string, Fragment>, path: string[], errors: ErrorEntry[], seen: Set<string>): void {
    const type = this.schema.types.get(typeName);
    for (const sel of selections) {
      if (sel.kind === 'FragmentSpread') {
        const fragment = fragments.get(sel.name);
        if (!fragment) { errors.push({ message: `Fragment ${sel.name} was used, but not defined`, extensions: { code: 'useAndDefineFragment', fragmentName: sel.name } }); continue; }
        if (seen.has(sel.name)) continue;
        this.validate(fragment.selections, fragment.typeCondition, fragments, [...path, `... ${sel.name}`], errors, new Set([...seen, sel.name]));
        continue;
      }
      if (sel.kind === 'InlineFragment') {
        const cond = sel.typeCondition ?? typeName;
        if (!this.schema.types.has(cond)) { errors.push({ message: `No such type ${cond}, so it can't be a fragment condition`, extensions: { code: 'undefinedType', typeName: cond } }); continue; }
        this.validate(sel.selections, cond, fragments, [...path, `... on ${cond}`], errors, seen);
        continue;
      }
      if (sel.name === '__typename') continue;
      const loc = [{ line: sel.line, column: sel.column }];
      const fieldPath = [...path, sel.alias ?? sel.name];
      let def: FieldDef | undefined;
      if (sel.name === '__type' || sel.name === '__schema') {
        def = typeName === this.schema.query ? INTROSPECTION_ROOT[sel.name] : undefined;
      } else {
        def = this.fieldsOf(typeName)?.[sel.name];
      }
      if (!def) {
        const owner = type?.kind === 'UNION' ? `${typeName} (a union; select fields through an inline fragment)` : typeName;
        errors.push({
          message: `Field '${sel.name}' doesn't exist on type '${owner}'`,
          locations: loc,
          path: fieldPath,
          extensions: { code: 'undefinedField', typeName, fieldName: sel.name },
        });
        continue;
      }
      for (const arg of sel.args.keys()) {
        if (!def.args || !(arg in def.args)) {
          errors.push({
            message: `Field '${sel.name}' doesn't accept argument '${arg}'`,
            locations: loc,
            path: [...fieldPath, arg],
            extensions: { code: 'argumentNotAccepted', name: sel.name, typeName: 'Field', argumentName: arg },
          });
        }
      }
      for (const [arg, argType] of Object.entries(def.args ?? {})) {
        if (argType.endsWith('!') && !sel.args.has(arg)) {
          errors.push({
            message: `Field '${sel.name}' is missing required arguments: ${arg}`,
            locations: loc,
            path: fieldPath,
            extensions: { code: 'missingRequiredArguments', className: 'Field', name: sel.name, arguments: arg },
          });
        }
      }
      const inner = namedType(def.type);
      const innerKind = this.schema.types.get(inner)?.kind ?? INTROSPECTION_TYPES[inner]?.kind;
      const composite = innerKind === 'OBJECT' || innerKind === 'INTERFACE' || innerKind === 'UNION';
      if (composite && !sel.selections) {
        errors.push({ message: `Field must have selections (field '${sel.name}' returns ${inner} but has no selections. Did you mean '${sel.name} { ... }'?)`, locations: loc, path: fieldPath, extensions: { code: 'selectionMismatch', nodeName: `field '${sel.name}'`, typeName: inner } });
      } else if (!composite && sel.selections) {
        errors.push({ message: `Selections can't be made on scalars (field '${sel.name}' returns ${inner} but has selections [${sel.selections.map((s) => (s.kind === 'Field' ? s.name : '...')).join(', ')}])`, locations: loc, path: fieldPath, extensions: { code: 'selectionMismatch', nodeName: `field '${sel.name}'`, typeName: inner } });
      } else if (composite && sel.selections && !INTROSPECTION_TYPES[inner]) {
        this.validate(sel.selections, inner, fragments, fieldPath, errors, seen);
      }
    }
  }

  // ---------------------------------------------------------------------------------------- execution

  private applies(condition: string | null, concrete: string): boolean {
    if (condition === null || condition === concrete) return true;
    const type = this.schema.types.get(condition);
    if (type?.kind === 'INTERFACE') {
      const obj = this.schema.types.get(concrete);
      return obj?.kind === 'OBJECT' && (obj.interfaces ?? []).includes(condition);
    }
    if (type?.kind === 'UNION') return type.types.includes(concrete);
    return false;
  }

  private skipped(directives: Array<{ name: string; args: Map<string, any> }>, vars: Record<string, unknown>): boolean {
    for (const d of directives) {
      const cond = d.args.get('if');
      const value = cond ? valueToJs(cond, vars) : undefined;
      if (d.name === 'skip' && value === true) return true;
      if (d.name === 'include' && value === false) return true;
    }
    return false;
  }

  /** Group fields by response key, expanding fragments that apply to `concrete`. */
  private collect(selections: Selection[], concrete: string, state: State, out = new Map<string, Array<Selection & { kind: 'Field' }>>(), visited = new Set<string>()): Map<string, Array<Selection & { kind: 'Field' }>> {
    for (const sel of selections) {
      if (this.skipped(sel.directives, state.vars)) continue;
      if (sel.kind === 'Field') {
        const key = sel.alias ?? sel.name;
        const list = out.get(key);
        if (list) list.push(sel);
        else out.set(key, [sel]);
      } else if (sel.kind === 'InlineFragment') {
        if (this.applies(sel.typeCondition, concrete)) this.collect(sel.selections, concrete, state, out, visited);
      } else {
        if (visited.has(sel.name)) continue;
        visited.add(sel.name);
        const fragment = state.fragments.get(sel.name);
        if (fragment && this.applies(fragment.typeCondition, concrete)) this.collect(fragment.selections, concrete, state, out, visited);
      }
    }
    return out;
  }

  private executeSelections(selections: Selection[], typeName: string, source: any, path: Array<string | number>, state: State): Record<string, unknown> | null {
    const result: Record<string, unknown> = {};
    for (const [key, fields] of this.collect(selections, typeName, state)) {
      const field = fields[0];
      const fieldPath = [...path, key];
      if (field.name === '__typename') { result[key] = typeName; continue; }
      const def = field.name === '__type' || field.name === '__schema' ? INTROSPECTION_ROOT[field.name] : this.fieldsOf(typeName)?.[field.name];
      if (!def) { result[key] = null; continue; }
      const args: Record<string, any> = {};
      for (const [name, value] of field.args) args[name] = valueToJs(value, state.vars);
      let value: unknown;
      try {
        value = def.resolve ? def.resolve(source, args, field.name.startsWith('__') ? { schema: this.schema, user: state.ctx } : state.ctx) : source?.[field.name];
      } catch (err) {
        if (!(err instanceof GraphQLError)) throw err;
        state.errors.push({ type: err.type, path: fieldPath, locations: [{ line: field.line, column: field.column }], message: err.message });
        value = null;
      }
      const subSelections = fields.flatMap((f) => f.selections ?? []);
      const completed = this.complete(def.type, value, subSelections, fieldPath, state);
      if (completed === null && def.type.endsWith('!')) return null; // propagate to the parent
      result[key] = completed;
    }
    return result;
  }

  private complete(type: string, value: unknown, selections: Selection[], path: Array<string | number>, state: State): unknown {
    if (type.endsWith('!')) {
      const inner = this.complete(type.slice(0, -1), value, selections, path, state);
      if (inner === null && value !== null && value !== undefined) return null;
      if (inner === null) state.errors.push({ message: `Cannot return null for non-nullable field ${path[path.length - 1]}`, path });
      return inner;
    }
    if (value === null || value === undefined) return null;
    if (type.startsWith('[')) {
      if (!Array.isArray(value)) return null;
      const inner = type.slice(1, -1);
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = this.complete(inner, value[i], selections, [...path, i], state);
        if (item === null && inner.endsWith('!')) return null;
        out.push(item);
      }
      return out;
    }
    const introspective = INTROSPECTION_TYPES[type];
    if (introspective) return this.executeIntrospective(type, value, selections, path, state);
    const def = this.schema.types.get(type);
    if (!def || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
    if (def.kind === 'INPUT_OBJECT') return null;
    const concrete = def.kind === 'OBJECT' ? type : typenameOf(value);
    if (!concrete) return null;
    return this.executeSelections(selections, concrete, value, path, state);
  }

  private executeIntrospective(type: string, value: any, selections: Selection[], path: Array<string | number>, state: State): unknown {
    const fields = INTROSPECTION_TYPES[type].fields;
    const result: Record<string, unknown> = {};
    for (const [key, list] of this.collect(selections, type, state)) {
      const field = list[0];
      if (field.name === '__typename') { result[key] = type; continue; }
      const def = fields[field.name];
      if (!def) { result[key] = null; continue; }
      const args: Record<string, any> = {};
      for (const [name, v] of field.args) args[name] = valueToJs(v, state.vars);
      const raw = def.resolve ? def.resolve(value, args, { schema: this.schema }) : value[field.name];
      result[key] = this.complete(def.type, raw, list.flatMap((f) => f.selections ?? []), [...path, key], state);
    }
    return result;
  }
}

interface State {
  vars: Record<string, unknown>;
  ctx: unknown;
  fragments: Map<string, Fragment>;
  errors: ErrorEntry[];
}

// ------------------------------------------------------------------------------------------------ introspection

interface TypeRefView { kind: string; name: string | null; ofType: TypeRefView | null; def?: TypeDef | null }

function typeRef(ref: string, schema: Schema): TypeRefView {
  if (ref.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(ref.slice(0, -1), schema) };
  if (ref.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(ref.slice(1, -1), schema) };
  const def = schema.types.get(ref) ?? null;
  return { kind: def?.kind ?? 'SCALAR', name: ref, ofType: null, def };
}

function typeView(def: TypeDef, schema: Schema): TypeRefView {
  return { kind: def.kind, name: def.name, ofType: null, def };
}

const deprecation = { isDeprecated: false, deprecationReason: null };

const INTROSPECTION_TYPES: Record<string, { kind: 'OBJECT'; fields: Record<string, FieldDef> }> = {
  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: { type: 'String', resolve: () => null },
      types: { type: '[__Type!]!', resolve: (_s, _a, { schema }) => [...schema.types.values()].map((d: TypeDef) => typeView(d, schema)) },
      queryType: { type: '__Type!', resolve: (_s, _a, { schema }) => typeView(schema.types.get(schema.query), schema) },
      mutationType: { type: '__Type', resolve: (_s, _a, { schema }) => typeView(schema.types.get(schema.mutation), schema) },
      subscriptionType: { type: '__Type', resolve: () => null },
      directives: {
        type: '[__Directive!]!',
        resolve: () => ['include', 'skip'].map((name) => ({ name, description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: 'Boolean!', defaultValue: null }], isRepeatable: false })),
      },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: 'String!' },
      name: { type: 'String' },
      description: { type: 'String', resolve: (t: TypeRefView) => t.def?.description ?? null },
      specifiedByURL: { type: 'String', resolve: () => null },
      fields: {
        type: '[__Field!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (t: TypeRefView) => (t.def && (t.def.kind === 'OBJECT' || t.def.kind === 'INTERFACE') ? Object.entries(t.def.fields).map(([name, f]) => ({ name, def: f })) : null),
      },
      interfaces: { type: '[__Type!]', resolve: (t: TypeRefView, _a, { schema }) => (t.def?.kind === 'OBJECT' ? (t.def.interfaces ?? []).map((n) => typeRef(n, schema)) : t.def?.kind === 'INTERFACE' ? [] : null) },
      possibleTypes: {
        type: '[__Type!]',
        resolve: (t: TypeRefView, _a, { schema }) => {
          if (t.def?.kind === 'UNION') return t.def.types.map((n) => typeRef(n, schema));
          if (t.def?.kind === 'INTERFACE') return [...schema.types.values()].filter((d: TypeDef) => d.kind === 'OBJECT' && (d.interfaces ?? []).includes(t.name!)).map((d: TypeDef) => typeView(d, schema));
          return null;
        },
      },
      enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' }, resolve: (t: TypeRefView) => (t.def?.kind === 'ENUM' ? t.def.values.map((name) => ({ name, description: null, ...deprecation })) : null) },
      inputFields: {
        type: '[__InputValue!]',
        args: { includeDeprecated: 'Boolean' },
        resolve: (t: TypeRefView) => (t.def?.kind === 'INPUT_OBJECT' ? Object.entries(t.def.inputFields).map(([name, type]) => ({ name, description: null, type, defaultValue: null, ...deprecation })) : null),
      },
      ofType: { type: '__Type' },
      isOneOf: { type: 'Boolean', resolve: (t: TypeRefView) => (t.def?.kind === 'INPUT_OBJECT' ? false : null) },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String', resolve: (f) => f.def.description ?? null },
      args: { type: '[__InputValue!]!', args: { includeDeprecated: 'Boolean' }, resolve: (f) => Object.entries(f.def.args ?? {}).map(([name, type]) => ({ name, description: null, type, defaultValue: null, ...deprecation })) },
      type: { type: '__Type!', resolve: (f, _a, { schema }) => typeRef(f.def.type, schema) },
      isDeprecated: { type: 'Boolean!', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!', resolve: (v, _a, { schema }) => typeRef(v.type, schema) },
      defaultValue: { type: 'String' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      locations: { type: '[String!]!' },
      args: { type: '[__InputValue!]!' },
      isRepeatable: { type: 'Boolean!' },
    },
  },
};

const INTROSPECTION_ROOT: Record<string, FieldDef> = {
  __type: {
    type: '__Type',
    args: { name: 'String!' },
    resolve: (_s, args, { schema }) => {
      const def = schema.types.get(args.name);
      return def ? typeView(def, schema) : null;
    },
  },
  __schema: { type: '__Schema!', resolve: () => ({}) },
};
