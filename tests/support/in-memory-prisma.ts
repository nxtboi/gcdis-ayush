import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * In-memory stand-in for PrismaClient, driven by the generated Prisma DMMF, for HTTP-level tests that boot the
 * real Nest application. Supports the query surface the API uses: findUnique / findFirst / findMany / count /
 * create / createMany / update / updateMany / upsert / delete / deleteMany / aggregate / groupBy with
 * where-filters (scalar operators, AND / OR / NOT, relation filters some / every / none / is / isNot),
 * include / select (nested, with where / orderBy / take / skip, and _count), orderBy, take / skip and nested
 * create / connect writes. Unique (@id, @unique, @@unique) constraints raise P2002, missing rows P2025.
 *
 * Raw SQL ($executeRaw / $queryRaw and the Unsafe variants) is a no-op returning 0 / []; transactions run on the
 * same store (no rollback). Nothing here talks to a database.
 */

type Row = Record<string, any>;
type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

const MODELS: readonly DmmfModel[] = Prisma.dmmf.datamodel.models;
const MODEL_BY_NAME = new Map<string, DmmfModel>(MODELS.map((m) => [m.name, m]));

export const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

function knownError(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'in-memory', meta });
}

function cloneValue(v: any): any {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Date) return new Date(v.getTime());
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(cloneValue);
  if (typeof v === 'object') {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) out[k] = cloneValue(val);
    return out;
  }
  return v;
}

function cmpKey(v: any): any {
  if (v instanceof Date) return v.getTime();
  return v;
}

function eq(a: any, b: any): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return cmpKey(a) === cmpKey(b);
}

