import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const label = z.string().trim().min(1).max(200);
const prose = z.string().trim().min(1).max(1200);
const basis = z.array(id).min(1).max(10);
const step = z.number().int().min(0).max(120);
const scalar = z.union([z.boolean(), z.number().finite(), z.string().min(1).max(100), z.null()]);
export type Scalar = z.infer<typeof scalar>;
const operators = ['and', 'or', 'not', 'eq', 'lt', 'lte', 'gt', 'gte', 'add', 'sub', 'mul', 'div'] as const;
type Operator = typeof operators[number];
export type Expr = Scalar | { ref: string } | { op: Operator; args: Expr[] };

function expression(depth: number): z.ZodType<Expr> {
  const ref = z.strictObject({ ref: id });
  if (depth === 0) return z.union([scalar, ref]);
  return z.union([scalar, ref, z.strictObject({
    op: z.enum(operators), args: z.array(expression(depth - 1)).min(1).max(2),
  })]);
}

const safeUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}, 'Expected an HTTP(S) URL without credentials');

export const sourceSchema = z.strictObject({
  id, title: label, url: safeUrl, accessed: z.iso.date(),
  origin: z.enum(['web', 'user']),
});
const citationSchema = z.strictObject({
  source: id, locator: label, quote: z.string().trim().min(8).max(180),
});
const claimSchema = z.strictObject({
  id, text: prose,
  status: z.enum(['supported', 'disputed', 'assumption', 'gap']),
  scope: z.enum(['context', 'observed']),
  citations: z.array(citationSchema).max(6),
});
const variableSchema = z.strictObject({
  id, label, kind: z.enum(['number', 'boolean', 'category']),
  role: z.enum(['state', 'parameter', 'decision']),
  unit: label.optional(), values: z.array(label.max(100)).min(2).max(12).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
  initial: scalar, basis,
  visibility: z.record(id, step).optional(),
});
const modelSchema = z.strictObject({
  horizon: step.refine((n) => n > 0),
  stepLabel: label,
  decisionPoint: prose,
  decisionBasis: basis,
  actors: z.array(z.strictObject({ id, label })).max(12),
  variables: z.array(variableSchema).min(2).max(30),
  decisions: z.array(z.strictObject({ id, label, value: scalar, basis })).min(2).max(4),
  scenarios: z.array(z.strictObject({
    id, label, basis, parameters: z.record(id, scalar),
  })).min(1).max(16),
  rules: z.array(z.strictObject({
    id, label, target: id, actor: id.optional(), start: step, until: step,
    when: expression(3), value: expression(3), basis,
  })).min(1).max(64),
  metrics: z.array(z.strictObject({ id, label, field: id })).min(1).max(8),
});
const timelineItem = z.strictObject({ label, when: label, basis });
export const draftSchema = z.strictObject({
  status: z.enum(['ready', 'insufficient', 'clarification']),
  title: label, scope: prose,
  claims: z.array(claimSchema).max(60),
  timeline: z.array(timelineItem).max(24),
  gaps: z.array(prose).max(16),
  options: z.array(z.strictObject({ label, question: prose, basis })).max(5),
  model: modelSchema.nullable(),
});
const bundleSchema = draftSchema.extend({
  schemaVersion: z.literal(1),
  engineVersion: z.literal('1'),
  question: prose,
  sources: z.array(sourceSchema).max(24),
});

export const requestSchema = z.strictObject({
  question: prose,
  sources: z.array(z.strictObject({
    url: safeUrl, title: label.optional(), excerpt: z.string().trim().min(8).max(6000).optional(),
  })).max(8).default([]),
});
export type ResearchRequest = z.infer<typeof requestSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Bundle = z.infer<typeof bundleSchema>;
export type Model = NonNullable<Bundle['model']>;
export type Variable = Model['variables'][number];

function index<T extends { id: string }>(items: T[], name: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) throw new Error(name + ' has duplicate id ' + item.id);
    result.set(item.id, item);
  }
  return result;
}

