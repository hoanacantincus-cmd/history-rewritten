export const personalModels = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Claude · Anthropic',
  gemini: 'Gemini · Google',
  qwen: '通义千问 · 中国站',
  'qwen-intl': '通义千问 · 国际站',
  kimi: 'Kimi · 中国站',
  'kimi-intl': 'Kimi · 国际站',
  grok: 'Grok · xAI',
  openrouter: 'OpenRouter',
} as const;

export type PersonalModel = keyof typeof personalModels;

export function isPersonalModel(value: string): value is PersonalModel {
  return Object.hasOwn(personalModels, value);
}

export function detectKeyProvider(key: string): PersonalModel | undefined {
  if (/^sk-ant-/.test(key)) return 'anthropic';
  if (/^(AIza|AQ\.)/.test(key)) return 'gemini';
  if (/^sk-(proj|svcacct)-/.test(key)) return 'openai';
  if (/^xai-/.test(key)) return 'grok';
  if (/^sk-or-/.test(key)) return 'openrouter';
  // Legacy OpenAI, DeepSeek, DashScope and Moonshot keys can share an sk- prefix.
}
