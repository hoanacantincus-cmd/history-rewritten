import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { research } from '../src/research.ts';
import { decodeCompletion, readPublicPage } from '../src/providers.ts';
import type { Providers } from '../src/providers.ts';
import { exportAnalysis, simulate } from '../src/engine.ts';
import type { Draft } from '../src/schema.ts';
import { createApp } from '../src/server.ts';
import { configureHttpProviders, ModelProviderError } from '../src/provider-core.ts';
import { detectKeyProvider } from '../src/personal-models.ts';
import { personalProviders } from '../src/personal-providers.ts';
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
      const draft = reply as Draft;
      if (instructions.startsWith('Return JSON with title')) return { title: input.question, queries: [input.question] };
      if (instructions.startsWith('Return JSON evidence dossier')) {
        const input = JSON.parse(data) as { excerpts: { id: string; source: string; text: string }[] };
        return { start: 'First phase', end: 'Last phase', interpretation: 'A bounded synthetic intervention',
          claims: draft.claims.filter(({ citations }) => citations.length).map((claim) => ({
            id: claim.id, text: claim.text, scope: claim.scope, when: 'Recorded date',
            anchors: claim.citations.map((citation) => input.excerpts.find(({ source, text }) =>
              source === citation.source && text.includes(citation.quote))?.id ?? 'unavailable-anchor'),
          })),
        };
      }
      if (instructions.startsWith('Return JSON evidence review')) {
        const review = JSON.parse(data) as { claims: { claim: { id: string } }[] };
        return { findings: review.claims.map(({ claim: { id } }) =>
          ({ id, verdict: draft.claims.find((claim) => claim.id === id)?.status })) };
      }
      if (instructions.startsWith('Return JSON historical observations')) return { observations: [] };
      if (instructions.startsWith('Return JSON intervention audit')) return { accepted: true, issues: [] };
      return structuredClone(reply);
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
  assert.match(unverified.gaps.join(' '), /未能通过原文或含义核对/);
  const driver = providers(modeled('Submitted'));
  driver.search = async () => { throw new Error('Search unavailable'); };
  const bundle = await research({ question: 'Submitted source', sources: [{ url: sourceUrl, excerpt: quote }] }, driver);
  assert.equal(bundle.sources[0].origin, 'user');
  assert.match(bundle.gaps.join(' '), /用户提供/);
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
    if (instructions.startsWith('Return one JSON object')) await gate;
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
    assert.equal(events.at(-2).progress.phase, 'simulate');
    assert.equal(events.find((item) => item.progress?.simulation)?.progress.simulation.runs, 2);
    assert.ok(events.some((item) => item.progress?.round?.branch === 'change'));
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
  assert.deepEqual(await reserveRun(env, publicRequest('198.51.100.3'), now), { allowed: false, scope: 'global', resetAt: '2026-11-22T00:00:00.000Z', retryAfter: 10 });
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
  assert.deepEqual([...new Set(records.filter((row) => row.type === 'progress').map((row) => row.progress.phase))], ['identify', 'evidence', 'model', 'check', 'simulate']);
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

