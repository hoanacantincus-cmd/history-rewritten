import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { research } from '../src/research.ts';
import { decodeCompletion, readPublicPage } from '../src/providers.ts';
import type { Providers } from '../src/providers.ts';
import { simulate } from '../src/engine.ts';
import { createApp } from '../src/server.ts';

const quote = 'Recorded decision in a synthetic test transcript.';
const sourceUrl = 'https://archive.example/record';
const archived = { id: 'anchor', text: 'Synthetic test claim', status: 'supported', scope: 'context',
  citations: [{ source: 'source-1', locator: 'Record 1', quote }] };
const assumed = { id: 'assumption', text: 'Synthetic test assumption', status: 'assumption', scope: 'context', citations: [] };
const cited = ['anchor'];
const hypothesis = ['assumption'];

function modeled(title: string) {
  return { status: 'ready', title, scope: 'Synthetic protocol fixture', claims: [archived, assumed],
    timeline: [{ label: 'Synthetic baseline event', when: 'Phase 1', basis: cited }], gaps: [], options: [],
    model: {
      horizon: 1, stepLabel: 'phase', decisionPoint: 'First phase', decisionBasis: cited, actors: [],
      variables: [
        { id: 'action', label: 'Action', kind: 'boolean', role: 'decision', initial: false, basis: cited },
        { id: 'outcome', label: 'Estimate', kind: 'number', role: 'state', initial: 0, basis: hypothesis, unit: 'units' },
        { id: 'ending', label: 'Ending', kind: 'category', role: 'state', initial: 'unchanged', values: ['changed', 'unchanged'], basis: hypothesis },
      ],
      decisions: [{ id: 'baseline', label: 'Baseline', value: false, basis: cited },
        { id: 'change', label: 'Change', value: true, basis: hypothesis }],
      scenarios: [{ id: 'example', label: 'Example', basis: hypothesis, parameters: {} }],
      rules: [{ id: 'activate', label: 'Change estimate', target: 'outcome', start: 1, until: 1,
        when: { ref: 'action' }, value: 1, basis: hypothesis },
        { id: 'update-ending', label: 'Update ending', target: 'ending', start: 1, until: 1, when: { ref: 'action' }, value: 'changed', basis: hypothesis }],
      metrics: [{ id: 'effect', label: 'Effect', field: 'outcome' }, { id: 'ending', label: 'Ending', field: 'ending' }],
      forecast: { decision: 'change', metric: 'ending', factors: ['internal','external','strategy','weather'].map((kind) =>
        ({ kind, status: 'unresolved', explanation: 'Synthetic factor audit', basis: hypothesis, variables: [] })) },
    },
  };
}

function providers(reply: unknown, text = quote): Providers {
  return {
    async search() { return [sourceUrl + '?utm_source=fixture', sourceUrl + '#duplicate', 'https://mirror.example/record']; },
    async read(url) { return { url, title: 'Synthetic archival page', text }; },
    async complete(instructions, data) {
      const input = JSON.parse(data) as { question: string };
      return instructions.startsWith('Return JSON with title')
        ? { title: input.question, queries: [input.question] } : structuredClone(reply);
    },
  };
}

for (const [question, expected] of [
  ['如果 1776 年独立宣言表决推迟？', 'ready'],
  ['如果 1846 年谷物法的废除期限改变？', 'ready'],
  ['如果 1960 年一份条约晚一年批准？', 'ready'],
  ['1905 年挪威独立', 'clarification'],
  ['1634 年两地互不相符的地方记录', 'conflict'],
  ['某地方口传事件的细节无法查证', 'insufficient'],
]) {
  test('free-form research fixture · ' + question, async () => {
    let draft: unknown = modeled(question);
    let driver: Providers = providers(draft);
    if (expected === 'clarification') {
      draft = { ...modeled(question), status: expected, model: null, options: [
        { label: '选择条款', question: '如果行动方修改条款？', basis: cited },
        { label: '选择时间', question: '如果条款提前批准？', basis: cited },
      ] };
      driver = providers(draft);
    }
    if (expected === 'conflict') {
      const model = modeled(question);
      const difference = 'Another synthetic archival record contradicts the first.';
      const result = { ...model, claims: [...model.claims, {
        id: 'conflict', text: 'The sources disagree', status: 'disputed', scope: 'context',
        citations: [...archived.citations, { source: 'source-2', locator: 'Record 2', quote: difference }],
      }] };
      driver = providers(result);
      driver.read = async (url) => ({ url, title: 'Synthetic records', text: url === sourceUrl ? quote : difference });
    }
    if (expected === 'insufficient') driver.read = async () => { throw new Error('unavailable'); };
    const bundle = await research({ question }, driver, '2026-11-20');
    assert.equal(bundle.question, question);
    assert.equal(bundle.status, expected === 'conflict' ? 'ready' : expected);
    if (expected === 'conflict') assert.equal(bundle.claims.find(({ id }) => id === 'conflict')?.status, 'disputed');
    else assert.ok(bundle.sources.length < 2);
    if (bundle.model) assert.equal(simulate(bundle).comparisons[0].delta, 1);
  });
}

