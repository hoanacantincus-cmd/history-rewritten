import type { Bundle, Scalar } from './schema.ts';
import type { Simulation } from './engine.ts';

function el<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string) {
  const item = document.createElement(name);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function statusLabel(status: string) {
  return ({ consistent: '史实基线已核对', disagrees: '史实基线有偏差',
    unresolved: '史实基线待定', unavailable: '条件模型' } as Record<string, string>)[status] ?? '条件模型';
}

function valueLabel(value: Scalar) {
  if (value === null) return '待定';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function drawStudioOverview(bundle: Bundle, analysis: Simulation) {
  const model = bundle.model!;
  const auditStatus = analysis.historicalAudit?.status ?? 'unavailable';
  const section = el('section', 'studio-overview');
  section.dataset.status = auditStatus;
  const mast = el('div', 'studio-overview-mast');
  const kicker = el('div', 'studio-kicker');
  kicker.append(el('span', 'studio-live-dot'), el('span', undefined, 'HISTORICAL SIMULATION CONTROL ROOM'));
  mast.append(kicker, el('span', 'studio-run-state', statusLabel(auditStatus)));
  section.append(mast);

  const title = el('h3', 'studio-overview-title',
    bundle.audit?.coverage === 'prerequisite' ? '必要条件实验' : '历史反事实实验');
  const summary = el('p', 'studio-overview-summary',
    bundle.audit?.interpretation ?? bundle.scope);
  section.append(title, summary);

  const metrics = el('div', 'studio-metrics');
  const supported = bundle.claims.filter(({ status }) => status === 'supported').length;
  const metric = (label: string, value: string, detail: string, tone = '') => {
    const card = el('div', 'studio-metric');
    if (tone) card.classList.add(tone);
    card.append(el('span', 'studio-metric-label', label), el('strong', undefined, value),
      el('small', undefined, detail));
    return card;
  };
  metrics.append(
    metric('证据锚点', supported + '/' + bundle.claims.length, '支持主张 / 全部主张', supported ? 'positive' : 'muted'),
    metric('行动方', String(model.actors.length), '写入行动的智能体', model.actors.length > 1 ? 'positive' : 'muted'),
    metric('情景空间', String(model.scenarios.length), model.horizon + ' 步观察窗', 'signal'),
    metric('运行轨迹', String(analysis.runs.length), '已复算分支', 'signal'),
  );
  section.append(metrics);

  const ledger = el('div', 'studio-ledger');
  const ledgerHead = el('div', 'studio-ledger-head');
  ledgerHead.append(el('strong', undefined, 'LIVE RUN LEDGER'),
    el('span', undefined, '逐轮状态变化'));
  ledger.append(ledgerHead);
  const run = analysis.runs.find(({ scenario }) => scenario === bundle.audit?.historicalScenario) ?? analysis.runs[0];
  const actorNames = new Map(model.actors.map(({ id, label }) => [id, label]));
  const ruleNames = new Map([...model.rules, ...(model.policies ?? [])].map(({ id, label }) => [id, label]));
  const steps = [...new Set(run?.trace.map(({ step }) => step) ?? [])].sort((a, b) => a - b);
  if (!steps.length) {
    ledger.append(el('p', 'studio-empty', '本次范围内没有产生可展示的状态变化。'));
  } else {
    const timeline = el('div', 'studio-ledger-track');
    for (const step of steps) {
      const cell = el('article', 'studio-ledger-step');
      cell.append(el('span', 'studio-step-index', 'T+' + String(step).padStart(2, '0')));
      for (const event of run.trace.filter(({ step: current }) => current === step).slice(0, 3)) {
        const row = el('div', 'studio-ledger-event');
        row.append(el('span', 'studio-ledger-actor', event.actor ? actorNames.get(event.actor) : 'WORLD'),
          el('strong', undefined, ruleNames.get(event.rule) ?? event.rule),
          el('span', undefined, valueLabel(event.before) + ' → ' + valueLabel(event.after)));
        cell.append(row);
      }
      if (cell.childElementCount === 1) cell.append(el('span', 'studio-empty', '无状态变化'));
      timeline.append(cell);
    }
    ledger.append(timeline);
  }
  section.append(ledger);
  const footer = el('div', 'studio-overview-footer');
  footer.append(el('span', undefined, 'ENGINE ' + bundle.engineVersion),
    el('span', undefined, model.stepLabel),
    el('span', undefined, analysis.forecast?.observations ? 'OBSERVATIONS ' + analysis.forecast.observations : 'CONDITIONAL OUTPUT'));
  section.append(footer);
  return section;
}
