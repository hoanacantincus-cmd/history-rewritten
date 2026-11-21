import { load } from 'cheerio/slim';
import { configureHttpProviders, normalizeText, userAgent } from './provider-core.ts';
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

export async function reserveRun(env: PublicEnvironment, request: Request, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const globalLimit = limit(env.PUBLIC_DAILY_LIMIT, 12, 100);
  const clientLimit = Math.min(globalLimit, limit(env.PUBLIC_CLIENT_DAILY_LIMIT, 3, 20));
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw', encoder.encode('history-rewritten-quota:' + (env.DEEPSEEK_API_KEY ?? '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(date + ':' + ip));
  const client = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  // A single conditional write makes admission atomic across Worker instances.
  const admitted = await env.DB!.prepare(
    'INSERT INTO public_runs (id, day, client) SELECT ?3, ?1, ?2 ' +
    'WHERE (SELECT count(*) FROM public_runs WHERE day = ?1) < ?4 ' +
    'AND (SELECT count(*) FROM public_runs WHERE day = ?1 AND client = ?2) < ?5 RETURNING id',
  ).bind(date, client, crypto.randomUUID(), globalLimit, clientLimit).first<{ id: string }>();
  const retryAfter = Math.ceil((Date.parse(date + 'T00:00:00Z') + 86_400_000 - now.getTime()) / 1000);
  return { allowed: Boolean(admitted), retryAfter };
}

export function publicFetch(provide: (env: PublicEnvironment, signal: AbortSignal) => Providers = (env, signal) => configureHttpProviders({
  OPENAI_BASE_URL: 'https://api.deepseek.com',
  OPENAI_API_KEY: env.DEEPSEEK_API_KEY,
  OPENAI_MODEL: env.DEEPSEEK_MODEL || 'deepseek-flash',
}, (url) => readArchive(url, signal), signal)) {
  return async (request: Request, env: PublicEnvironment): Promise<Response> => {
    const route = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (origin === siteOrigin) cors.set('Access-Control-Allow-Origin', siteOrigin);
    const send = (data: unknown, status = 200, extra?: Record<string, string>) => Response.json(data, {
      status, headers: { ...Object.fromEntries(cors), ...(extra ?? {}) },
    });
    if (route.pathname === '/' && request.method === 'GET') return Response.redirect(siteUrl, 302);
    if (origin && origin !== siteOrigin) return send({ error: '请从历史改写公开页发起请求。' }, 403);
    if (request.method === 'OPTIONS' && ['/api/status', '/api/research'].includes(route.pathname)) {
      cors.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      cors.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
      cors.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers: cors });
    }
    const ready = Boolean(env.DB && env.DEEPSEEK_API_KEY?.trim());
    if (route.pathname === '/api/status' && request.method === 'GET') return send({ mode: 'public', ready }, ready ? 200 : 503);
    if (route.pathname !== '/api/research' || request.method !== 'POST') return send({ error: 'Not found' }, 404);
    if (origin !== siteOrigin) return send({ error: '请从历史改写公开页发起请求。' }, 403);
    if (!ready) return send({ error: '公开推演服务正在准备，请稍后再试。' }, 503);
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

    try {
      const quota = await reserveRun(env, request);
      if (!quota.allowed) return send({ error: '今日公开推演额度已用完，案例仍可复算。' }, 429, { 'Retry-After': String(quota.retryAfter) });
    } catch { return send({ error: '公开服务的用量控制暂不可用，请稍后重试。' }, 503); }

    const body = new TransformStream<Uint8Array>();
    const writer = body.writable.getWriter();
    const encoder = new TextEncoder();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal, AbortSignal.timeout(180_000)]);
    const emit = (event: unknown) =>
      writer.write(encoder.encode(JSON.stringify(event) + '\n')).catch(() => cancellation.abort());
    void (async () => {
      try {
        const bundle = await research(question.data, provide(env, signal), undefined,
          (progress) => { void emit({ type: 'progress', progress }); });
        await emit({ type: 'result', bundle });
      } catch {
        await emit({ type: 'error', error: '暂时无法完成该问题的史料检索或建模，请稍后重试。' });
      } finally { await writer.close().catch(() => undefined); }
    })();
    cors.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    return new Response(body.readable, { headers: cors });
  };
}

export default { fetch: publicFetch() };