test('public quota recovery preserves remaining shared capacity and explains the scope of a denial', async (t) => {
  const env = { DB: publicTestDb(t), DEEPSEEK_API_KEY: 'fixture' };
  const fetch = publicFetch(() => providers(modeled('Quota fixture')));
  const client = '198.51.100.1';
  const status = (ip?: string) => fetch(new Request('https://worker.example/api/status', {
    headers: { Origin: publishedOrigin, ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
  }), env);
  for (let i = 0; i < 3; i++) assert.equal((await reserveRun(env, publicRequest(client))).allowed, true);
  const afterTests = await (await status(client)).json();
  assert.equal(afterTests.quota.networkRemaining, 3);
  assert.equal(afterTests.quota.globalRemaining, 9);
  for (let i = 0; i < 3; i++) assert.equal((await reserveRun(env, publicRequest(client))).allowed, true);
  const network = await fetch(publicRequest(client), env);
  assert.equal(network.status, 429);
  assert.equal((await network.json()).scope, 'network');

  const anonymous = publicRequest('');
  anonymous.headers.delete('CF-Connecting-IP');
  for (let i = 0; i < 6; i++) assert.equal((await reserveRun(env, anonymous)).allowed, true);
  const global = await fetch(publicRequest('198.51.100.2'), env);
  assert.equal(global.status, 429);
  const error = await global.json();
  assert.equal(error.scope, 'global');
  assert.ok(Date.parse(error.resetAt) > Date.now());
  assert.equal((await (await status()).json()).quota.networkRemaining, null);
});

test('a visitor key bypasses the public budget and is never replaced with the owner key', async (t) => {
  const visitorKey = 'sk-fixture-visitor-0001';
  const env = { DB: publicTestDb(t), DEEPSEEK_API_KEY: 'sk-fixture-owner-00001', PUBLIC_DAILY_LIMIT: '1' };
  const calls: string[] = [];
  const fetch = publicFetch((key) => {
    calls.push(key);
    return providers(modeled('Personal-key replay'));
  });
  const request = () => publicRequest('198.51.100.1');
  const signed = async (key?: string) => {
    const base = request();
    if (key !== undefined) base.headers.set('Authorization', 'Bearer ' + key);
    return new Request(publicApiUrl + '/personal', { method: 'POST', headers: base.headers, body: await base.text() });
  };
  const preflight = await fetch(new Request(publicApiUrl + '/personal', {
    method: 'OPTIONS', headers: { Origin: publishedOrigin, 'Access-Control-Request-Headers': 'authorization,content-type' },
  }), env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/i);

  assert.equal((await fetch(await signed(), env)).status, 400);
  assert.equal((await fetch(await signed('invalid key'), env)).status, 400);
  assert.equal(calls.length, 0);
  const personalFirst = await fetch(await signed(visitorKey), {});
  const document = await personalFirst.text();
  assert.match(document, /"type":"result"/);
  assert.ok(!document.includes(visitorKey));

  await (await fetch(request(), env)).text();
  const exhausted = await fetch(request(), env);
  assert.equal(exhausted.status, 429);
  assert.equal((await exhausted.json()).canUseOwnKey, true);

  assert.match(await (await fetch(await signed(visitorKey), env)).text(), /"type":"result"/);
  assert.deepEqual(calls, [visitorKey, env.DEEPSEEK_API_KEY, visitorKey]);
});

test('a rejected personal key surfaces the provider error and never uses the public account', async () => {
  const requestedKey = 'sk-fixture-rejected-0001';
  let completions = 0;
  const fetch = publicFetch((key) => {
    assert.equal(key, requestedKey);
    const driver = providers(modeled('Rejected'));
    const complete = driver.complete;
    driver.complete = async (...parameters) => {
      completions++;
      if (completions === 2) throw new ModelProviderError(402);
      return complete(...parameters);
    };
    return driver;
  });
  const response = await fetch(new Request(publicApiUrl + '/personal', {
    method: 'POST', headers: { Origin: publishedOrigin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + requestedKey },
    body: JSON.stringify({ question: '如果独立公投延后会怎样？' }),
  }), {});
  const text = await response.text();
  assert.match(text, /DeepSeek账户余额不足/);
  assert.ok(!text.includes(requestedKey) && !text.includes('"type":"result"'));
  assert.equal(completions, 2);
});

test('DeepSeek provider rejects redirects without forwarding the bearer token', async (t) => {
  const key = 'sk-fixture-redirect-0001';
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    seen.push(String(url));
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + key);
    return new Response(null, { status: 307, headers: { Location: 'https://foreign.example/chat/completions' } });
  });
  const driver = configureHttpProviders({ OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_MODEL: 'deepseek-flash', OPENAI_API_KEY: key }, async () => { throw new Error('Unexpected source read'); });
  await assert.rejects(driver.complete('Return JSON', '{}'), ModelProviderError);
  await assert.rejects(driver.complete('Return JSON', '{}', {}), ModelProviderError);
  assert.deepEqual(seen, ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/responses']);
});

