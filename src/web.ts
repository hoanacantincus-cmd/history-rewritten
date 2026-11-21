import './style.css';
import { parseBundle } from './schema.ts';
import type { Bundle, Scalar, Variable } from './schema.ts';
import { simulate } from './engine.ts';
import type { Simulation } from './engine.ts';
import { drawAgentBoard } from './agent-board.ts';
import { assembleQuestion, questionParts } from './question.ts';
import { researchPhases } from './research-progress.ts';
import type { ResearchPhase, ResearchProgress } from './research-progress.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = byId<HTMLDivElement>('status');
const results = byId<HTMLElement>('results');
const form = byId<HTMLFormElement>('research-form');
const question = byId<HTMLInputElement>('question');
const consequence = byId<HTMLInputElement>('consequence');
const progressPanel = byId<HTMLElement>('work-progress');
const input = byId<HTMLInputElement>('import');
const researchButton = byId<HTMLButtonElement>('research-button');
const sample = { change: '岳飞得到了皇帝的全部信任', outcome: '南宋将会如何', case: 'yue-fei-1141' };
const phases = { identify: '确定分岔点', evidence: '查找史料', model: '建立模型', check: '校验并复算' };
let selfHosted = false;
let examplePrepared = false;
let selectedDemo: string | undefined;
let operation = 0;

function el<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string) {
  const item = document.createElement(name);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function say(text = '') {
  status.textContent = text;
  status.hidden = !text;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const changes = { same: '相同', different: '改变', higher: '增加', lower: '减少', unknown: '证据不足' };
const kinds = { supported: '有来源', disputed: '史料有争议', assumption: '模型假设', gap: '证据缺口' };
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 });
function show(value: Scalar, unit?: string) {
  if (value === null) return '待定';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  return number.format(value) + (unit && unit !== '1' ? ' ' + unit : '');
}
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const factorNames = { internal: '内部条件', external: '外部局势', strategy: '各方博弈', weather: '天气' };
const factorStatus = { modeled: '已建模', unresolved: '资料不足', irrelevant: '影响有限' };

function setBundle(data: unknown, demo?: string) {
  const bundle = parseBundle(data);
  progressPanel.hidden = true;
  selectedDemo = demo;
  document.querySelectorAll<HTMLButtonElement>('[data-case]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.case === demo));
  });
  render(bundle);
  results.hidden = false;
  results.focus();
  results.scrollIntoView({ block: 'start' });
}

function references(bundle: Bundle, ids: string[]) {
  const holder = el('span', 'refs');
  for (const id of new Set(ids)) {
    const position = bundle.claims.findIndex((claim) => claim.id === id);
    const link = el('a', undefined, '[' + (position + 1) + ']');
    link.href = '#claim-' + id;
    link.setAttribute('aria-label', '证据 ' + (position + 1));
    link.addEventListener('click', () => {
      let ancestor = document.getElementById('claim-' + id)?.parentElement;
      while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
    });
    holder.append(link, ' ');
  }
  return holder;
}

function viewSources(bundle: Bundle) {
  const section = el('section', 'monitor');
  section.append(el('h3', undefined, '史料与假设'));
  if (!bundle.claims.length) section.append(el('p', 'model-note', '暂未获得可引用的史料。'));
  for (const [index, claim] of bundle.claims.entries()) {
    const article = el('article', 'source-card');
    article.id = 'claim-' + claim.id;
    article.append(el('span', 'claim-type', (index + 1) + ' · ' + kinds[claim.status]), el('p', undefined, claim.text));
    for (const citation of claim.citations) {
      const source = bundle.sources.find((item) => item.id === citation.source)!;
      const quote = el('blockquote', undefined, citation.quote);
      const link = el('a', undefined, source.title + ' · ' + citation.locator + ' ↗');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      article.append(quote, link);
    }
    section.append(article);
  }
  const cited = new Set(bundle.claims.flatMap((claim) => claim.citations.map(({ source }) => source)));
  const candidates = bundle.sources.filter(({ id }) => !cited.has(id));
  if (candidates.length) {
    const panel = el('details', 'source-card');
    panel.append(el('summary', undefined, '待核查的候选来源'));
    const list = el('ul', 'event-list');
    candidates.forEach((source) => {
      const item = el('li');
      const link = el('a', undefined, source.title + ' ↗');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.append(link);
      list.append(item);
    });
    panel.append(list);
    section.append(panel);
  }
  return section;
}

