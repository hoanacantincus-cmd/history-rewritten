import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { simulate } from '../src/engine.ts';
import { parseBundle } from '../src/schema.ts';
import { agentEdges } from '../src/agent-graph.ts';
import { assembleQuestion, questionParts } from '../src/question.ts';

function demo(name: string) {
  return parseBundle(JSON.parse(readFileSync(new URL('../public/examples/' + name + '.json', import.meta.url), 'utf8')));
}

test('ratification uses the same second vote assumption in both branches', () => {
  const bundle = demo('ratification-1788');
  const first = simulate(bundle, { horizon: 1 });
  assert.deepEqual(first.runs.map(({ metrics }) => metrics), [
    { total: 9, threshold: true }, { total: 8, threshold: false },
    { total: 9, threshold: true }, { total: 8, threshold: false },
  ]);
  const second = simulate(bundle);
  assert.equal(second.runs.find(({ scenario, decision }) => scenario === 'va-yes' && decision === 'defer')?.metrics.threshold, true);
  assert.equal(second.sensitivity.find(({ metric }) => metric === 'threshold')?.varies, true);
  assert.deepEqual(simulate(JSON.parse(JSON.stringify(bundle))), second);
});

test('cashflow preserves units and differences over the sampled assumptions', () => {
  const data = simulate(demo('alaska-1867'));
  assert.deepEqual(data.runs.map(({ metrics }) => metrics.due), [7200000, 2880000, 7200000, 4320000]);
  assert.deepEqual(data.sensitivity[0].deltaRange, [-4320000, -2880000]);
  assert.equal(data.sensitivity[0].varies, true);
});

test('unknown information propagates and actors cannot act on unreleased observations', () => {
  const bundle = demo('ming-1644');
  const known = simulate(bundle, { scenario: 'cooperation' });
  assert.deepEqual(known.runs[1].metrics, { mandate: true, recognized: true });
  const uncertain = simulate(bundle, { scenario: 'unverified' });
  assert.deepEqual(uncertain.runs[1].metrics, { mandate: null, recognized: null });
  bundle.model!.variables.find(({ id }) => id === 'mandate')!.visibility!.nanjing = 3;
  const hidden = simulate(bundle, { scenario: 'cooperation' });
  assert.equal(hidden.runs[1].metrics.recognized, null);
});

test('malformed units, post-decision facts, wrong time bounds and non-parameter overrides are rejected', () => {
  const data = demo('alaska-1867');
  const money = data.model!.variables.find(({ id }) => id === 'due')!;
  money.unit = '月';
  assert.throws(() => simulate(data), /must use 月/);
  const history = demo('ming-1644');
  history.model!.rules[0].basis = ['real-nanjing'];
  assert.throws(() => simulate(history), /post-decision/);
  assert.throws(() => simulate(demo('ming-1644'), { horizon: 0 }), /outside the model window/);
  data.model!.scenarios[0].parameters.installments = true;
  assert.throws(() => simulate(data), /cannot override installments/);
});

test('parameters obey declared bounds and invalid arithmetic cannot become a historical result', () => {
  const data = demo('alaska-1867');
  data.model!.scenarios[0].parameters.share = 2;
  assert.throws(() => simulate(data), /cannot override share/);
  data.model!.scenarios[0].parameters.share = 0;
  data.model!.rules[0].value = { op: 'div', args: [{ ref: 'total' }, { ref: 'share' }] };
  assert.equal(simulate(data, { scenario: 'share-40' }).runs[1].metrics.due, null);
});

test('forecast probabilities use source counts and keep unclassified mass visible', () => {
  const data = demo('lottery-1788');
  const forecast = simulate(data).forecast!;
  assert.equal(forecast.observations, 104);
  assert.deepEqual(forecast.outcomes.map(({ probability }) => probability?.lower), [57 / 104, 47 / 104]);
  assert.equal(simulate(data, { scenario: 'draw-support' }).forecast?.observations, null);
  const mismatch = structuredClone(data);
  mismatch.model!.forecast!.baselineCheck = { value: '当天未达到九州门槛', basis: ['vote'] };
  assert.equal(simulate(mismatch).forecast?.baseline, 'disagrees');
  assert.equal(simulate(mismatch).forecast?.observations, null);
  data.model!.rules[2].value = null;
  const partial = simulate(data).forecast!;
  assert.equal(partial.unknownMass, 47 / 104);
  assert.deepEqual(partial.outcomes[0].probability, { lower: 57 / 104, upper: 1 });
  data.model!.forecast!.weights!.counts[0].count = 58;
  assert.throws(() => simulate(data), /matching cited observation/);
});

