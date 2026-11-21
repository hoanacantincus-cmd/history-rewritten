import { load } from 'cheerio/slim';
import { ModelProviderError, normalizeText, userAgent } from './provider-core.ts';
import { personalProviders } from './personal-providers.ts';
import { isPersonalModel, personalModels } from './personal-models.ts';
import type { PersonalModel } from './personal-models.ts';
import type { Page, Providers } from './provider-core.ts';
import { research } from './research.ts';
import { requestSchema } from './schema.ts';

const siteOrigin = 'https://hoanacantincus-cmd.github.io';
const siteUrl = siteOrigin + '/history-rewritten/';
const allowedArchives = new Set([
  'www.archives.gov', 'archives.gov', 'www.loc.gov', 'loc.gov', 'history.state.gov',
  'www.parliament.uk', 'hansard.parliament.uk', 'api.parliament.uk', 'www.un.org',
  'treaties.un.org', 'avalon.law.yale.edu', 'www.dpm.org.cn', 'ctext.org',
  'www.shidianguji.com', 'www.britishmuseum.org', 'www.nationalarchives.gov.uk',
  'psl.noaa.gov', 'www.ncei.noaa.gov', 'www.ecmwf.int',
]);
const maxSourceBytes = 680_000;

export function archiveUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      (!/^[a-z0-9-]+(?:\.m)?\.(?:wikipedia|wikisource)\.org$/i.test(url.hostname) && !allowedArchives.has(url.hostname))) {
    throw new Error('Source is outside the public archive collection');
  }
  url.hash = '';
  return url;
}

async function readArchive(input: string, cancellation: AbortSignal): Promise<Page> {
  let url = archiveUrl(input);
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(12_000)]);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetch(url, {
      redirect: 'manual', signal, headers: { 'User-Agent': userAgent, Accept: 'text/html,text/plain' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Archive redirect has no destination');
      url = archiveUrl(new URL(location, url).href);
      continue;
    }
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !response.body || !/^(text\/(html|plain)|application\/xhtml\+xml)\b/i.test(type)) {
      await response.body?.cancel();
      throw new Error('Archive text is unavailable');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    while (size < maxSourceBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maxSourceBytes - size;
      text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      size += chunk.value.length;
    }
    if (size >= maxSourceBytes) await reader.cancel();
    text += decoder.decode();
    if (/^text\/plain/i.test(type)) return { url: url.href, title: url.hostname, text: normalizeText(text).slice(0, 12_000) };

    const $ = load(text);
    const title = normalizeText($('title').first().text()) || url.hostname;
    if (/verification required|checking your browser|access denied|just a moment/i.test(title)) throw new Error('Archive requires a browser');
    const references = url.hostname.endsWith('.wikipedia.org')
      ? $('span.reference-text a.external, .mw-reference-text a.external').map((_, link) => $(link).attr('href')).get()
      : [];
    $('script,style,noscript,template,nav,footer,aside,[aria-hidden=true]').remove();
    const article = $('.mw-parser-output, article, main, [role=main]').first();
    const content = article.length ? article : $('body');
    content.find('p,li,h1,h2,h3,h4,td,th,tr,br').append(' ');
    return { url: url.href, title, text: normalizeText(content.text()).slice(0, 12_000), references };
  }
  throw new Error('Too many archive redirects');
}

type QuotaDatabase = {
  prepare(sql: string): { bind(...values: (string | number)[]): { first<T>(): Promise<T | null> } };
};

export type PublicEnvironment = {
  DB?: QuotaDatabase;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  PUBLIC_DAILY_LIMIT?: string;
  PUBLIC_CLIENT_DAILY_LIMIT?: string;
};

function limit(value: string | undefined, fallback: number, maximum: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= maximum ? number : fallback;
}