function makeSelect(label: string, choices: { id: string; label: string }[]) {
  const wrapper = el('label', undefined, label);
  const select = el('select');
  for (const choice of choices) {
    const option = el('option', undefined, choice.label);
    option.value = choice.id;
    select.append(option);
  }
  wrapper.append(select);
  return { wrapper, select };
}

function modelTable(headings: string[], rows: string[][]) {
  const frame = el('div', 'scroll-table');
  const table = el('table');
  const head = table.createTHead().insertRow();
  headings.forEach((name) => head.append(el('th', undefined, name)));
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value) => tr.append(el('td', value === '待定' ? 'unknown' : undefined, value)));
  }
  frame.append(table);
  return frame;
}

function parameterControl(variable: Variable, value: Scalar) {
  if (variable.kind === 'number') {
    const field = el('input');
    field.type = 'number';
    field.step = 'any';
    if (variable.min !== undefined) field.min = String(variable.min);
    if (variable.max !== undefined) field.max = String(variable.max);
    field.value = value === null ? '' : String(value);
    const wrapper = el('label', undefined, variable.label);
    wrapper.append(field);
    return { wrapper, read: (): Scalar => field.value === '' ? null : field.valueAsNumber };
  }
  const choices = variable.kind === 'boolean'
    ? [{ id: 'true', label: '是' }, { id: 'false', label: '否' }]
    : variable.values!.map((item) => ({ id: item, label: item }));
  const { wrapper, select } = makeSelect(variable.label, [{ id: '', label: '待定' }, ...choices]);
  select.value = value === null ? '' : String(value);
  return {
    wrapper, read: (): Scalar => select.value === '' ? null :
      variable.kind === 'boolean' ? select.value === 'true' : select.value,
  };
}

