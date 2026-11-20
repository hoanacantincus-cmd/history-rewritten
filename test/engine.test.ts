import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { simulate } from '../src/engine.ts';
import { parseBundle } from '../src/schema.ts';

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
