import { parseBundle, valueFits } from './schema.ts';
import type { Bundle, Expr, Model, Scalar, Variable } from './schema.ts';

function evaluate(expr: Expr, read: (name: string) => Scalar): Scalar {
  if (expr === null || typeof expr !== 'object') return expr;
  if ('ref' in expr) return read(expr.ref);
  const [left, right] = expr.args.map((arg) => evaluate(arg, read));
  if (expr.op === 'and') return left === false || right === false ? false : left === true && right === true ? true : null;
  if (expr.op === 'or') return left === true || right === true ? true : left === false && right === false ? false : null;
  if (left === null) return null;
  if (expr.op === 'not') return !left;
  if (right === null) return null;
  if (expr.op === 'eq') return left === right;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  switch (expr.op) {
    case 'lt': return left < right;
    case 'lte': return left <= right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
    case 'add': return left + right;
    case 'sub': return left - right;
    case 'mul': return left * right;
    case 'div': return right === 0 ? null : left / right;
  }
}

type Trace = {
  step: number;
  rule: string;
  field: string;
  actor?: string;
  before: Scalar;
  after: Scalar;
  basis: string[];
  indeterminate: boolean;
  utilities?: { action: string | boolean; value: number | null }[];
};
type Run = {
  scenario: string;
  decision: string;
  metrics: Record<string, Scalar>;
  trace: Trace[];
};
type Comparison = {
  scenario: string;
  decision: string;
  metric: string;
  before: Scalar;
  after: Scalar;
  delta: number | null;
  change: 'unknown' | 'same' | 'higher' | 'lower' | 'different';
};

export type ForecastResult = {
  decision: string;
  outcome: string;
  observations: number | null;
  unknownMass: number | null;
  outcomes: {
    label: string;
    scenarios: string[];
    probability: { lower: number; upper: number } | null;
  }[];
};

function deriveForecast(model: Model, runs: Run[], fullWindow: boolean, allScenarios: boolean): ForecastResult | null {
  const forecast = model.forecast;
  if (!forecast) return null;
  const field = model.variables.find(({ id }) => id === model.metrics.find(({ id }) => id === forecast.metric)!.field)!;
  const alternatives = runs.filter((run) => run.decision === forecast.decision);
  // A partial horizon or filtered scenario cannot be treated as the registered population.
  const weights = fullWindow && allScenarios ? forecast.weights : undefined;
  const counts = new Map(weights?.counts.map(({ scenario, count }) => [scenario, count]));
  const observations = weights?.counts.reduce((sum, { count }) => sum + count, 0) ?? null;
  const unknown = alternatives.filter((run) => run.metrics[forecast.metric] === null)
    .reduce((sum, run) => sum + (counts.get(run.scenario) ?? 0), 0);
  return {
    decision: forecast.decision, outcome: forecast.metric, observations,
    unknownMass: observations ? unknown / observations : null,
    outcomes: field.values!.map((label) => {
      const scenarios = alternatives.filter((run) => run.metrics[forecast.metric] === label).map(({ scenario }) => scenario);
      const count = scenarios.reduce((sum, scenario) => sum + (counts.get(scenario) ?? 0), 0);
      return { label, scenarios, probability: observations ? { lower: count / observations, upper: (count + unknown) / observations } : null };
    }),
  };
}

function chooseAction(policy: NonNullable<Model['policies']>[number], read: (name: string) => Scalar) {
  const utilities: NonNullable<Trace['utilities']> = [];
  let best: string | boolean | null = null;
  let maximum = -Infinity;
  let unresolved = false;
  const evidence = new Set(policy.basis);
  for (const action of policy.actions) {
    const feasible = evaluate(action.when, read);
    if (feasible === false) continue;
    action.basis.forEach((claim) => evidence.add(claim));
    const value = feasible === true ? evaluate(action.utility, read) : null;
    const score = typeof value === 'number' && Number.isFinite(value) ? value : null;
    utilities.push({ action: action.value, value: score });
    if (score === null) unresolved = true;
    else if (score > maximum) { best = action.value; maximum = score; }
    else if (score === maximum) best = null;
  }
  return { value: unresolved ? null : best, evidence: [...evidence], utilities };
}