function drawModel(bundle: Bundle, scenarioValue = 'all', horizonValue = bundle.model?.horizon) {
  const model = bundle.model!;
  const section = el('section', 'monitor');
  section.append(el('h3', undefined, '基线与改写方案'));
  const start = el('p', 'model-note', model.decisionPoint);
  start.append(references(bundle, model.decisionBasis));
  section.append(start);
  const controls = el('div', 'controls');
  const scenario = makeSelect('假设情景', [{ id: 'all', label: '全部情景' }, ...model.scenarios]);
  scenario.select.value = scenarioValue;
  const metric = makeSelect('观察指标', [{ id: 'all', label: '全部指标' }, ...model.metrics]);
  const horizonLabel = el('label', undefined, '推演步数 · ' + model.stepLabel);
  const horizon = el('input');
  horizon.type = 'number';
  horizon.min = '1';
  horizon.max = String(model.horizon);
  horizon.value = String(horizonValue);
  horizonLabel.append(horizon);
  controls.append(scenario.wrapper, horizonLabel, metric.wrapper);
  const editor = el('div');
  const output = el('div');
  section.append(controls, editor, output);

  function refresh() {
    try {
      const chosenHorizon = horizon.valueAsNumber;
      const simulation = simulate(bundle, { scenario: scenario.select.value, horizon: chosenHorizon });
      const visible = (id: string) => metric.select.value === 'all' || metric.select.value === id;
      const scenarioName = (id: string) => model.scenarios.find((item) => item.id === id)!.label;
      const decisionName = (id: string) => model.decisions.find((item) => item.id === id)!.label;
      const indicator = (id: string) => model.metrics.find((item) => item.id === id)!;
      const unit = (field: string) => model.variables.find((item) => item.id === field)?.unit;
      const table = modelTable(['情景', '改写方案', '指标', '基线', '改写后'], simulation.comparisons
        .filter((row) => visible(row.metric)).map((row) => [
          scenarioName(row.scenario), decisionName(row.decision), indicator(row.metric).label,
          show(row.before, unit(indicator(row.metric).field)), show(row.after, unit(indicator(row.metric).field)),
        ]));
      const summary = el('ul', 'event-list');
      for (const row of simulation.sensitivity.filter((item) => visible(item.metric))) {
        const label = decisionName(row.decision) + ' · ' + indicator(row.metric).label;
        const observed = row.changes.length ? row.changes.map((change) => changes[change as keyof typeof changes]).join('、') : '待定';
        const range = row.deltaRange
          ? '。数值差为 ' + row.deltaRange.map((value) => show(value, unit(indicator(row.metric).field))).join(' 至 ') : '';
        const unknown = row.incomplete ? '。含未确定的结果' : '';
        summary.append(el('li', undefined, label + '在已选情景中：' + observed + range + unknown));
      }
      const trace = el('details');
      trace.append(el('summary', undefined, '查看规则触发过程'));
      for (const run of simulation.runs) {
        const path = el('details', 'trace-block');
        path.append(el('summary', undefined, scenarioName(run.scenario) + ' · ' + decisionName(run.decision)));
        path.addEventListener('toggle', () => {
          if (!path.open || path.childElementCount > 1) return;
          if (!run.trace.length) {
            path.append(el('p', 'model-note', '本次范围内没有状态变化。'));
            return;
          }
          const list = el('ol', 'event-list');
          for (const event of run.trace) {
            const rule = model.rules.find((item) => item.id === event.rule) ?? model.policies?.find((item) => item.id === event.rule);
            const item = el('li', undefined, '第 ' + event.step + ' 步 · ' + (rule?.label ?? event.rule) + ' · ' +
              show(event.before, unit(event.field)) + ' → ' + show(event.after, unit(event.field)));
            if (event.utilities?.length) {
              item.append('（' + event.utilities.map(({ action, value }) => show(action) + ' ' + show(value)).join(' / ') + '）');
            }
            item.append(references(bundle, event.basis));
            list.append(item);
          }
          path.append(list);
        });
        trace.append(path);
      }
      output.replaceChildren(table, summary, trace);
    } catch (error) {
      output.replaceChildren(el('p', 'model-note', '推演参数无效。' + errorText(error)));
    }
  }

  function drawEditor() {
    const current = model.scenarios.find((item) => item.id === scenario.select.value);
    const parameters = model.variables.filter((item) => item.role === 'parameter');
    editor.replaceChildren();
    if (!current || !parameters.length) return;
    const details = el('details', 'parameter-editor');
    details.append(el('summary', undefined, '调整此情景的假设'));
    const line = el('div', 'controls');
    const edits = parameters.map((variable) => ({
      variable, ...parameterControl(variable, Object.hasOwn(current.parameters, variable.id)
        ? current.parameters[variable.id] : variable.initial),
    }));
    line.append(...edits.map((item) => item.wrapper));
    const save = el('button', 'button secondary', '应用并复算');
    save.type = 'button';
    line.append(save);
    details.append(line);
    save.addEventListener('click', () => {
      const updated = structuredClone(bundle);
      const selected = updated.model!.scenarios.find((item) => item.id === current.id)!;
      const changed = edits.filter((item) => item.read() !== (Object.hasOwn(current.parameters, item.variable.id)
        ? current.parameters[item.variable.id] : item.variable.initial));
      if (!changed.length) return;
      if (changed.some((item) => typeof item.read() === 'number' && !Number.isFinite(item.read()))) {
        say('请输入有效的数字。');
        return;
      }
      let sequence = 1;
      while (updated.claims.some((claim) => claim.id === 'user-edit-' + sequence)) sequence++;
      const id = 'user-edit-' + sequence;
      const changeText = changed.map(({ variable, read }) => variable.label + '＝' + show(read(), variable.unit)).join('；');
      updated.claims.push({
        id, status: 'assumption', scope: 'context', citations: [],
        text: ('用户调整「' + selected.label + '」中的参数：' + changeText).slice(0, 1200),
      });
      selected.basis = [...selected.basis.slice(-9), id];
      for (const { variable, read } of changed) selected.parameters[variable.id] = read();
      if (updated.model?.forecast?.weights) {
        delete updated.model.forecast.weights;
        if (updated.gaps.length < 16) updated.gaps.push('手动修改情景条件后，原计数权重不再适用。');
      }
      try {
        render(parseBundle(updated), current.id, horizon.valueAsNumber);
        say('已按修改后的假设复算。');
        byId<HTMLElement>('results-title').focus();
      } catch (error) { say(errorText(error)); }
    });
    const basis = el('p', 'model-note', '此情景的依据');
    basis.append(references(bundle, current.basis));
    editor.append(basis, details);
  }

  scenario.select.addEventListener('change', () => { drawEditor(); refresh(); });
  metric.select.addEventListener('change', refresh);
  horizon.addEventListener('change', refresh);
  drawEditor();
  refresh();
  return section;
}