type ValueType = 'boolean' | 'number' | 'category' | 'unknown';
export function valueFits(value: Scalar, variable: Variable): boolean {
  if (value === null) return true;
  if (variable.kind === 'category') return typeof value === 'string' && !!variable.values?.includes(value);
  if (variable.kind === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    value >= (variable.min ?? -Infinity) && value <= (variable.max ?? Infinity);
  return typeof value === variable.kind;
}

// Numeric literals take the unit of the expression around them. "1" denotes a dimensionless field.
function unitOf(expr: Expr, fields: Map<string, Variable>, path: string): string | undefined {
  if (expr === null || typeof expr !== 'object') return undefined;
  if ('ref' in expr) return fields.get(expr.ref)?.unit;
  const [left, right] = expr.args.map((arg) => unitOf(arg, fields, path));
  if (['and', 'or', 'not'].includes(expr.op)) return undefined;
  if (expr.op === 'mul') {
    if (left && right && left !== '1' && right !== '1') throw new Error(path + ' multiplies two quantities with units');
    return left === '1' ? right ?? left : left ?? right;
  }
  if (expr.op === 'div') {
    if (!right || right === '1') return left;
    if (left === right) return '1';
    throw new Error(path + ' divides incompatible units');
  }
  if (left && right && left !== right) throw new Error(path + ' mixes units ' + left + ' and ' + right);
  return expr.op === 'add' || expr.op === 'sub' ? left ?? right : undefined;
}

function typeOf(expr: Expr, fields: Map<string, Variable>, path: string): ValueType {
  if (expr === null) return 'unknown';
  if (typeof expr === 'string') return 'category';
  if (typeof expr === 'number' || typeof expr === 'boolean') return typeof expr === 'number' ? 'number' : 'boolean';
  if ('ref' in expr) {
    const field = fields.get(expr.ref);
    if (!field) throw new Error(path + ' refers to unknown variable ' + expr.ref);
    return field.kind;
  }
  const types = expr.args.map((arg) => typeOf(arg, fields, path));
  if (types.length !== (expr.op === 'not' ? 1 : 2)) throw new Error(path + ' has wrong operand count');
  if (expr.op === 'eq') {
    if (!types.includes('unknown') && types[0] !== types[1]) throw new Error(path + ' compares incompatible types');
    return 'boolean';
  }
  if (['not', 'and', 'or'].includes(expr.op)) {
    if (types.some((type) => type !== 'boolean' && type !== 'unknown')) throw new Error(path + ' needs boolean operands');
    return 'boolean';
  }
  if (types.some((type) => type !== 'number' && type !== 'unknown')) throw new Error(path + ' needs numeric operands');
  return ['lt', 'lte', 'gt', 'gte'].includes(expr.op) ? 'boolean' : 'number';
}

function validateModel(model: Model, checkBasis: (refs: string[], path: string, context?: boolean) => void) {
  const actors = index(model.actors, 'actors');
  const fields = index(model.variables, 'variables');
  index(model.decisions, 'decisions');
  index(model.scenarios, 'scenarios');
  index(model.rules, 'rules');
  index(model.metrics, 'metrics');
  if (model.scenarios.some(({ id }) => id === 'all') || model.metrics.some(({ id }) => id === 'all')) {
    throw new Error('"all" is reserved for selection');
  }
  const decisions = model.variables.filter((field) => field.role === 'decision');
  if (decisions.length !== 1) throw new Error('model.variables must define one decision variable');
  const decision = decisions[0];
  if (model.decisions[0].value !== decision.initial) throw new Error('model.decisions[0] must match the historical baseline');
  if (new Set(model.decisions.map((item) => item.value)).size !== model.decisions.length) throw new Error('model.decisions must set distinct values');
  checkBasis(model.decisionBasis, 'model.decisionBasis', true);
  for (const field of fields.values()) {
    const path = 'model.variables.' + field.id;
    if (field.kind === 'number' && !field.unit) throw new Error(path + ' needs a unit');
    if (field.kind !== 'number' && field.unit) throw new Error(path + ' cannot have a unit');
    if ((field.min !== undefined || field.max !== undefined) &&
        (field.kind !== 'number' || (field.min ?? -Infinity) > (field.max ?? Infinity))) {
      throw new Error(path + ' has invalid numeric bounds');
    }
    if (field.kind === 'category' && (!field.values || new Set(field.values).size !== field.values.length)) {
      throw new Error(path + ' needs distinct category values');
    }
    if (!valueFits(field.initial, field)) throw new Error(path + ' has an invalid initial value');
    for (const actor of Object.keys(field.visibility ?? {})) {
      if (!actors.has(actor)) throw new Error(path + ' refers to unknown actor ' + actor);
    }
    checkBasis(field.basis, path, true);
  }
  for (const branch of model.decisions) {
    if (branch.value === null || !valueFits(branch.value, decision)) throw new Error('Invalid decision value in ' + branch.id);
    checkBasis(branch.basis, 'model.decisions.' + branch.id, true);
  }
  for (const scenario of model.scenarios) {
    for (const [name, value] of Object.entries(scenario.parameters)) {
      const field = fields.get(name);
      if (!field || field.role !== 'parameter' || !valueFits(value, field)) {
        throw new Error('model.scenarios.' + scenario.id + ' cannot override ' + name);
      }
    }
    checkBasis(scenario.basis, 'model.scenarios.' + scenario.id, true);
  }
  for (const rule of model.rules) {
    const path = 'model.rules.' + rule.id;
    const target = fields.get(rule.target);
    if (!target || target.role !== 'state') throw new Error(path + ' must update a state variable');
    if (rule.actor && !actors.has(rule.actor)) throw new Error(path + ' refers to an unknown actor');
    if (rule.start < 1 || rule.start > rule.until || rule.until > model.horizon) throw new Error(path + ' has invalid step bounds');
    const when = typeOf(rule.when, fields, path + '.when');
    if (when !== 'boolean' && when !== 'unknown') throw new Error(path + '.when must be boolean');
    unitOf(rule.when, fields, path + '.when');
    const value = typeOf(rule.value, fields, path + '.value');
    if (value !== 'unknown' && value !== target.kind) throw new Error(path + '.value has an incompatible type');
    const unit = unitOf(rule.value, fields, path + '.value');
    if (unit && unit !== target.unit) throw new Error(path + '.value must use ' + target.unit);
    if (typeof rule.value === 'string' && !valueFits(rule.value, target)) throw new Error(path + '.value is outside the target categories');
    checkBasis(rule.basis, path, true);
  }
  for (const metric of model.metrics) {
    if (!fields.has(metric.field)) throw new Error('model.metrics.' + metric.id + ' refers to an unknown field');
  }
}

export function parseBundle(input: unknown): Bundle {
  const bundle = bundleSchema.parse(input);
  const sources = index(bundle.sources, 'sources');
  const claims = index(bundle.claims, 'claims');
  for (const claim of claims.values()) {
    for (const cite of claim.citations) {
      if (!sources.has(cite.source)) throw new Error('claims.' + claim.id + ' refers to unknown source ' + cite.source);
    }
    if (claim.status === 'supported' && !claim.citations.length) throw new Error('claims.' + claim.id + ' needs a source');
    if (claim.status === 'disputed' && new Set(claim.citations.map((cite) => cite.source)).size < 2) {
      throw new Error('claims.' + claim.id + ' needs two distinct sources');
    }
  }
  function checkBasis(refs: string[], path: string, context = false) {
    for (const ref of refs) {
      const claim = claims.get(ref);
      if (!claim) throw new Error(path + ' refers to unknown claim ' + ref);
      if (context && claim.scope === 'observed') throw new Error(path + ' depends on a post-decision observation ' + ref);
    }
  }
  for (const event of bundle.timeline) {
    checkBasis(event.basis, 'timeline.' + event.label);
    if (!event.basis.some((claim) => ['supported', 'disputed'].includes(claims.get(claim)!.status))) {
      throw new Error('timeline.' + event.label + ' needs historical evidence');
    }
  }
  for (const option of bundle.options) checkBasis(option.basis, 'options.' + option.label, true);
  if (bundle.status === 'ready' && bundle.model) {
    validateModel(bundle.model, checkBasis);
    if (!bundle.model.decisionBasis.some((ref) => claims.get(ref)?.status === 'supported')) {
      throw new Error('model.decisionBasis needs a sourced historical decision');
    }
    if (!bundle.model.decisions[0].basis.some((ref) => claims.get(ref)?.status === 'supported')) {
      throw new Error('model.decisions[0] needs a sourced historical baseline');
    }
  } else if (bundle.status === 'ready' || bundle.model) {
    throw new Error('Only ready bundles can contain a model, and ready bundles must contain one');
  }
  if (bundle.status === 'clarification' && bundle.options.length < 2) throw new Error('Clarification needs at least two options');
  if (bundle.status === 'insufficient' && !bundle.gaps.length) throw new Error('Insufficient evidence needs a gap description');
  return bundle;
}

export function draftJsonSchema() {
  return z.toJSONSchema(draftSchema, { io: 'input', reused: 'ref' });
}
