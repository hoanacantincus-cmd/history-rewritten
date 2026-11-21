import { z } from 'zod';
import type { Draft } from './schema.ts';
import { documentedRole } from './historical-evidence.ts';
import type { StudyIntent } from './historical-evidence.ts';
import type { Providers } from './provider-core.ts';

const line = z.string().trim().min(1).max(200);
const claim = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const compactSchema = z.object({
  title: line,
  scope: z.string().trim().min(1).max(950),
  recorded: line,
  change: line,
  historicalBasis: claim,
  proposer: z.object({ name: line, objective: line, basis: claim }),
  receiver: z.object({ name: line, objective: line, basis: claim }),
  constraint: z.object({
    label: line, explanation: z.string().trim().min(1).max(700), basis: claim,
  }),
}).nullable();

const guidance = [
  'Return one JSON object describing a two-party institutional constraint for this historical question, or null if none is supported.',
  'Use keys title, scope, recorded, change, historicalBasis, proposer, receiver, constraint. Each party has name, objective, basis, and the constraint has label, explanation, basis.',
  'If lockedIntent supplies actor names, include these exact names in the appropriate party labels. The proposer is the person or institution whose choice the user changes and the receiver is the party whose reaction the user asks about. Use only the supplied pre-decision facts and their exact IDs for every basis field. historicalBasis must support the recorded choice, not the eventual outcome. Choose the actual proposer and decision maker with different names.',
  'The constraint must be a concrete prerequisite that the receiver can inspect in the proposal, such as satisfying a legal threshold or preserving a specific authority. A description of willingness, support, agreement, success, or the receiver response is not an input constraint.',
  'Use the user language, keep recorded and change focused on the intervention without assuming the outcome. This model tests one necessary constraint, not the probability of ultimate success. Return null if no such source-grounded constraint can be identified.',
].join('\n');
const outputSchema = z.toJSONSchema(compactSchema, { io: 'input', reused: 'ref' });

export async function buildConstraintModel(
  payload: string, supported: Set<string>, providers: Providers, intent: StudyIntent,
): Promise<Draft | undefined> {
  const sketch = compactSchema.safeParse(await providers.complete(guidance, payload, outputSchema));
  if (!sketch.success || !sketch.data) return undefined;
  const { title, scope, recorded, change, historicalBasis, proposer, receiver, constraint } = sketch.data;
  const source = JSON.parse(payload) as { context: { id: string; text: string }[] };
  const facts = source.context.filter(({ id }) => supported.has(id)).map(({ text }) => text);
  const senderTitle = documentedRole(proposer.name, intent.changer, facts);
  const receiverTitle = documentedRole(receiver.name, intent.responder, facts);
  if (!senderTitle || !receiverTitle || proposer.name === receiver.name || recorded === change ||
      ![historicalBasis, proposer.basis, receiver.basis, constraint.basis].every((id) => supported.has(id))) return undefined;
  const assumption = 'constraint-method';
  if (supported.has(assumption)) return undefined;
  const basis = [constraint.basis, assumption];
  const passed = '通过这项必要条件';
  const blocked = '被这项条件阻碍';
  return {
    title, scope: scope + ' 本次模型检验一项必要条件。通过这一关之后的最终结果仍待验证。',
    status: 'ready', timeline: [], options: [],
    claims: [{ id: assumption, status: 'assumption', scope: 'context', citations: [],
      text: constraint.explanation + ' 情景只比较该前提能否满足，尚无完整的双方决策资料。' }],
    gaps: ['缺少同时约束所有关键行动的证据，报告只展示一项必要条件。', '缺少可复核的情景频数。'],
    model: {
      horizon: 2, stepLabel: '提出方案、对方检验条件',
      decisionPoint: recorded, decisionBasis: [historicalBasis],
      actors: [
        { id: 'sender', label: senderTitle, objective: proposer.objective, basis: [proposer.basis] },
        { id: 'receiver', label: receiverTitle, objective: receiver.objective, basis: [receiver.basis] },
      ],
      variables: [
        { id: 'intervention', label: '提案选择', role: 'decision', kind: 'boolean', initial: false, basis: [historicalBasis] },
        { id: 'condition', label: constraint.label, role: 'parameter', kind: 'boolean', initial: null, basis },
        { id: 'proposal', label: '改写提案已经送达', role: 'state', kind: 'boolean', initial: null, basis,
          visibility: { receiver: 2 } },
        { id: 'check', label: '改写提案能否越过一项必要条件', role: 'state', kind: 'category', initial: null, basis,
          values: [passed, blocked] },
      ],
      decisions: [
        { id: 'recorded', label: recorded, value: false, basis: [historicalBasis] },
        { id: 'alternative', label: change, value: true, basis },
      ],
      scenarios: [
        { id: 'satisfies-condition', label: '能满足该条件', basis, parameters: { condition: true } },
        { id: 'fails-condition', label: '无法满足该条件', basis, parameters: { condition: false } },
      ],
      rules: [
        { id: 'deliver', label: '送达当前提案', actor: 'sender', target: 'proposal', start: 1, until: 1,
          when: true, value: { ref: 'intervention' }, basis },
      ],
      policies: [
        { id: 'check-required', label: '根据提案审查一项先决条件', actor: 'receiver', target: 'check', start: 2, until: 2, basis,
          actions: [
            { value: passed, when: { op: 'and', args: [{ ref: 'proposal' }, { ref: 'condition' }] }, utility: 1, basis },
            { value: blocked, when: { op: 'and', args: [{ ref: 'proposal' }, { op: 'not', args: [{ ref: 'condition' }] }] }, utility: 1, basis },
          ] },
      ],
      metrics: [{ id: 'condition-outcome', label: '改写提案能否越过一项必要条件', field: 'check' }],
      forecast: {
        decision: 'alternative', metric: 'condition-outcome',
        factors: [
          { kind: 'internal', status: 'unresolved', explanation: '其他内部协调条件缺少可执行参数。', basis, variables: [] },
          { kind: 'external', status: 'modeled', explanation: constraint.explanation, basis, variables: ['condition'] },
          { kind: 'strategy', status: 'modeled', explanation: '收件方在下一步根据收到的提案及明确先决条件决定是否提出障碍。',
            basis, variables: ['proposal', 'check'] },
          { kind: 'weather', status: 'unresolved', explanation: '暂无可以连到本项必要条件的天气资料。', basis, variables: [] },
        ],
      },
    },
  };
}