function drawForecast(bundle: Bundle, analysis: Simulation) {
  const model = bundle.model!;
  const spec = model.forecast!;
  const forecast = analysis.forecast!;
  const section = el('section', 'monitor');
  section.append(el('h3', undefined, forecast.observations ? '可能走向与模型概率' : '可能走向'));
  section.append(el('p', 'model-note', model.metrics.find(({ id }) => id === spec.metric)!.label));
  if (forecast.baseline === 'disagrees' || forecast.baseline === 'unresolved') {
    const notice = el('p', 'model-note', forecast.baseline === 'disagrees'
      ? '模拟基线与史实冲突，结果需要复核。' : '模拟基线有待判定，暂不展示概率。');
    notice.append(references(bundle, spec.baselineCheck!.basis));
    section.append(notice);
  }
  const grid = el('div', 'forecast-grid');
  const names = new Map(model.scenarios.map(({ id, label }) => [id, label]));
  const outcomes = [...forecast.outcomes].sort((a, b) => (b.probability?.lower ?? 0) - (a.probability?.lower ?? 0));
  for (const outcome of outcomes) {
    const card = el('article', 'outcome');
    if (outcome.probability) {
      const { lower, upper } = outcome.probability;
      card.append(el('strong', undefined, percent.format(lower) + (lower === upper ? '' : '–' + percent.format(upper))));
    }
    card.append(el('h4', undefined, outcome.label));
    const labels = outcome.scenarios.map((scenario) => names.get(scenario));
    card.append(el('p', 'model-note', labels.length ? labels.join('、') : '现有情景未出现此走向'));
    grid.append(card);
  }
  section.append(grid);
  if (forecast.observations && spec.weights) {
    const math = el('p', 'model-note', '按 ' + number.format(forecast.observations) + ' 个有记录的样本或等可能项加权。' + spec.weights.method);
    math.append(references(bundle, spec.weights.counts.flatMap(({ basis }) => basis)));
    section.append(math);
    if (forecast.unknownMass) section.append(el('p', 'model-note', '有 ' + percent.format(forecast.unknownMass) + ' 的权重对应未判定情景，因此显示概率上下界。'));
  } else {
    section.append(el('p', 'model-note', '目前只有条件情景，资料不足以估计各走向的概率。'));
  }
  if (forecast.unclassifiedScenarios.length) {
    section.append(el('p', 'model-note', '走向待定的情景：' + forecast.unclassifiedScenarios.map((id) => names.get(id)).join('、')));
  }
  const audit = el('details');
  audit.append(el('summary', undefined, '查看各方博弈、内外条件与天气依据'));
  const list = el('ul', 'event-list');
  for (const factor of spec.factors) {
    const item = el('li', undefined, factorNames[factor.kind] + ' · ' + factorStatus[factor.status] + '。' + factor.explanation);
    item.append(references(bundle, factor.basis));
    list.append(item);
  }
  audit.append(list);
  section.append(audit);
  return section;
}

function drawProcess(bundle: Bundle, analysis: Simulation) {
  const section = el('section', 'monitor');
  section.append(el('h3', undefined, '推演过程'));
  const model = bundle.model!;
  const stages = el('ol', 'phase-list');
  const entries: { phase: ResearchPhase; detail: string; basis?: string[] }[] = [
    { phase: 'identify', detail: model.decisionPoint, basis: model.decisionBasis },
    { phase: 'evidence', detail: bundle.claims.filter(({ status }) => status === 'supported').length +
        ' 项有来源的主张；' + bundle.claims.filter(({ status }) => status === 'assumption').length + ' 项建模假设。' },
    { phase: 'model', detail: model.actors.length + ' 个智能体，' + model.scenarios.length + ' 组情景。各分支在同一组条件下比较。' },
    { phase: 'check', detail: analysis.runs.length + ' 条模拟轨迹。' +
      (analysis.forecast?.baseline === 'disagrees' ? '史实基线有冲突，需复核。' : '可逐步查看状态变化和依据。') },
  ];
  for (const entry of entries) {
    const item = el('li');
    item.append(el('strong', undefined, phases[entry.phase]), el('span', undefined, entry.detail));
    if (entry.basis) item.append(references(bundle, entry.basis));
    stages.append(item);
  }
  section.append(stages);
  return section;
}