test('retrospective evidence anchors the recorded decision without entering simulated transitions', () => {
  const data = demo('ratification-1788');
  const model = data.model!;
  data.claims.find(({ id }) => id === 'nh-vote')!.scope = 'observed';
  const count = model.rules.find(({ id }) => id === 'nh-count')!;
  assert.throws(() => simulate(data), /post-decision observation nh-vote/);
  count.basis = ['prior'];
  assert.equal(simulate(data, { horizon: 1 }).runs[0].metrics.total, 9);
});

test('two agents respond in order to observed actions and weather-dependent costs', () => {
  const data = demo('lottery-1788');
  const model = data.model!;
  const basis = ['population'];
  model.horizon = 3;
  delete model.forecast!.weights;
  model.actors.push({ id: 'partner', label: 'Negotiation partner' });
  model.variables.push(
    { id: 'weather-cost', label: 'Weather-dependent travel cost', kind: 'number', unit: '1', role: 'parameter', initial: null, basis },
    { id: 'offer', label: 'Offer', kind: 'boolean', role: 'state', initial: false, basis, visibility: { partner: 2 } },
    { id: 'accept', label: 'Acceptance', kind: 'boolean', role: 'state', initial: false, basis },
  );
  const reference = (ref: string) => ({ ref });
  model.scenarios[0].parameters['weather-cost'] = 1;
  model.scenarios[1].parameters['weather-cost'] = 4;
  model.policies = [
    { id: 'make-offer', label: 'Consider a proposal', actor: 'convention', target: 'offer', start: 1, until: 1, basis,
      actions: [{ value: true, when: reference('drawing'), utility: { op: 'sub', args: [3, reference('weather-cost')] }, basis },
        { value: false, when: true, utility: 0, basis }] },
    { id: 'take-offer', label: 'Respond to the proposal', actor: 'partner', target: 'accept', start: 2, until: 2, basis,
      actions: [{ value: true, when: reference('offer'), utility: 1, basis }, { value: false, when: true, utility: 0, basis }] },
  ];
  // The synthetic case classifies the partner's response at step three.
  model.rules = [
    { ...model.rules[0], start: 3, until: 3, value: '当天未达到九州门槛' },
    { ...model.rules[1], start: 3, until: 3, when: reference('accept') },
    { ...model.rules[2], start: 3, until: 3, when: { op: 'not', args: [reference('accept')] } },
  ];
  const mild = simulate(data, { scenario: 'draw-support' });
  assert.equal(mild.runs[1].metrics.outcome, '当天达到九州门槛');
  assert.deepEqual(mild.runs[1].trace[0].utilities, [{ action: true, value: 2 }, { action: false, value: 0 }]);
  assert.equal(simulate(data, { scenario: 'draw-oppose' }).runs[1].metrics.outcome, '当天未达到九州门槛');
  model.variables.find(({ id }) => id === 'offer')!.visibility!.partner = 3;
  assert.equal(simulate(data, { scenario: 'draw-support' }).runs[1].metrics.outcome, null);
});

test('the sentence accepts two blanks, a pasted question, and a default outcome', () => {
  const question = '如果岳飞得到了皇帝的全部信任，南宋将会如何？';
  assert.equal(assembleQuestion('岳飞得到了皇帝的全部信任', '南宋将会如何'), question);
  assert.deepEqual(questionParts(question), { change: '岳飞得到了皇帝的全部信任', outcome: '南宋将会如何' });
  assert.equal(assembleQuestion(question, ''), question);
  assert.equal(assembleQuestion('南迁提议获准', ''), '如果南迁提议获准，历史将会如何发展？');
  assert.equal(assembleQuestion('如果', ''), '');
});

test('the featured example derives visible actor links and three distinct diplomatic outcomes', () => {
  const data = demo('yue-fei-1141');
  const model = data.model!;
  assert.deepEqual(agentEdges(model), [
    { from: 'emperor', to: 'yue', fields: ['mandate'] },
    { from: 'yue', to: 'qin', fields: ['proposal'] },
    { from: 'qin', to: 'jin', fields: ['court-agenda'] },
  ]);
  const output = simulate(data);
  assert.equal(output.forecast?.baseline, 'consistent');
  assert.deepEqual(output.runs.filter(({ decision }) => decision === 'trusted').map(({ metrics }) => metrics.direction), [
    '重新商议条款', '谈判暂时僵持', '按原方案议和',
  ]);
  assert.equal(output.forecast?.observations, null);
  model.variables.find(({ id }) => id === 'mandate')!.visibility!.yue = 3;
  assert.equal(agentEdges(model).some(({ from }) => from === 'emperor'), false);
});
