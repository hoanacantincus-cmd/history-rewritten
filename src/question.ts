export const defaultOutcome = '历史将会如何发展';

export function questionParts(text: string): { change: string; outcome: string } {
  const clean = text.trim().replace(/^如果\s*/u, '').replace(/[？?。]+$/u, '');
  const comma = Math.max(clean.lastIndexOf('，'), clean.lastIndexOf(','));
  const ending = comma > 0 ? clean.slice(comma + 1).trim() : '';
  if (ending && /如何|怎样|什么|有何|会不会|会.{0,14}[吗么]|能否|能.{0,14}[吗么]|[吗么]$/u.test(ending)) {
    return { change: clean.slice(0, comma).trim(), outcome: ending };
  }
  return { change: clean.trim(), outcome: '' };
}

export function assembleQuestion(change: string, outcome: string) {
  const parts = questionParts(change);
  if (!parts.change) return '';
  const focus = outcome.trim().replace(/[？?。]+$/u, '').trim() || parts.outcome || defaultOutcome;
  return '如果' + parts.change + '，' + focus + '？';
}

export function normalizeQuestion(value: string) {
  const text = value.trim();
  if (!text) return '';
  if (/[？?]$/u.test(text) || !/^如果/u.test(text)) return text;
  return assembleQuestion(text, '');
}