function run(
  model: Model, scenario: Model['scenarios'][number], decision: Model['decisions'][number],
  horizon: number, fields: Map<string, Variable>,
): Run {
  let state = Object.fromEntries(model.variables.map((item) => [
    item.id, item.role === 'decision' ? decision.value : item.initial,
  ]));
  state = { ...state, ...scenario.parameters };
  const trace: Trace[] = [];
  const reportedUnknown = new Set<string>();
  for (let step = 1; step <= horizon; step++) {
    const next = { ...state };
    const updated = new Set<string>();
    const readFor = (actor?: string) => (name: string): Scalar => {
      const visibility = fields.get(name)!.visibility;
      if (actor && visibility && step < (Object.hasOwn(visibility, actor) ? visibility[actor] : Infinity)) return null;
      return state[name];
    };
    for (const policy of model.policies ?? []) {
      if (step < policy.start || step > policy.until) continue;
      const choice = chooseAction(policy, readFor(policy.actor));
      next[policy.target] = choice.value;
      trace.push({
        step, rule: policy.id, actor: policy.actor, field: policy.target, before: state[policy.target],
        after: choice.value, basis: choice.evidence, utilities: choice.utilities, indeterminate: choice.value === null,
      });
    }
    for (const rule of model.rules) {
      if (step < rule.start || step > rule.until || updated.has(rule.target)) continue;
      const read = readFor(rule.actor);
      const enabled = evaluate(rule.when, read);
      if (enabled === false) continue;
      // An unknown higher-priority condition can change the outcome, so it blocks fallthrough.
      updated.add(rule.target);
      const candidate = enabled === true ? evaluate(rule.value, read) : null;
      const after = (typeof candidate === 'number' && !Number.isFinite(candidate)) || !valueFits(candidate, fields.get(rule.target)!)
        ? null : candidate;
      const before = state[rule.target];
      next[rule.target] = after;
      if (before !== after || (after === null && !reportedUnknown.has(rule.id))) {
        trace.push({ step, rule: rule.id, field: rule.target, actor: rule.actor, before, after, basis: rule.basis, indeterminate: after === null });
      }
      if (after === null) reportedUnknown.add(rule.id);
    }
    state = next;
  }
  return {
    scenario: scenario.id,
    decision: decision.id,
    metrics: Object.fromEntries(model.metrics.map((indicator) => [indicator.id, state[indicator.field]])),
    trace,
  };
}

export function simulate(input: unknown, options: { scenario?: string; horizon?: number } = {}) {
  const bundle: Bundle = parseBundle(input);
  const model = bundle.model;
  if (!model) return {
    engineVersion: bundle.engineVersion, status: bundle.status, gaps: bundle.gaps,
    runs: [], comparisons: [], sensitivity: [], forecast: null,
  };
  const horizon = options.horizon ?? model.horizon;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > model.horizon) throw new Error('Horizon is outside the model window');
  const scenarios = options.scenario && options.scenario !== 'all'
    ? model.scenarios.filter((scenario) => scenario.id === options.scenario)
    : model.scenarios;
  if (!scenarios.length) throw new Error('Unknown scenario ' + options.scenario);
  const fields = new Map(model.variables.map((variable) => [variable.id, variable]));
  const runs: Run[] = [];
  const comparisons: Comparison[] = [];
  for (const scenario of scenarios) {
    const [baseline, ...alternatives] = model.decisions.map((decision) => run(model, scenario, decision, horizon, fields));
    runs.push(baseline, ...alternatives);
    for (const alternative of alternatives) {
      for (const metric of model.metrics) {
        const before = baseline.metrics[metric.id];
        const after = alternative.metrics[metric.id];
        const rawDelta = typeof before === 'number' && typeof after === 'number' ? after - before : null;
        const delta = rawDelta !== null && Number.isFinite(rawDelta) ? rawDelta : null;
        comparisons.push({
          scenario: scenario.id, decision: alternative.decision, metric: metric.id, before, after, delta,
          change: before === null || after === null ? 'unknown' : before === after ? 'same' :
            typeof before === 'number' && typeof after === 'number' ? after > before ? 'higher' : 'lower' : 'different',
        });
      }
    }
  }
  const sensitivity = model.decisions.slice(1).flatMap((decision) => model.metrics.map((metric) => {
    const rows = comparisons.filter((row) => row.decision === decision.id && row.metric === metric.id);
    const changes = [...new Set(rows.filter((row) => row.change !== 'unknown').map((row) => row.change))];
    const numeric = rows.flatMap((row) => row.delta === null ? [] : [row.delta]);
    const moves = rows.filter((row) => row.change !== 'unknown').map((row) =>
      row.delta ?? (row.change === 'different' ? JSON.stringify([row.before, row.after]) : row.change));
    return {
      decision: decision.id, metric: metric.id, varies: new Set(moves).size > 1, changes,
      incomplete: rows.some((row) => row.change === 'unknown'),
      deltaRange: numeric.length ? [Math.min(...numeric), Math.max(...numeric)] : null,
    };
  }));
  const forecast = deriveForecast(model, runs, horizon === model.horizon, scenarios.length === model.scenarios.length);
  return { engineVersion: bundle.engineVersion, status: bundle.status, horizon, gaps: bundle.gaps, runs, comparisons, sensitivity, forecast };
}
export type Simulation = ReturnType<typeof simulate>;