async function quotaFor(env: PublicEnvironment, request: Request, now: Date) {
  const day = now.toISOString().slice(0, 10);
  const reset = Date.parse(day + 'T00:00:00Z') + 86_400_000;
  const globalLimit = limit(env.PUBLIC_DAILY_LIMIT, 12, 100);
  const ip = request.headers.get('CF-Connecting-IP')?.trim();
  const clientLimit = ip ? Math.min(globalLimit, limit(env.PUBLIC_CLIENT_DAILY_LIMIT, 6, 20)) : null;
  let client = 'unidentified';
  if (ip) {
    const encoder = new TextEncoder();
    const secret = await crypto.subtle.importKey('raw', encoder.encode('history-rewritten-quota:' + (env.DEEPSEEK_API_KEY ?? '')),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(day + ':' + ip));
    client = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return { day, client, globalLimit, clientLimit, resetAt: new Date(reset).toISOString(),
    retryAfter: Math.ceil((reset - now.getTime()) / 1000) };
}

async function remainingQuota(db: QuotaDatabase, quota: Awaited<ReturnType<typeof quotaFor>>) {
  const counts = await db.prepare(
    'SELECT count(*) AS total, count(CASE WHEN client = ?2 THEN 1 END) AS network FROM public_runs WHERE day = ?1',
  ).bind(quota.day, quota.client).first<{ total: number; network: number }>();
  if (!counts) throw new Error('Daily totals unavailable');
  return {
    globalRemaining: Math.max(0, quota.globalLimit - counts.total),
    networkRemaining: quota.clientLimit === null ? null : Math.max(0, quota.clientLimit - counts.network),
    resetAt: quota.resetAt,
  };
}

export async function reserveRun(env: PublicEnvironment, request: Request, now = new Date()) {
  const quota = await quotaFor(env, request, now);
  // A single conditional write makes admission atomic across Worker instances.
  const admitted = await env.DB!.prepare(
    'INSERT INTO public_runs (id, day, client) SELECT ?3, ?1, ?2 ' +
    'WHERE (SELECT count(*) FROM public_runs WHERE day = ?1) < ?4 ' +
    'AND (SELECT count(*) FROM public_runs WHERE day = ?1 AND client = ?2) < ?5 RETURNING id',
  ).bind(quota.day, quota.client, crypto.randomUUID(), quota.globalLimit, quota.clientLimit ?? quota.globalLimit)
    .first<{ id: string }>();
  if (admitted) return { allowed: true as const };
  const remaining = await remainingQuota(env.DB!, quota);
  return {
    allowed: false as const,
    scope: remaining.globalRemaining === 0 ? 'global' : 'network',
    resetAt: quota.resetAt, retryAfter: quota.retryAfter,
  };
}

const personalKeyErrors: Record<number, string> = {
  401: '未接受此 API Key，请确认供应商和密钥。',
  402: '账户余额不足，请检查余额。',
  403: '拒绝了此请求，请检查密钥权限或账户设置。',
  429: '账户请求达到上限，请稍后再试。',
};

type Provide = (key: string, model: string | undefined, signal: AbortSignal, provider: PersonalModel) => Providers;

export function publicFetch(provide: Provide = (key, model, signal, provider) =>
  personalProviders(provider, key, model, (url) => readArchive(url, signal), signal)) {
  return async (request: Request, env: PublicEnvironment): Promise<Response> => {
    const route = new URL(request.url);
    const useOwnKey = route.pathname === '/api/research/personal';
    const origin = request.headers.get('Origin');
    const cors = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (origin === siteOrigin) cors.set('Access-Control-Allow-Origin', siteOrigin);
    const send = (data: unknown, status = 200, extra?: Record<string, string>) => Response.json(data, {
      status, headers: { ...Object.fromEntries(cors), ...(extra ?? {}) },
    });
    if (route.pathname === '/' && request.method === 'GET') return Response.redirect(siteUrl, 302);
    if (origin && origin !== siteOrigin) return send({ error: '请从历史改写公开页发起请求。' }, 403);
    if (request.method === 'OPTIONS' && (useOwnKey || ['/api/status', '/api/research'].includes(route.pathname))) {
      cors.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      cors.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
      cors.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers: cors });
    }
    const ready = Boolean(env.DB && env.DEEPSEEK_API_KEY?.trim());
    if (route.pathname === '/api/status' && request.method === 'GET') {
      if (!ready || !env.DB) return send({ mode: 'public', ready: false }, 503);
      try {
        const quota = await remainingQuota(env.DB, await quotaFor(env, request, new Date()));
        return send({ mode: 'public', ready: true, quota });
      } catch { return send({ mode: 'public', ready: false }, 503); }
    }
    if ((!useOwnKey && route.pathname !== '/api/research') || request.method !== 'POST') return send({ error: 'Not found' }, 404);
    if (origin !== siteOrigin) return send({ error: '请从历史改写公开页发起请求。' }, 403);
    const provider = useOwnKey ? route.searchParams.get('provider') ?? 'deepseek' : 'deepseek';
    if (!isPersonalModel(provider)) return send({ error: '请选择受支持的模型供应商。' }, 400);
    const authorization = request.headers.get('Authorization');
    const personalKey = authorization?.match(/^Bearer ([A-Za-z0-9._~+/-]{12,512}={0,2})$/i)?.[1];
    if (useOwnKey && !personalKey) return send({ error: '请检查填写的 API Key。' }, 400);
    if (!useOwnKey && authorization !== null) return send({ error: '请使用个人密钥推演入口。' }, 400);
    if (!personalKey && !ready) return send({ error: '公共推演暂不可用。', canUseOwnKey: true }, 503);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
      return send({ error: '需要 JSON 请求。' }, 415);
    }

    let data: unknown;
    try {
      const reader = request.body?.getReader();
      if (!reader) return send({ error: '请填写历史问题。' }, 400);
      const decoder = new TextDecoder();
      let text = '';
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > 6000) {
          await reader.cancel();
          return send({ error: '问题太长，请缩短后再试。' }, 413);
        }
        text += decoder.decode(result.value, { stream: true });
      }
      data = JSON.parse(text + decoder.decode());
    } catch { return send({ error: '请求格式有误。' }, 400); }
    if (!data || typeof data !== 'object' || Object.keys(data).some((key) => key !== 'question')) {
      return send({ error: '公开推演只接收问题正文。' }, 400);
    }
    const question = requestSchema.safeParse(data);
    if (!question.success) return send({ error: '请填写一句历史问题。' }, 400);

    if (!personalKey) {
      try {
        const quota = await reserveRun(env, request);
        if (!quota.allowed) {
          const error = quota.scope === 'global' ? '今天的全站推演额度已用完。' : '当前网络今天的推演额度已用完。';
          return send({ error, scope: quota.scope, resetAt: quota.resetAt, canUseOwnKey: true }, 429,
            { 'Retry-After': String(quota.retryAfter) });
        }
      } catch { return send({ error: '公共额度暂时无法核对。', canUseOwnKey: true }, 503); }
    }

    const body = new TransformStream<Uint8Array>();
    const writer = body.writable.getWriter();
    const encoder = new TextEncoder();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal, AbortSignal.timeout(180_000)]);
    const emit = (event: unknown) =>
      writer.write(encoder.encode(JSON.stringify(event) + '\n')).catch(() => cancellation.abort());
    void (async () => {
      try {
        const key = personalKey ?? env.DEEPSEEK_API_KEY!;
        const bundle = await research(question.data, provide(key, env.DEEPSEEK_MODEL, signal, provider), undefined,
          (progress) => { void emit({ type: 'progress', progress }); });
        await emit({ type: 'result', bundle });
      } catch (error) {
        if (error instanceof ModelProviderError && error.needsAccountAction) {
          await emit({ type: 'error', error: personalKey ? personalModels[provider] + personalKeyErrors[error.status] : '公共推演的模型暂不可用。',
            canUseOwnKey: !personalKey });
        } else {
          await emit({ type: 'error', error: '暂时无法完成该问题的史料检索或建模，请稍后重试。' });
        }
      } finally { await writer.close().catch(() => undefined); }
    })();
    cors.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    return new Response(body.readable, { headers: cors });
  };
}

export default { fetch: publicFetch() };