test('personal provider recognition never guesses among overlapping keys', () => {
  assert.equal(detectKeyProvider('sk-ant-fixture'), 'anthropic');
  assert.equal(detectKeyProvider('sk-proj-fixture'), 'openai');
  assert.equal(detectKeyProvider('AIzaFixtureKey'), 'gemini');
  assert.equal(detectKeyProvider('AQ.fixture'), 'gemini');
  assert.equal(detectKeyProvider('xai-fixture'), 'grok');
  assert.equal(detectKeyProvider('sk-or-v1-fixture'), 'openrouter');
  assert.equal(detectKeyProvider('sk-1234567890abcdef1234567890abcdef'), undefined);
});

test('personal providers send their keys only to the selected provider using its native credentials', async (t) => {
  const key = 'sk-fixture-credential-001';
  const fixtures = [
    ['openai', 'api.openai.com', 'Authorization'],
    ['anthropic', 'api.anthropic.com', 'x-api-key'],
    ['gemini', 'generativelanguage.googleapis.com', 'x-goog-api-key'],
    ['deepseek', 'api.deepseek.com', 'Authorization'],
    ['qwen', 'dashscope.aliyuncs.com', 'Authorization'],
    ['qwen-intl', 'dashscope-intl.aliyuncs.com', 'Authorization'],
    ['kimi', 'api.moonshot.cn', 'Authorization'],
    ['kimi-intl', 'api.moonshot.ai', 'Authorization'],
    ['grok', 'api.x.ai', 'Authorization'],
    ['openrouter', 'openrouter.ai', 'Authorization'],
  ] as const;
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    const [driver, domain, name] = fixtures[index++];
    const endpoint = new URL(url);
    assert.equal(endpoint.hostname, domain);
    assert.equal(endpoint.search, '');
    assert.equal(new Headers(init.headers).get(name), name === 'Authorization' ? 'Bearer ' + key : key);
    assert.equal(init.redirect, 'manual');
    assert.ok(!String(init.body).includes(key));
    const json = '{"ok":true}';
    if (driver === 'anthropic') return Response.json({ content: [{ type: 'text', text: json }] });
    if (driver === 'gemini') return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: json }] } }] });
    return Response.json({ choices: [{ message: { content: json } }] });
  });
  for (const [provider] of fixtures) {
    const providers = personalProviders(provider, key, undefined, async () => { throw new Error('Unexpected archive read'); }, new AbortController().signal);
    assert.deepEqual(await providers.complete('Return JSON', '{}'), { ok: true });
  }
  assert.equal(index, fixtures.length);
});

test('Grok and Gemini invalid-key responses are reported as authentication failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => Response.json(
    new URL(url).hostname === 'api.x.ai' ? { code: 'invalid-argument', error: 'Incorrect API key provided.' } :
      { error: { details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 },
  ));
  for (const provider of ['grok', 'gemini'] as const) {
    const driver = personalProviders(provider, 'fixture', undefined, async () => { throw new Error('Unexpected source read'); }, new AbortController().signal);
    await assert.rejects(driver.complete('Return JSON', '{}'), { status: 401 });
  }
});

test('held-out evidence is absent from model prompts and audited against the frozen factual scenario', async () => {
  const afterQuote = 'Independent record: the later outcome was unchanged.';
  const fixture = modeled('Frozen counterfactual');
  const draft = { ...fixture, claims: [...fixture.claims, {
    id: 'later', text: 'Held-out outcome sentinel', status: 'supported', scope: 'observed',
    citations: [{ source: 'source-1', locator: 'Record 2', quote: afterQuote }],
  }] };
  const driver = providers(draft, quote + ' ' + afterQuote);
  const complete = driver.complete;
  let modelBuilt = false;
  driver.complete = async (instructions, payload, schema) => {
    if (instructions.startsWith('Return one JSON object')) {
      assert.ok(!payload.includes('Held-out outcome sentinel') && !payload.includes(afterQuote));
      modelBuilt = true;
    }
    if (instructions.startsWith('Return JSON historical observations')) {
      assert.ok(modelBuilt && payload.includes('Held-out outcome sentinel') && payload.includes(afterQuote));
      return { observations: [{ step: 1, field: 'ending', value: 'unchanged', basis: ['later'] }] };
    }
    return complete(instructions, payload, schema);
  };
  const bundle = await research({ question: 'What if the action changed?' }, driver);
  assert.equal(bundle.schemaVersion, 3);
  assert.equal(bundle.audit?.historicalScenario, 'historical-context');
  const calc = simulate(bundle);
  assert.equal(calc.historicalAudit?.status, 'consistent');
  assert.equal(calc.historicalAudit?.divergence?.step, 1);
  assert.equal(calc.forecast?.baseline, 'consistent');
  assert.deepEqual(simulate(exportAnalysis(bundle)), calc);

  bundle.audit!.observations[0].value = 'changed';
  assert.equal(simulate(bundle).forecast?.baseline, 'disagrees');
});