test('cites only excerpts present in a fetched or submitted source', async () => {
  const unverified = await research({ question: 'Unverified quote' }, providers(modeled('Quote'), 'An unrelated article.'));
  assert.equal(unverified.status, 'insufficient');
  assert.equal(unverified.claims.length, 0);
  assert.equal(unverified.sources.length, 1);
  assert.match(unverified.gaps[1], /Exact quote not found/);
  const driver = providers(modeled('Submitted'));
  driver.search = async () => { throw new Error('Search unavailable'); };
  const bundle = await research({ question: 'Submitted source', sources: [{ url: sourceUrl, excerpt: quote }] }, driver);
  assert.equal(bundle.sources[0].origin, 'user');
  assert.match(bundle.gaps[0], /用户提供/);
});

test('source reading policy confines URLs to public standard HTTP(S) targets', async () => {
  await assert.rejects(readPublicPage('https://127.0.0.1/'), /not public/);
  await assert.rejects(readPublicPage('file:///archive.html'), /public HTTP/);
});

test('compatible model responses can contain one complete JSON object followed by formatting or another object', () => {
  assert.deepEqual(decodeCompletion('prefix {"text":"quote } \\"","data":{"ok":true}}\n{"status":"extra"}'),
    { text: 'quote } "', data: { ok: true } });
  assert.deepEqual(decodeCompletion('{"status":"ready","model":{"actors":[]}' ), { status: 'ready', model: { actors: [] } });
  assert.deepEqual(decodeCompletion('{"status":"ready","model":{"actors":[],},}'),
    { status: 'ready', model: { actors: [] } });
  assert.throws(() => decodeCompletion('{"text":"truncated"'), SyntaxError);
});

test('local HTTP research can produce a replayable bundle from free-form input', async () => {
  const server = createApp(providers(modeled('New question')));
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const health = await fetch(base + '/api/status');
    assert.deepEqual(await health.json(), { mode: 'self-hosted' });
    const response = await fetch(base + '/api/research', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'New question' }),
    });
    assert.equal(response.status, 200);
    assert.equal(simulate(await response.json()).comparisons[0].delta, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('HTTP streams the current research phase before modeling finishes and ends with a bundle', async () => {
  const driver = providers(modeled('Streamed analysis'));
  const complete = driver.complete;
  let finishModel!: () => void;
  const gate = new Promise<void>((resolve) => { finishModel = resolve; });
  driver.complete = async (instructions, data) => {
    if (!instructions.startsWith('Return JSON with title')) await gate;
    return complete(instructions, data);
  };
  const server = createApp(driver);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ question: '如果某次和议改期，外交会怎样？' }),
      signal: AbortSignal.timeout(5000),
    });
    assert.match(response.headers.get('content-type') ?? '', /ndjson/);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let before = '';
    while (!before.includes('"phase":"model"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      before += chunk.value;
    }
    assert.ok(before.includes('"phase":"identify"'));
    assert.ok(before.includes('"phase":"evidence"'));
    assert.ok(!before.includes('"type":"result"'));
    finishModel();
    let all = before;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      all += chunk.value;
    }
    const events = all.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.at(-2).progress.phase, 'check');
    assert.equal(events.at(-1).type, 'result');
    assert.equal(simulate(events.at(-1).bundle).status, 'ready');
  } finally {
    finishModel();
    server.closeAllConnections();
    server.close();
  }
});