function render(bundle: Bundle, scenario?: string, horizon?: number) {
  const heading = el('h2', undefined, bundle.title);
  heading.id = 'results-title';
  heading.tabIndex = -1;
  const header = el('div', 'result-head');
  const button = el('button', 'button secondary', '导出分析包 ↓');
  button.type = 'button';
  button.onclick = () => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = (selectedDemo ?? 'history-analysis') + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };
  header.append(heading, button);
  results.replaceChildren(header, el('p', 'result-scope', bundle.scope));
  if (bundle.model) {
    const analysis = simulate(bundle, { horizon });
    results.append(drawProcess(bundle, analysis), drawAgentBoard(bundle, analysis, references));
    if (analysis.forecast) results.append(drawForecast(bundle, analysis));
  } else if (bundle.status === 'insufficient') {
    results.append(el('p', 'model-note', '还没有通过校验的模型。下方保留可查的史料和缺口。'));
  }
  if (bundle.status === 'clarification') {
    const section = el('section', 'monitor');
    section.append(el('h3', undefined, '选择要分析的问题'));
    for (const option of bundle.options) {
      const line = el('p', 'source-card');
      const use = el('button', 'button secondary', option.label);
      use.type = 'button';
      use.onclick = () => {
        const parts = questionParts(option.question);
        question.value = parts.change;
        consequence.value = parts.outcome;
        form.requestSubmit();
      };
      line.append(use, references(bundle, option.basis));
      section.append(line);
    }
    results.append(section);
  }
  const record = el('div', 'result-grid');
  const timeline = el('section', 'monitor');
  timeline.append(el('h3', undefined, '史实时间线'));
  const events = el('ol', 'event-list');
  bundle.timeline.forEach((event) => {
    const entry = el('li');
    entry.append(el('time', undefined, event.when), event.label, references(bundle, event.basis));
    events.append(entry);
  });
  timeline.append(bundle.timeline.length ? events : el('p', 'model-note', '没有可核查的时间线条目。'));
  const gaps = el('section', 'monitor');
  gaps.append(el('h3', undefined, '范围与证据缺口'));
  const list = el('ul', 'event-list');
  bundle.gaps.forEach((gap) => list.append(el('li', undefined, gap)));
  gaps.append(bundle.gaps.length ? list : el('p', 'model-note', '查看模型假设，了解本次推演的适用范围。'));
  record.append(timeline, gaps);
  if (bundle.model) {
    const details = el('details', 'monitor analysis-details');
    details.open = Boolean(scenario) || !bundle.model.forecast;
    details.append(el('summary', undefined, '模型、史料与复算'), drawModel(bundle, scenario, horizon), record, viewSources(bundle));
    results.append(details);
  } else results.append(record, viewSources(bundle));
}

async function openCase(demo: string) {
  const id = ++operation;
  progressPanel.hidden = true;
  say('载入案例…');
  try {
    const response = await fetch(import.meta.env.BASE_URL + 'examples/' + demo + '.json');
    if (!response.ok) throw new Error('案例暂时无法读取。');
    const data: unknown = await response.json();
    if (id === operation) { setBundle(data, demo); say(); }
  } catch (error) { if (id === operation) say(errorText(error)); }
}
document.querySelectorAll<HTMLButtonElement>('[data-case]').forEach((card) => {
  card.addEventListener('click', () => { if (card.dataset.case) void openCase(card.dataset.case); });
});