test('a matching quote rejected by the independent evidence check cannot seed a model', async () => {
  const driver = providers(modeled('Semantically unrelated claim'));
  const original = driver.complete;
  driver.complete = async (instructions, payload, schema) => {
    if (instructions.startsWith('Return JSON evidence review')) return { findings: [{ id: 'anchor', verdict: 'rejected' }] };
    if (instructions.startsWith('Return one JSON object')) throw new Error('Modeling ran without any verified context');
    return original(instructions, payload, schema);
  };
  const bundle = await research({ question: 'What if the decision changed?' }, driver);
  assert.equal(bundle.status, 'insufficient');
  assert.equal(bundle.model, null);
  assert.match(bundle.gaps.join(' '), /未能通过原文或含义核对/);
});

test('another scenario matching the archive cannot rescue a mismatching locked baseline', async () => {
  const keyResult = modeled('Alternative scenarios');
  const afterQuote = 'The outcome was officially described as changed after the decision.';
  const draft = { ...keyResult, claims: [...keyResult.claims, {
    id: 'later', text: 'The observed outcome was changed', status: 'supported', scope: 'observed',
    citations: [{ source: 'source-1', locator: 'Record 2', quote: afterQuote }],
  }] };
  const driver = providers(draft, quote + ' ' + afterQuote);
  const original = driver.complete;
  driver.complete = async (instructions, payload, schema) => {
    if (instructions.startsWith('Return JSON historical observations')) {
      return { observations: [{ step: 1, field: 'ending', value: 'changed', basis: ['later'] }] };
    }
    return original(instructions, payload, schema);
  };
  const bundle = await research({ question: 'What if the decision changed?' }, driver);
  const model = bundle.model!;
  model.variables.push({ id: 'external', role: 'parameter', kind: 'boolean', label: 'External constraint', initial: false, basis: cited });
  model.scenarios.push({ id: 'edited-scenario', label: 'Different context', basis: hypothesis, parameters: { external: true } });
  model.rules[1].when = { op: 'or', args: [{ ref: 'external' }, { ref: 'action' }] };
  const result = simulate(bundle);
  assert.ok(result.runs.some(({ decision, scenario, metrics }) => decision === 'baseline' &&
    scenario === 'edited-scenario' && metrics.ending === 'changed'));
  assert.equal(result.historicalAudit?.status, 'disagrees');
  assert.equal(result.forecast?.observations, null);
});

test('a unique immutable intervention is repaired without accepting a scenario override of it', async () => {
  const draft = modeled('Explicit alternative');
  draft.model.variables[0].role = 'state';
  draft.model.scenarios = [{ id: 'wrong-override', label: 'An override of the intervention', basis: hypothesis, parameters: { action: true } }];
  const bundle = await research({ question: 'What if the action changed?' }, providers(draft));
  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.model!.variables.find(({ id }) => id === 'action')?.role, 'decision');
  assert.deepEqual(bundle.model!.scenarios.map(({ id }) => id), ['historical-context']);
  assert.equal(simulate(bundle).runs[0].metrics.ending, 'unchanged');
});

