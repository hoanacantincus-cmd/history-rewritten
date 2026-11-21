import type { Expr, Model } from './schema.ts';

export type AgentEdge = { from: string; to: string; fields: string[] };

function reads(expression: Expr, fields: Set<string>) {
  if (expression === null || typeof expression !== 'object') return;
  if ('ref' in expression) fields.add(expression.ref);
  else for (const input of expression.args) reads(input, fields);
}

export function agentEdges(model: Model): AgentEdge[] {
  const transitions = [
    ...model.rules.flatMap((rule) => rule.actor
      ? [{ actor: rule.actor, target: rule.target, reads: [rule.when, rule.value], start: rule.start, until: rule.until }] : []),
    ...(model.policies ?? []).map((policy) => ({
      actor: policy.actor, target: policy.target, start: policy.start, until: policy.until,
      reads: policy.actions.flatMap(({ when, utility }) => [when, utility]),
    })),
  ];
  const writers = new Map<string, typeof transitions>();
  for (const transition of transitions) {
    const previous = writers.get(transition.target) ?? [];
    previous.push(transition);
    writers.set(transition.target, previous);
  }
  const variables = new Map(model.variables.map((field) => [field.id, field]));
  const edges = new Map<string, { edge: AgentEdge; fields: Set<string> }>();
  for (const consumer of transitions) {
    const used = new Set<string>();
    consumer.reads.forEach((expr) => reads(expr, used));
    for (const field of used) {
      const visibility = variables.get(field)?.visibility;
      const visibleFrom = visibility ? visibility[consumer.actor] ?? Infinity : 0;
      if (visibleFrom > consumer.until) continue;
      for (const producer of writers.get(field) ?? []) {
        // Transitions read the previous round's state.
        if (producer.actor === consumer.actor || producer.start >= consumer.until) continue;
        const key = producer.actor + ':' + consumer.actor;
        const existing = edges.get(key);
        if (existing) existing.fields.add(field);
        else edges.set(key, { edge: { from: producer.actor, to: consumer.actor, fields: [] }, fields: new Set([field]) });
      }
    }
  }
  return [...edges.values()].map(({ edge, fields }) => ({ ...edge, fields: [...fields] }));
}