function compare(a: any, b: any): number {
  const x = cmpKey(a);
  const y = cmpKey(b);
  if (x === y) return 0;
  if (x === null || x === undefined) return 1;
  if (y === null || y === undefined) return -1;
  return x < y ? -1 : 1;
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

interface RelationInfo {
  target: DmmfModel;
  many: boolean;
  /** Field names on the source row ... */
  local: string[];
  /** ... equal to these field names on the target row. */
  remote: string[];
}

export class InMemoryPrisma {
  readonly tables = new Map<string, Row[]>();
  private autoinc = 0;
  isConnected = true;
  /** Every delegate call, for assertions that something was (not) written. */
  readonly calls: Array<{ model: string; op: string; args: any }> = [];

  constructor() {
    for (const model of MODELS) {
      this.tables.set(model.name, []);
      (this as any)[delegateName(model.name)] = this.delegate(model);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Client-level API

  reset(seed: Record<string, Row[]> = {}): void {
    for (const model of MODELS) this.tables.set(model.name, []);
    this.calls.length = 0;
    for (const [model, rows] of Object.entries(seed)) {
      const m = MODEL_BY_NAME.get(model);
      if (!m) throw new Error(`Unknown model ${model}`);
      for (const r of rows) this.tables.get(model)!.push(this.buildRow(m, cloneValue(r), true));
    }
  }

  rows(model: string): Row[] {
    return this.tables.get(model) ?? [];
  }

  $connect = async () => undefined;
  $disconnect = async () => undefined;
  $on = () => undefined;
  $use = () => undefined;
  $executeRaw = async (..._args: any[]) => 0;
  $executeRawUnsafe = async (..._args: any[]) => 0;
  $queryRaw = async (..._args: any[]) => [] as any[];
  $queryRawUnsafe = async (..._args: any[]) => [] as any[];

  $transaction = async (arg: any, _opts?: any): Promise<any> => {
    if (typeof arg === 'function') return arg(this);
    const out: any[] = [];
    for (const p of asArray(arg)) out.push(await p);
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------
  // Relations

  private relationInfo(model: DmmfModel, field: DmmfField): RelationInfo {
    const target = MODEL_BY_NAME.get(field.type)!;
    if (field.relationFromFields && field.relationFromFields.length > 0) {
      return { target, many: false, local: [...field.relationFromFields], remote: [...(field.relationToFields as string[])] };
    }
    const opposite = target.fields.find(
      (f) => f.kind === 'object' && f.relationName === field.relationName && !(target.name === model.name && f.name === field.name)
    );
    if (!opposite || !opposite.relationFromFields) throw new Error(`Cannot resolve relation ${model.name}.${field.name}`);
    return {
      target,
      many: !!field.isList,
      local: [...(opposite.relationToFields as string[])],
      remote: [...opposite.relationFromFields]
    };
  }

  private related(model: DmmfModel, row: Row, field: DmmfField): Row[] {
    const rel = this.relationInfo(model, field);
    if (rel.local.some((k) => row[k] === null || row[k] === undefined)) return [];
    return this.rows(rel.target.name).filter((t) => rel.local.every((k, i) => eq(row[k], t[rel.remote[i]])));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Filtering

  matches(model: DmmfModel, row: Row, where: any): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === 'AND') {
        if (!asArray(cond).every((w) => this.matches(model, row, w))) return false;
        continue;
      }
      if (key === 'OR') {
        if (!asArray(cond).some((w) => this.matches(model, row, w))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (asArray(cond).some((w) => this.matches(model, row, w))) return false;
        continue;
      }
      const field = model.fields.find((f) => f.name === key);
      if (!field) {
        // Compound unique selector, e.g. { teamId_categoryId: { teamId, categoryId } }
        if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
          if (!Object.entries(cond).every(([k, v]) => eq(row[k], v))) return false;
          continue;
        }
        throw new Error(`Unknown field ${model.name}.${key} in where`);
      }
      if (field.kind === 'object') {
        if (!this.matchRelation(model, row, field, cond)) return false;
        continue;
      }
      if (!this.matchScalar(row[key], cond, field)) return false;
    }
    return true;
  }

  private matchRelation(model: DmmfModel, row: Row, field: DmmfField, cond: any): boolean {
    const rel = this.relationInfo(model, field);
    const related = this.related(model, row, field);
    if (rel.many) {
      if (cond.some !== undefined && !related.some((r) => this.matches(rel.target, r, cond.some))) return false;
      if (cond.every !== undefined && !related.every((r) => this.matches(rel.target, r, cond.every))) return false;
      if (cond.none !== undefined && related.some((r) => this.matches(rel.target, r, cond.none))) return false;
      return true;
    }
    const one = related[0] ?? null;
    if (cond === null) return one === null;
    if ('is' in cond || 'isNot' in cond) {
      if ('is' in cond) {
        if (cond.is === null ? one !== null : !one || !this.matches(rel.target, one, cond.is)) return false;
      }
      if ('isNot' in cond) {
        if (cond.isNot === null ? one === null : !!one && this.matches(rel.target, one, cond.isNot)) return false;
      }
      return true;
    }
    return !!one && this.matches(rel.target, one, cond);
  }

  private matchScalar(value: any, cond: any, field: DmmfField): boolean {
    if (cond === null) return value === null || value === undefined;
    if (typeof cond !== 'object' || cond instanceof Date || field.type === 'Json') {
      if (field.type === 'Json' && cond && typeof cond === 'object' && 'equals' in cond) return JSON.stringify(value) === JSON.stringify(cond.equals);
      return eq(value, cond);
    }
    const insensitive = cond.mode === 'insensitive';
    const norm = (v: any) => (insensitive && typeof v === 'string' ? v.toLowerCase() : v);
    for (const [op, arg] of Object.entries(cond)) {
      if (arg === undefined || op === 'mode') continue;
      const v = norm(value);
      switch (op) {
        case 'equals':
          if (!eq(v, norm(arg))) return false;
          break;
        case 'in':
          if (!(arg as any[]).some((a) => eq(v, norm(a)))) return false;
          break;
        case 'notIn':
          if ((arg as any[]).some((a) => eq(v, norm(a)))) return false;
          break;
        case 'lt':
          if (value === null || value === undefined || !(cmpKey(value) < cmpKey(arg))) return false;
          break;
        case 'lte':
          if (value === null || value === undefined || !(cmpKey(value) <= cmpKey(arg))) return false;
          break;
        case 'gt':
          if (value === null || value === undefined || !(cmpKey(value) > cmpKey(arg))) return false;
          break;
        case 'gte':
          if (value === null || value === undefined || !(cmpKey(value) >= cmpKey(arg))) return false;
          break;
        case 'not':
          if (arg !== null && typeof arg === 'object' && !(arg instanceof Date)) {
            if (this.matchScalar(value, arg, field)) return false;
          } else if (eq(value, arg)) return false;
          break;
        case 'contains':
          if (typeof v !== 'string' || !v.includes(norm(arg))) return false;
          break;
        case 'startsWith':
          if (typeof v !== 'string' || !v.startsWith(norm(arg))) return false;
          break;
        case 'endsWith':
          if (typeof v !== 'string' || !v.endsWith(norm(arg))) return false;
          break;
        case 'has':
          if (!Array.isArray(value) || !value.some((x) => eq(x, arg))) return false;
          break;
        default:
          throw new Error(`Unsupported filter operator '${op}' on ${field.name}`);
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Ordering / paging / projection

  private sortRows(model: DmmfModel, rows: Row[], orderBy: any): Row[] {
    const specs = asArray(orderBy).flatMap((o: any) => Object.entries(o || {}));
    if (specs.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const [key, dir] of specs) {
        const field = model.fields.find((f) => f.name === key);
        if (!field || field.kind === 'object') continue; // relation ordering is not modelled
        const d = typeof dir === 'object' ? (dir as any).sort : dir;
        const c = compare(a[key], b[key]);
        if (c !== 0) return d === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private page(rows: Row[], args: any): Row[] {
    const skip = Number(args?.skip) || 0;
    const take = args?.take === undefined ? undefined : Number(args.take);
    const sliced = rows.slice(skip);
    return take === undefined ? sliced : take < 0 ? sliced.slice(take) : sliced.slice(0, take);
  }

  private countRelations(model: DmmfModel, row: Row, spec: any): Record<string, number> {
    const out: Record<string, number> = {};
    const selected: Record<string, any> =
      spec === true
        ? Object.fromEntries(model.fields.filter((f) => f.kind === 'object' && f.isList).map((f) => [f.name, true]))
        : spec?.select ?? {};
    for (const [name, v] of Object.entries(selected)) {
      if (!v) continue;
      const field = model.fields.find((f) => f.name === name)!;
      const rel = this.relationInfo(model, field);
      let rows = this.related(model, row, field);
      if (v && typeof v === 'object' && v.where) rows = rows.filter((r) => this.matches(rel.target, r, v.where));
      out[name] = rows.length;
    }
    return out;
  }

  project(model: DmmfModel, row: Row, args: any): Row {
    const out: Row = {};
    if (args?.select) {
      for (const [key, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (key === '_count') {
          out._count = this.countRelations(model, row, v);
          continue;
        }
        const field = model.fields.find((f) => f.name === key);
        if (!field) throw new Error(`Unknown field ${model.name}.${key} in select`);
        out[key] = field.kind === 'object' ? this.resolveRelation(model, row, field, v) : cloneValue(row[key]);
      }
      return out;
    }
    for (const field of model.fields) if (field.kind !== 'object') out[field.name] = cloneValue(row[field.name]);
    if (args?.include) {
      for (const [key, v] of Object.entries(args.include)) {
        if (!v) continue;
        if (key === '_count') {
          out._count = this.countRelations(model, row, v);
          continue;
        }
        const field = model.fields.find((f) => f.name === key);
        if (!field || field.kind !== 'object') throw new Error(`Unknown relation ${model.name}.${key} in include`);
        out[key] = this.resolveRelation(model, row, field, v);
      }
    }
    return out;
  }

  private resolveRelation(model: DmmfModel, row: Row, field: DmmfField, spec: any): any {
    const rel = this.relationInfo(model, field);
    const sub = spec === true ? {} : spec;
    let rows = this.related(model, row, field);
    if (rel.many) {
      if (sub.where) rows = rows.filter((r) => this.matches(rel.target, r, sub.where));
      rows = this.page(this.sortRows(rel.target, rows, sub.orderBy), sub);
      return rows.map((r) => this.project(rel.target, r, sub));
    }
    return rows[0] ? this.project(rel.target, rows[0], sub) : null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Writes

  private defaultFor(field: DmmfField): any {
    const d: any = field.default;
    if (d !== undefined) {
      if (d && typeof d === 'object' && 'name' in d) {
        if (/^(uuid|cuid|ulid|nanoid)/.test(d.name)) return crypto.randomUUID();
        if (d.name === 'dbgenerated') return null;
        if (d.name === 'now') return new Date();
        if (d.name === 'autoincrement') return ++this.autoinc;
        return null;
      }
      return cloneValue(d);
    }
    if (field.isUpdatedAt) return new Date();
    if (field.isList) return [];
    return null;
  }

  private coerce(field: DmmfField, value: any): any {
    if (field.type === 'DateTime' && typeof value === 'string') return new Date(value);
    return cloneValue(value);
  }

  /** Builds a full row (defaults applied) from scalar data; relation writes are applied by the caller. */
  private buildRow(model: DmmfModel, data: Row, seeding = false): Row {
    const row: Row = {};
    for (const field of model.fields) {
      if (field.kind === 'object') continue;
      row[field.name] = data[field.name] !== undefined ? this.coerce(field, data[field.name]) : this.defaultFor(field);
    }
    if (seeding) {
      for (const field of model.fields) {
        if (field.kind === 'object' && data[field.name] !== undefined) {
          throw new Error(`Seed rows must use foreign keys, not relation ${model.name}.${field.name}`);
        }
      }
    }
    return row;
  }

  private assertUnique(model: DmmfModel, row: Row, ignore?: Row): void {
    const table = this.rows(model.name);
    const groups: string[][] = [
      ...model.fields.filter((f) => f.isId || f.isUnique).map((f) => [f.name]),
      ...((model as any).uniqueFields ?? []),
      ...(model.primaryKey ? [model.primaryKey.fields as string[]] : [])
    ];
    for (const group of groups) {
      if (group.some((k) => row[k] === null || row[k] === undefined)) continue;
      const clash = table.find((r) => r !== ignore && group.every((k) => eq(r[k], row[k])));
      if (clash) throw knownError('P2002', `Unique constraint failed on the fields: (${group.join(', ')})`, { target: group });
    }
  }

  private findUniqueRow(model: DmmfModel, where: any): Row | undefined {
    return this.rows(model.name).find((r) => this.matches(model, r, where));
  }

  private applyRelationWrites(model: DmmfModel, row: Row, data: Row, phase: 'before' | 'after'): void {
    for (const field of model.fields) {
      if (field.kind !== 'object' || data[field.name] === undefined) continue;
      const op = data[field.name];
      const rel = this.relationInfo(model, field);
      if (phase === 'before' && !rel.many && field.relationFromFields && field.relationFromFields.length > 0) {
        // This side holds the foreign key
        if (op.connect) {
          const target = this.findUniqueRow(rel.target, op.connect);
          if (!target) throw knownError('P2025', `Related ${rel.target.name} not found for connect`);
          rel.local.forEach((k, i) => (row[k] = target[rel.remote[i]]));
        }
        if (op.create) {
          const created = this.createOne(rel.target, op.create);
          rel.local.forEach((k, i) => (row[k] = created[rel.remote[i]]));
        }
        if (op.disconnect) rel.local.forEach((k) => (row[k] = null));
      }
      if (phase === 'after' && (rel.many || !(field.relationFromFields && field.relationFromFields.length > 0))) {
        const fk = (childData: Row) => {
          const out = { ...childData };
          rel.remote.forEach((k, i) => (out[k] = row[rel.local[i]]));
          return out;
        };
        for (const c of asArray(op.create)) this.createOne(rel.target, fk(c));
        if (op.createMany) for (const c of asArray(op.createMany.data)) this.createOne(rel.target, fk(c));
        for (const c of asArray(op.connect)) {
          const target = this.findUniqueRow(rel.target, c);
          if (!target) throw knownError('P2025', `Related ${rel.target.name} not found for connect`);
          rel.remote.forEach((k, i) => (target[k] = row[rel.local[i]]));
        }
        const children = () => this.related(model, row, field);
        for (const w of asArray(op.deleteMany)) {
          const doomed = new Set(children().filter((r) => this.matches(rel.target, r, w)));
          this.tables.set(rel.target.name, this.rows(rel.target.name).filter((r) => !doomed.has(r)));
        }
        for (const u of asArray(op.updateMany)) {
          for (const r of children().filter((x) => this.matches(rel.target, x, u.where))) this.applyData(rel.target, r, u.data);
        }
        if (!rel.many && op.update) {
          const child = children()[0];
          if (child) this.applyData(rel.target, child, op.update.data ?? op.update);
        }
      }
    }
  }

  private createOne(model: DmmfModel, data: Row): Row {
    const row = this.buildRow(model, data);
    this.applyRelationWrites(model, row, data, 'before');
    this.assertUnique(model, row);
    this.rows(model.name).push(row);
    this.applyRelationWrites(model, row, data, 'after');
    return row;
  }

  private applyData(model: DmmfModel, row: Row, data: Row): void {
    const next = { ...row };
    for (const [key, value] of Object.entries(data || {})) {
      if (value === undefined) continue;
      const field = model.fields.find((f) => f.name === key);
      if (!field) throw new Error(`Unknown field ${model.name}.${key} in data`);
      if (field.kind === 'object') continue;
      if (value !== null && typeof value === 'object' && !(value instanceof Date) && field.type !== 'Json' && !Array.isArray(value)) {
        const op: any = value;
        if ('set' in op) next[key] = this.coerce(field, op.set);
        if ('increment' in op) next[key] = (Number(next[key]) || 0) + op.increment;
        if ('decrement' in op) next[key] = (Number(next[key]) || 0) - op.decrement;
        if ('multiply' in op) next[key] = (Number(next[key]) || 0) * op.multiply;
        if ('divide' in op) next[key] = (Number(next[key]) || 0) / op.divide;
        if ('push' in op) next[key] = [...(next[key] || []), ...asArray(op.push)];
      } else {
        next[key] = this.coerce(field, value);
      }
    }
    for (const field of model.fields) if (field.isUpdatedAt && data?.[field.name] === undefined) next[field.name] = new Date();
    this.applyRelationWrites(model, next, data, 'before');
    this.assertUnique(model, next, row);
    Object.assign(row, next);
    this.applyRelationWrites(model, row, data, 'after');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Delegates

  private delegate(model: DmmfModel) {
    const self = this;
    const log = (op: string, args: any) => self.calls.push({ model: model.name, op, args });
    const filtered = (args: any) => self.rows(model.name).filter((r) => self.matches(model, r, args?.where));
    const findMany = (args: any = {}) => {
      let rows = self.sortRows(model, filtered(args), args.orderBy);
      if (args.distinct) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const k = JSON.stringify(asArray(args.distinct).map((d: string) => cmpKey(r[d])));
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      return self.page(rows, args).map((r) => self.project(model, r, args));
    };
    const findFirst = (args: any = {}) => findMany({ ...args, take: 1 })[0] ?? null;
    const notFound = () => knownError('P2025', `No ${model.name} found`);
    return {
      findUnique: async (args: any) => (log('findUnique', args), findFirst(args)),
      findUniqueOrThrow: async (args: any) => {
        log('findUniqueOrThrow', args);
        const r = findFirst(args);
        if (!r) throw notFound();
        return r;
      },
      findFirst: async (args: any = {}) => (log('findFirst', args), findFirst(args)),
      findFirstOrThrow: async (args: any = {}) => {
        log('findFirstOrThrow', args);
        const r = findFirst(args);
        if (!r) throw notFound();
        return r;
      },
      findMany: async (args: any = {}) => (log('findMany', args), findMany(args)),
      count: async (args: any = {}) => (log('count', args), self.page(filtered(args), args).length),
      create: async (args: any) => {
        log('create', args);
        const row = self.createOne(model, args.data);
        return self.project(model, row, args);
      },
      createMany: async (args: any) => {
        log('createMany', args);
        let count = 0;
        for (const d of asArray(args.data)) {
          try {
            self.createOne(model, d);
            count++;
          } catch (err) {
            if (!args.skipDuplicates) throw err;
          }
        }
        return { count };
      },
      update: async (args: any) => {
        log('update', args);
        const row = self.findUniqueRow(model, args.where);
        if (!row) throw notFound();
        self.applyData(model, row, args.data);
        return self.project(model, row, args);
      },
      updateMany: async (args: any = {}) => {
        log('updateMany', args);
        const rows = filtered(args);
        for (const r of rows) self.applyData(model, r, args.data);
        return { count: rows.length };
      },
      upsert: async (args: any) => {
        log('upsert', args);
        const row = self.findUniqueRow(model, args.where);
        if (row) {
          self.applyData(model, row, args.update);
          return self.project(model, row, args);
        }
        return self.project(model, self.createOne(model, args.create), args);
      },
      delete: async (args: any) => {
        log('delete', args);
        const row = self.findUniqueRow(model, args.where);
        if (!row) throw notFound();
        const projected = self.project(model, row, args);
        self.tables.set(model.name, self.rows(model.name).filter((r) => r !== row));
        return projected;
      },
      deleteMany: async (args: any = {}) => {
        log('deleteMany', args);
        const doomed = new Set(filtered(args));
        self.tables.set(model.name, self.rows(model.name).filter((r) => !doomed.has(r)));
        return { count: doomed.size };
      },
      aggregate: async (args: any = {}) => {
        log('aggregate', args);
        return self.aggregate(model, filtered(args), args);
      },
      groupBy: async (args: any = {}) => {
        log('groupBy', args);
        const groups = new Map<string, Row[]>();
        for (const r of filtered(args)) {
          const k = JSON.stringify(asArray(args.by).map((b: string) => cmpKey(r[b])));
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(r);
        }
        return [...groups.values()].map((rows) => {
          const out: Row = {};
          for (const b of asArray(args.by) as string[]) out[b] = cloneValue(rows[0][b]);
          return { ...out, ...self.aggregate(model, rows, args) };
        });
      }
    };
  }

  private aggregate(_model: DmmfModel, rows: Row[], args: any): Row {
    const out: Row = {};
    const pick = (spec: any) => Object.entries(spec || {}).filter(([, v]) => v).map(([k]) => k);
    if (args._count !== undefined) {
      if (args._count === true) out._count = rows.length;
      else out._count = Object.fromEntries(pick(args._count).map((k) => [k, k === '_all' ? rows.length : rows.filter((r) => r[k] !== null && r[k] !== undefined).length]));
    }
    const nums = (k: string) => rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
    if (args._sum) out._sum = Object.fromEntries(pick(args._sum).map((k) => [k, nums(k).length ? nums(k).reduce((a, b) => a + Number(b), 0) : null]));
    if (args._avg) out._avg = Object.fromEntries(pick(args._avg).map((k) => [k, nums(k).length ? nums(k).reduce((a, b) => a + Number(b), 0) / nums(k).length : null]));
    if (args._min) out._min = Object.fromEntries(pick(args._min).map((k) => [k, nums(k).length ? cloneValue([...nums(k)].sort(compare)[0]) : null]));
    if (args._max) out._max = Object.fromEntries(pick(args._max).map((k) => [k, nums(k).length ? cloneValue([...nums(k)].sort(compare).reverse()[0]) : null]));
    return out;
  }
}
