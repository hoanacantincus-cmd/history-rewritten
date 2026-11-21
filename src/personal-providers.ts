import { configureHttpProviders, decodeCompletion, ModelProviderError, searchWikimedia } from './provider-core.ts';
import type { Providers } from './provider-core.ts';
import type { PersonalModel } from './personal-models.ts';

const chatModels = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini',
    options: { max_completion_tokens: 10_000, reasoning_effort: 'low', store: false } },
  qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-flash',
    options: { max_tokens: 8_000, enable_thinking: false } },
  'qwen-intl': { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-flash',
    options: { max_tokens: 8_000, enable_thinking: false } },
  kimi: { url: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.5',
    options: { max_tokens: 8_000, thinking: { type: 'disabled' } } },
  'kimi-intl': { url: 'https://api.moonshot.ai/v1/chat/completions', model: 'kimi-k2.5',
    options: { max_tokens: 8_000, thinking: { type: 'disabled' } } },
  grok: { url: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.3',
    options: { max_tokens: 10_000, reasoning_effort: 'low' } },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/auto',
    options: { max_tokens: 8_000, provider: { require_parameters: true } } },
} as const;

async function checkProvider(response: Response, provider: PersonalModel) {
  if (response.ok) return;
  let status = response.status;
  if (status === 400 && (provider === 'gemini' || provider === 'grok')) {
    const body = await response.json().catch(() => null) as {
      error?: string | { details?: { reason?: string }[] };
    } | null;
    const error = body?.error;
    if (provider === 'grok' && typeof error === 'string' && /incorrect api key/i.test(error)) status = 401;
    if (provider === 'gemini' && error && typeof error === 'object' && Array.isArray(error.details) &&
        error.details?.some(({ reason }) => reason === 'API_KEY_INVALID')) status = 401;
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  throw new ModelProviderError(status);
}

export function personalProviders(
  provider: PersonalModel, key: string, model: string | undefined, read: Providers['read'], signal: AbortSignal,
): Providers {
  if (provider === 'deepseek') return configureHttpProviders({
    OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_API_KEY: key, OPENAI_MODEL: model || 'deepseek-flash',
  }, read, signal);

  return {
    read,
    search: (query) => searchWikimedia(query, signal),
    async complete(instructions, data) {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      let content: string | undefined;
      const post = (url: string, headers: Record<string, string>, body: object) => fetch(url, {
        method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: timeout,
      });

      if (provider === 'anthropic') {
        const reply = await post('https://api.anthropic.com/v1/messages', {
          'x-api-key': key, 'anthropic-version': '2023-06-01',
        }, { model: 'claude-haiku-4-5-20251001', max_tokens: 8_000, system: instructions,
          messages: [{ role: 'user', content: data }] });
        await checkProvider(reply, provider);
        const body = await reply.json() as { stop_reason?: string; content?: { type: string; text?: string }[] };
        if (body.stop_reason === 'max_tokens') throw new Error('Model response exceeded its output limit');
        content = body.content?.filter(({ type }) => type === 'text').map(({ text }) => text).join('');
      } else if (provider === 'gemini') {
        const reply = await post('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent',
          { 'x-goog-api-key': key }, {
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: 'user', parts: [{ text: data }] }],
            generationConfig: { maxOutputTokens: 10_000, responseMimeType: 'application/json' },
          });
        await checkProvider(reply, provider);
        const body = await reply.json() as { candidates?: { finishReason?: string; content?: {
          parts?: { text?: string; thought?: boolean }[];
        } }[] };
        const candidate = body.candidates?.[0];
        if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('Model response exceeded its output limit');
        content = candidate?.content?.parts?.filter(({ thought }) => !thought).map(({ text }) => text).join('');
      } else {
        const config = chatModels[provider];
        const reply = await post(config.url, { Authorization: 'Bearer ' + key }, {
          model: config.model, messages: [{ role: 'system', content: instructions }, { role: 'user', content: data }],
          response_format: { type: 'json_object' }, ...config.options,
        });
        await checkProvider(reply, provider);
        const body = await reply.json() as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
        if (body.choices?.[0]?.finish_reason === 'length') throw new Error('Model response exceeded its output limit');
        content = body.choices?.[0]?.message?.content;
      }
      if (!content?.trim()) throw new Error('Model provider did not return a JSON object');
      return decodeCompletion(content);
    },
  };
}