test('a later dated fact is withheld even when both model stages label it as context', async () => {
  const later = 'The trial ended on December 6 in the independent record.';
  const caseModel = modeled('Dated evidence');
  const draft = { ...caseModel, claims: [...caseModel.claims, {
    id: 'future', text: 'Distinct later event', status: 'supported', scope: 'context',
    citations: [{ source: 'source-1', locator: 'Record 2', quote: later }],
  }] };
  const driver = providers(draft, quote + ' ' + later);
  const original = driver.complete;
  driver.complete = async (instructions, payload, schema) => {
    if (instructions.startsWith('Return JSON evidence dossier')) {
      const evidence = await original(instructions, payload, schema) as {
        start: string; end: string; claims: { id: string; when: string }[];
      };
      evidence.start = '1921-07';
      evidence.end = '1921-12';
      evidence.claims.find(({ id }) => id === 'future')!.when = '1921年12月6日';
      return evidence;
    }
    if (instructions.startsWith('Return one JSON object')) assert.ok(!payload.includes('Distinct later event'));
    return original(instructions, payload, schema);
  };
  const bundle = await research({ question: 'What if the action changed?' }, driver);
  assert.equal(bundle.claims.find(({ id }) => id === 'future')?.scope, 'observed');
  assert.equal(bundle.status, 'ready');
});

test('listing actors without a recorded exchange cannot pass as a strategic simulation', async () => {
  const fixture = modeled('Nominal actors only');
  const draft = { ...fixture, model: { ...fixture.model,
    actors: [{ id: 'first', label: 'First claimant' }, { id: 'second', label: 'Second claimant' }] } };
  const bundle = await research({ question: 'What if the participants bargained?' }, providers(draft));
  assert.equal(bundle.status, 'insufficient');
  assert.match(bundle.gaps.join(' '), /no scenario records two actors/);
});

test('the limited model derives a recorded response from a sourced prerequisite', async () => {
  const draft = modeled('Cannot construct a full interaction');
  const driver = providers({ ...draft, model: null, status: 'insufficient', gaps: ['The full negotiation is unobserved.'] });
  const original = driver.complete;
  driver.complete = async (instructions, payload, schema) => {
    if (instructions.startsWith('Return one JSON object describing a two-party')) {
      return { title: 'A bounded prerequisite', scope: 'Inspect legal procedure only.',
        recorded: 'File under the original procedure', change: 'Apply under the proposed procedure', historicalBasis: 'anchor',
        proposer: { name: 'Filing party', objective: 'Submit a request', basis: 'anchor' },
        receiver: { name: 'Examining party', objective: 'Enforce the documented procedure', basis: 'anchor' },
        constraint: { label: 'Satisfy the filing deadline', explanation: 'The examiner must check timeliness.', basis: 'anchor' } };
    }
    return original(instructions, payload, schema);
  };
  const bundle = await research({ question: 'What if they changed the filing procedure?' }, driver);
  assert.equal(bundle.status, 'ready');
  assert.match(bundle.scope, /必要条件/);
  const result = simulate(bundle);
  assert.equal(result.forecast?.observations, null);
  assert.equal(result.switches.length, 1);
  assert.equal(result.switches[0].parameter, 'condition');
  assert.equal(result.runs.find(({ decision, scenario }) => decision === 'alternative' && scenario === 'fails-condition')
    ?.trace[1].actor, 'receiver');
});

test('the intervention audit can reject a structurally valid but unsupported model', async () => {
  const driver = providers(modeled('Mechanically valid but off question'));
  const original = driver.complete;
  driver.complete = async (instructions, payload, schema) => {
    if (instructions.startsWith('Return JSON intervention audit')) {
      assert.ok(!payload.includes('"observed"'));
      return { accepted: false, issues: ['The changed actor does not match the question.'] };
    }
    if (instructions.startsWith('Return JSON historical observations')) throw new Error('A rejected proposal reached history check');
    return original(instructions, payload, schema);
  };
  const bundle = await research({ question: 'What if the action changed?' }, driver);
  assert.equal(bundle.status, 'insufficient');
  assert.match(bundle.gaps.join(' '), /changed actor/);
});
