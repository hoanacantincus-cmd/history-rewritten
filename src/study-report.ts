import type { Bundle, Scalar } from './schema.ts';
import type { Simulation } from './engine.ts';

function el<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string) {
  const element = document.createElement(name);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const statusText = {
  consistent: '已对上留出的史实',
  disagrees: '固定基线与史实有偏差',
  unresolved: '基线的关键状态仍待定',
  unavailable: '没有可直接比对的留出观测',
};

export function drawHistoricalStudy(
  bundle: Bundle, analysis: Simulation,
  references: (bundle: Bundle, ids: string[]) => HTMLElement,
  show: (value: Scalar, unit?: string) => string,
) {
  const model = bundle.model!;
  const audit = bundle.audit!;
  const checked = analysis.historicalAudit!;
  const state = new Map(model.variables.map((item) => [item.id, item]));
  const title = (field: string) => state.get(field)?.label ?? field;
  const value = (field: string, item: Scalar) => show(item, state.get(field)?.unit);
  const section = el('section', 'monitor study');
  section.id = 'historical-study';
  section.append(el('h3', undefined, '史实与改写的对照'));
  const window = el('p', 'study-window', audit.start + ' → ' + audit.end);
  const note = el('p', 'model-note', audit.interpretation);
  note.append(references(bundle, model.decisionBasis));
  section.append(window, note);

  const check = el('div', 'study-check');
  check.dataset.result = checked.status;
  check.append(el('h4', undefined, statusText[checked.status]));
  if (checked.observations.length) {
    const list = el('ul', 'study-checks');
    const texts = { matched: '一致', mismatch: '有偏差', unknown: '待定' };
    for (const item of checked.observations) {
      const row = el('li');
      row.append(el('strong', undefined, title(item.field)), el('span', undefined,
        '第 ' + item.step + ' 步 · 史实 ' + value(item.field, item.value) + ' · 计算 ' + value(item.field, item.calculated) +
        ' · ' + texts[item.result]), references(bundle, item.basis));
      list.append(row);
    }
    check.append(list);
  } else {
    check.append(el('p', 'model-note', '当前结论按条件展示。史料不足以核对模型在同一时期的状态。'));
  }
  section.append(check);

  if (checked.divergence) {
    const first = el('div', 'first-divergence');
    first.append(el('strong', undefined, '首次分岔 · 第 ' + checked.divergence.step + ' 步'));
    for (const item of checked.divergence.changes) {
      first.append(el('p', undefined, title(item.field) + ' · ' +
        value(item.field, item.before) + ' → ' + value(item.field, item.after)));
    }
    section.append(first);
  }

  const actor = new Map(model.actors.map((item) => [item.id, item]));
  const rule = new Map([...model.rules, ...(model.policies ?? [])].map((item) => [item.id, item.label]));
  const timeline = el('div', 'paired-rounds');
  const label = el('label', 'model-rule-select', '双时间线情景');
  const picker = el('select');
  for (const item of model.scenarios) {
    const option = el('option', undefined, item.label);
    option.value = item.id;
    picker.append(option);
  }
  label.append(picker);
  picker.value = audit.historicalScenario;
  const branches = [model.decisions[0], model.decisions.find(({ id }) => id === model.forecast?.decision) ?? model.decisions[1]];
  const actionHeading = el('h4', undefined, '双时间线');
  section.append(actionHeading, label, timeline);

  function drawRounds() {
    const pair = branches.map((branch) =>
      analysis.runs.find(({ scenario, decision }) => scenario === picker.value && decision === branch.id));
    const rounds = [...new Set(pair.flatMap((run) => run?.trace.map(({ step }) => step) ?? []))].sort((a, b) => a - b);
    timeline.replaceChildren();
    const headings = el('div', 'paired-heading');
    headings.append(...branches.map((item) => el('strong', undefined, item.label)));
    timeline.append(headings);
    for (const step of rounds) {
      const entry = el('details', 'paired-step');
      entry.open = rounds.length < 7;
      entry.append(el('summary', undefined, '第 ' + step + ' 步'));
      const columns = el('div', 'paired-columns');
      for (const [index, run] of pair.entries()) {
        const column = el('div');
        column.setAttribute('aria-label', branches[index].label);
        for (const event of run?.trace.filter((item) => item.step === step) ?? []) {
          const who = event.actor ? actor.get(event.actor)?.label : undefined;
          const action = el('p', undefined, (who ? who + ' · ' : '') + (rule.get(event.rule) ?? event.rule) + ' · ' +
            value(event.field, event.before) + ' → ' + value(event.field, event.after));
          action.append(references(bundle, event.basis));
          column.append(action);
        }
        if (!column.childElementCount) column.append(el('p', 'model-note', '本步没有记录行动或状态变化。'));
        columns.append(column);
      }
      entry.append(columns);
      timeline.append(entry);
    }
  }
  picker.onchange = drawRounds;
  drawRounds();

  const sensitive = el('div', 'study-switches');
  sensitive.append(el('h4', undefined, '哪些条件会改变结果'));
  if (!analysis.switches.length) {
    sensitive.append(el('p', 'model-note', '已比较的情景没有找到可确认的单项条件翻转。'));
  } else {
    for (const item of analysis.switches) {
      const card = el('article', 'outcome');
      card.append(el('strong', 'switch-title', title(item.parameter)),
        el('p', undefined, value(item.parameter, item.from) + ' → ' + value(item.parameter, item.to)),
        el('p', 'model-note', show(item.before) + ' → ' + show(item.after)));
      const scenarios = model.scenarios.filter(({ id }) => id === item.beforeScenario || id === item.afterScenario);
      card.append(references(bundle, scenarios.flatMap(({ basis }) => basis)));
      sensitive.append(card);
    }
  }
  section.append(sensitive);
  return section;
}
