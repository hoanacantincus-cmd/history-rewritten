import { jsonrepair } from 'jsonrepair';

export type Page = { url: string; title: string; text: string; references?: string[] };
export type Providers = {
  search(query: string): Promise<string[]>;
  read(url: string): Promise<Page>;
  complete(instructions: string, data: string, schema?: Record<string, unknown>): Promise<unknown>;
};

export const userAgent = 'HistoryRewritten/0.1 (https://github.com/hoanacantincus-cmd/history-rewritten)';
export const normalizeText = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

// Some compatible endpoints return a complete JSON object followed by another object or a fence.
export function decodeCompletion(content: string): unknown {
  try { return JSON.parse(content) as unknown; }
  catch (original) {
    const start = content.indexOf('{');
    let depth = 0;
    let quoted = false;
    let escape = false;
    for (let i = start; i >= 0 && i < content.length; i++) {
      const char = content[i];
      if (quoted) {
        if (escape) escape = false;
        else if (char === '\\') escape = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        const object = content.slice(start, i + 1);
        try { return JSON.parse(object) as unknown; }
        catch { return JSON.parse(jsonrepair(object)) as unknown; }
      }
    }
    // The provider has reported completed responses with the nested model closed
    // but without the final envelope brace. The caller still validates the full schema.
    if (depth === 1 && !quoted && content.trimEnd().endsWith('}')) {
      const object = content.slice(start) + '}';
      try { return JSON.parse(object) as unknown; }
      catch { return JSON.parse(jsonrepair(object)) as unknown; }
    }
    throw original;
  }
}

export async function searchWikimedia(query: string, signal?: AbortSignal): Promise<string[]> {
  const language = /\p{Script=Han}/u.test(query) ? 'zh' : 'en';
  const indexes = ['wikisource.org', 'wikipedia.org'];
  const results = await Promise.allSettled(indexes.map(async (domain) => {
    const url = new URL('https://' + language + '.' + domain + '/w/api.php');
    for (const [key, value] of Object.entries({
      action: 'query', list: 'search', srsearch: query, srnamespace: '0', srlimit: '3', format: 'json',
    })) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Wikimedia returned HTTP ' + response.status);
    const data = await response.json() as { query?: { search?: { pageid: number }[] } };
    return (data.query?.search ?? []).filter(({ pageid }) => Number.isInteger(pageid) && pageid > 0)
      .map(({ pageid }) => url.origin + '/?curid=' + pageid);
  }));
  const pages = results.map((result) => result.status === 'fulfilled' ? result.value : []);
  const urls = [0, 1, 2].flatMap((i) => pages.flatMap((hits) => hits[i] ? [hits[i]] : []));
  if (!urls.length && results.every((result) => result.status === 'rejected')) {
    throw new Error('Wikimedia search is temporarily unavailable. A configured Brave Search service can also be used.');
  }
  return urls;
}

export function configureHttpProviders(env: Record<string, string | undefined>, read: Providers['read'], signal?: AbortSignal): Providers {
  const deadline = (ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim();
  const isDeepSeek = /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl);
  return {
    async search(query) {
      if (!braveKey) return searchWikimedia(query, signal);
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', '6');
      const response = await fetch(url, {
        headers: { 'X-Subscription-Token': braveKey, accept: 'application/json' }, signal: deadline(15_000),
      });
      if (!response.ok) throw new Error('Brave Search returned HTTP ' + response.status);
      const data = await response.json() as { web?: { results?: Array<{ url?: string }> } };
      return data.web?.results?.flatMap((item) => typeof item.url === 'string' ? [item.url] : []) ?? [];
    },
    read,
    async complete(instructions, data, schema) {
      if (!model || (!apiKey && baseUrl === 'https://api.openai.com/v1')) {
        throw new Error('Configure OPENAI_MODEL and the credentials for OPENAI_BASE_URL');
      }
      const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) };
      if (schema && isDeepSeek) {
        const response = await fetch(new URL('/responses', baseUrl), {
          method: 'POST', headers, signal: deadline(120_000),
          body: JSON.stringify({
            model, instructions, input: data, reasoning: { effort: 'none' }, max_output_tokens: 8000,
            text: { format: { type: 'json_schema', name: 'historical_analysis', schema } },
          }),
        });
        if (response.ok) {
          const body = await response.json() as {
            status?: string;
            output?: { type: string; content?: { type: string; text: string }[] }[];
          };
          const output = body.output?.filter(({ type }) => type === 'message')
            .flatMap(({ content }) => (content ?? []).filter(({ type }) => type === 'output_text'))
            .map(({ text }) => text).join('');
          if (body.status !== 'completed' || !output?.trim()) throw new Error('DeepSeek did not complete its structured response');
          return decodeCompletion(output);
        }
        await response.body?.cancel();
        if (response.status !== 400 && response.status !== 404) {
          throw new Error('DeepSeek structured model returned HTTP ' + response.status);
        }
      }
      const response = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: data }],
          response_format: { type: 'json_object' },
          ...(isDeepSeek ? { thinking: { type: 'disabled' }, max_tokens: 6000 } : {}),
        }),
        signal: deadline(90_000),
      });
      if (!response.ok) throw new Error('Model provider returned HTTP ' + response.status);
      const dataObject = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
      if (dataObject.choices?.[0]?.finish_reason === 'length') throw new Error('Model response exceeded its output limit');
      const output = dataObject.choices?.[0]?.message?.content;
      if (!output?.trim()) throw new Error('Model provider did not return a JSON object');
      return decodeCompletion(output);
    },
  };
}
