import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as request } from 'undici';

export type Page = { url: string; title: string; text: string };
export type Providers = {
  search(query: string): Promise<string[]>;
  read(url: string): Promise<Page>;
  complete(instructions: string, data: string): Promise<unknown>;
};

const maxPageBytes = 2_000_000;
export const normalizeText = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

function isPublicAddress(address: string) {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

function publicHttpUrl(input: string) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Only public HTTP(S) sources on standard ports are accepted');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname.includes('.') && !isIP(hostname)) throw new Error('Source must use a public host');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Source address is not public');
  url.hash = '';
  return url;
}

// Resolve at connection time to enforce the same policy after redirects and DNS changes.
const publicAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
        if (error) return callback(error, '', 0);
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          return callback(Object.assign(new Error('Source address is not public'), { code: 'ENETUNREACH' }), '', 0);
        }
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});

function decodePage(bytes: Uint8Array<ArrayBuffer>, contentType: string) {
  const header = contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const preview = new TextDecoder().decode(bytes.subarray(0, 2048));
  const meta = preview.match(/<meta[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1];
  try { return new TextDecoder(header ?? meta ?? 'utf-8').decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}

export async function readPublicPage(input: string): Promise<Page> {
  let url = publicHttpUrl(input);
  const signal = AbortSignal.timeout(12_000);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const result = await request(url, {
      dispatcher: publicAgent, redirect: 'manual', signal,
      headers: { 'user-agent': 'HistoryRewritten/0.1 (historical research)', accept: 'text/html,text/plain' },
    });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get('location');
      await result.body?.cancel();
      if (!location) throw new Error('Redirect has no destination');
      url = publicHttpUrl(new URL(location, url).href);
      continue;
    }
    const contentType = result.headers.get('content-type') ?? '';
    if (!result.ok || !result.body || !/^(text\/(html|plain)|application\/xhtml\+xml)\b/i.test(contentType) ||
        Number(result.headers.get('content-length')) > maxPageBytes) {
      await result.body?.cancel();
      throw new Error('Source is unavailable or not a supported text page');
    }
    const reader = result.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxPageBytes) {
        await reader.cancel();
        throw new Error('Source exceeds the download limit');
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const decoded = decodePage(bytes, contentType);
    if (contentType.includes('text/plain')) return { title: url.hostname, url: url.href, text: normalizeText(decoded) };
    const $ = load(decoded);
    const title = normalizeText($('title').first().text()) || url.hostname;
    $('script,style,noscript,template,nav,footer,aside,[aria-hidden=true]').remove();
    const main = $('article, main, [role=main]').first();
    const readable = main.length && main.text().length > 250 ? main : $('body');
    readable.find('p,li,h1,h2,h3,h4,tr,br').append(' ');
    return { title, url: url.href, text: normalizeText(readable.text()) };
  }
  throw new Error('Too many source redirects');
}

export function configureProviders(env: NodeJS.ProcessEnv = process.env): Providers {
  const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim();
  return {
    async search(query) {
      if (!braveKey) throw new Error('BRAVE_SEARCH_API_KEY is required for automatic search');
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', '6');
      const response = await fetch(url, {
        headers: { 'X-Subscription-Token': braveKey, accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Brave Search returned HTTP ' + response.status);
      const data = await response.json() as { web?: { results?: Array<{ url?: string }> } };
      return data.web?.results?.flatMap((item) => typeof item.url === 'string' ? [item.url] : []) ?? [];
    },
    read: readPublicPage,
    async complete(instructions, data) {
      if (!model || (!apiKey && baseUrl === 'https://api.openai.com/v1')) {
        throw new Error('Configure OPENAI_MODEL and the credentials for OPENAI_BASE_URL');
      }
      const response = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify({
          model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: data }],
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error('Model provider returned HTTP ' + response.status);
      const dataObject = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const output = dataObject.choices?.[0]?.message?.content;
      if (!output) throw new Error('Model provider did not return a JSON object');
      return JSON.parse(output) as unknown;
    },
  };
}
