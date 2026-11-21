import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { research } from '../src/research.ts';
import { decodeCompletion, readPublicPage } from '../src/providers.ts';
import type { Providers } from '../src/providers.ts';
import { simulate } from '../src/engine.ts';
import { createApp } from '../src/server.ts';
import { publicFetch, reserveRun } from '../src/public-worker.ts';
import type { PublicEnvironment } from '../src/public-worker.ts';

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

const publishedOrigin = 'https://hoanacantincus-cmd.github.io';
const publicApiUrl = 'https://worker.example/api/research';

function publicTestDb(t: import('node:test').TestContext): PublicEnvironment['DB'] {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../drizzle/0000_public_runs.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...values) {
          const named = Object.fromEntries(values.map((value, index) => ['?' + (index + 1), value]));
          return { async first<T>() { return (statement.get(named) ?? null) as T | null; } };
        },
      };
    },
  };
}

function publicRequest(ip: string, origin = publishedOrigin, body: unknown = { question: '如果 1905 年挪威推迟独立公投，之后会怎样？' }) {
  return new Request(publicApiUrl, {
    method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('public client and shared quotas are enforced by the same SQLite statement', async (t) => {
  const env = { DB: publicTestDb(t), PUBLIC_DAILY_LIMIT: '2', PUBLIC_CLIENT_DAILY_LIMIT: '1' };
  const now = new Date('2026-11-21T23:59:50Z');
  const a = () => publicRequest('198.51.100.1');
  assert.deepEqual((await Promise.all([reserveRun(env, a(), now), reserveRun(env, a(), now)])).map((item) => item.allowed).sort(), [false, true]);
  assert.equal((await reserveRun(env, publicRequest('198.51.100.2'), now)).allowed, true);
  assert.deepEqual(await reserveRun(env, publicRequest('198.51.100.3'), now), { allowed: false, retryAfter: 10 });
  assert.equal((await reserveRun(env, a(), new Date('2026-11-22T00:00:00Z'))).allowed, true);
});

test('public endpoint accepts a custom question from Pages and streams validated research', async (t) => {
  const env = { DB: publicTestDb(t), DEEPSEEK_API_KEY: 'fixture', PUBLIC_CLIENT_DAILY_LIMIT: '1' };
  const fetch = publicFetch(() => providers(modeled('Custom Norwegian referendum')));
  const preflight = await fetch(new Request(publicApiUrl, { method: 'OPTIONS', headers: { Origin: publishedOrigin } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), publishedOrigin);
  assert.equal((await fetch(publicRequest('198.51.100.1', 'https://foreign.example'), env)).status, 403);
  assert.equal((await fetch(publicRequest('198.51.100.1', publishedOrigin, { question: 'an unfamiliar question', sources: [] }), env)).status, 400);

  const response = await fetch(publicRequest('198.51.100.1'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), publishedOrigin);
  const records = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.filter((row) => row.type === 'progress').map((row) => row.progress.phase), ['identify', 'evidence', 'model', 'check']);
  assert.equal(records.at(-1).type, 'result');
  assert.equal(records.at(-1).bundle.status, 'ready');
  const capped = await fetch(publicRequest('198.51.100.1'), env);
  assert.equal(capped.status, 429);
  assert(Number(capped.headers.get('Retry-After')) > 0);
});

test('generated forecast references resolve to an existing alternative and equivalent outcome metric', async () => {
  const draft = modeled('Forecast references');
  draft.model.forecast.decision = 'action';
  draft.model.metrics[1].id = 'final-ending';
  const bundle = await research({ question: 'If the decision changed, would the treaty pass?' }, providers(draft));
  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.model?.forecast?.decision, 'change');
  assert.equal(bundle.model?.forecast?.metric, 'final-ending');
  assert.equal(simulate(bundle).comparisons[0].delta, 1);
});