byId<HTMLButtonElement>('sample-question').onclick = () => {
  question.value = sample.change;
  consequence.value = sample.outcome;
  examplePrepared = true;
  say('已填入岳飞案例。提交即可复算这个示例。');
  question.focus();
};
question.oninput = consequence.oninput = () => { examplePrepared = false; };

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  const id = ++operation;
  progressPanel.hidden = true;
  try {
    if (file.size > 1_000_000) throw new Error('分析包超过 1 MB。');
    const data: unknown = JSON.parse(await file.text());
    if (id === operation) { setBundle(data); say(); }
  } catch (error) { if (id === operation) say('导入失败。' + errorText(error)); }
  finally { input.value = ''; }
});

function progressView() {
  const current = new Map<ResearchPhase, string>();
  const heading = el('h2', undefined, '推演进度');
  const prompt = el('p', 'model-note');
  prompt.setAttribute('aria-live', 'polite');
  const stepList = el('ol', 'phase-list');
  const sources = el('div', 'progress-refs');
  progressPanel.replaceChildren(heading, prompt, stepList, sources);
  progressPanel.hidden = false;
  progressPanel.focus();
  progressPanel.scrollIntoView({ block: 'start' });
  return (event: ResearchProgress) => {
    current.set(event.phase, event.detail);
    prompt.textContent = event.detail;
    stepList.replaceChildren(...researchPhases.map((phase) => {
      const item = el('li');
      item.dataset.phase = phase === event.phase ? 'current' : current.has(phase) ? 'done' : 'waiting';
      item.append(el('strong', undefined, phases[phase]), el('span', undefined, current.get(phase) ?? '等待'));
      return item;
    }));
    if (event.sources?.length) {
      sources.replaceChildren();
      for (const item of event.sources) {
        let url: URL;
        try { url = new URL(item.url); } catch { continue; }
        if (!['https:', 'http:'].includes(url.protocol)) continue;
        const link = el('a', undefined, item.title);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sources.append(link);
      }
    }
  };
}

async function readResearch(response: Response, onProgress: (event: ResearchProgress) => void): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data: unknown = await response.json();
    if (!response.ok) throw new Error((data as { error?: string }).error ?? '分析服务暂时不可用。');
    return data;
  }
  if (!response.body) throw new Error('分析服务未返回推演记录。');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += chunk.value;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as
          { type: 'progress'; progress: ResearchProgress } |
          { type: 'result'; bundle: unknown } | { type: 'error'; error: string };
        if (record.type === 'progress') onProgress(record.progress);
        if (record.type === 'error') throw new Error(record.error);
        if (record.type === 'result') return record.bundle;
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
  throw new Error('推演连接提前结束，请稍后再试。');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (researchButton.disabled) return;
  const prompt = assembleQuestion(question.value, consequence.value);
  if (!prompt) { say('请在「如果」后填入你想改变的历史条件。'); return; }
  const matchesSample = prompt === assembleQuestion(sample.change, sample.outcome) ||
    (!consequence.value.trim() && question.value.trim() === sample.change);
  if (matchesSample && (examplePrepared || !selfHosted)) { void openCase(sample.case); return; }
  if (!selfHosted) {
    say('这道新题需要自托管版。公开页可以先用岳飞示例查看推演过程。');
    return;
  }
  const operationId = ++operation;
  researchButton.disabled = true;
  say();
  const track = progressView();
  track({ phase: 'identify', detail: '正在提交历史问题。' });
  try {
    const response = await fetch('/api/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ question: prompt }),
    });
    const data = await readResearch(response, (event) => { if (operationId === operation) track(event); });
    if (operationId === operation) { setBundle(data); say(); }
  } catch (error) {
    if (operationId === operation) { progressPanel.hidden = true; say(errorText(error)); }
  } finally { researchButton.disabled = false; }
});

if (import.meta.env.VITE_DEMO_ONLY !== 'true') {
  void fetch('/api/status').then(async (response) => {
    if (!response.ok) return;
    const data = await response.json() as { mode?: string };
    if (data.mode !== 'self-hosted') return;
    selfHosted = true;
    researchButton.textContent = '开始推演 →';
    byId('mode-note').textContent = '研究在这台自托管服务上运行。导出的分析包可离线复算。';
  }).catch(() => { /* A static host renders the public demo. */ });
}
