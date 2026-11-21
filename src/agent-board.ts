import { agentEdges } from './agent-graph.ts';
import type { Simulation } from './engine.ts';
import type { Bundle, Scalar } from './schema.ts';

const width = 1000;
const height = 520;
type Point = { x: number; y: number };

function position(index: number, total: number): Point {
  if (total === 1) return { x: width / 2, y: height / 2 };
  if (total <= 6) {
    const angle = 2 * Math.PI * index / total - Math.PI / 2;
    return { x: width / 2 + Math.cos(angle) * 327, y: height / 2 + Math.sin(angle) * 179 };
  }
  const rows = Math.ceil(total / 3);
  return { x: 165 + index % 3 * 335, y: 88 + Math.floor(index / 3) * (344 / (rows - 1)) };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}

function selectField(label: string, entries: { id: string; label: string }[]) {
  const field = node('label', undefined, label);
  const select = node('select');
  select.setAttribute('aria-label', label);
  for (const entry of entries) {
    const option = node('option', undefined, entry.label);
    option.value = entry.id;
    select.append(option);
  }
  field.append(select);
  return { field, select };
}

function display(value: Scalar) {
  if (value === null) return '待定';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function drawAgentBoard(
  bundle: Bundle, analysis: Simulation,
  references: (bundle: Bundle, ids: string[]) => HTMLElement,
) {
  const model = bundle.model!;
  const board = node('section', 'monitor actor-board');
  board.append(node('h3', undefined, '智能体推演'));
  if (!model.actors.length) {
    board.append(node('p', 'model-note', '这个模型使用直接规则，未定义独立行动的参与方。'));
    return board;
  }
  const edges = agentEdges(model);
  const positions = new Map(model.actors.map((actor, index) => [actor.id, position(index, model.actors.length)]));
  const names = new Map(model.actors.map((actor) => [actor.id, actor.label]));
  const fields = new Map(model.variables.map((field) => [field.id, field.label]));
  const rules = new Map([...model.rules, ...(model.policies ?? [])].map((rule) => [rule.id, rule.label]));
  const scenario = selectField('情景', model.scenarios);
  const decision = selectField('对照分支', model.decisions);
  decision.select.value = model.forecast?.decision ?? model.decisions[1].id;
  const controls = node('div', 'controls actor-controls');
  controls.append(scenario.field, decision.field);
  board.append(controls);

  const columns = node('div', 'actor-columns');
  const network = node('div', 'actor-map');
  network.setAttribute('role', 'group');
  network.setAttribute('aria-label', '智能体关系图');
  const canvas = node('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute('aria-hidden', 'true');
  network.append(canvas);
  const info = node('aside', 'actor-info');
  info.setAttribute('aria-live', 'polite');
  columns.append(network, info);
  board.append(columns, node('p', 'actor-caption', '箭头表示模型中一方的行动影响了另一方可读取的状态。点选人物可查看行动与依据。'));

  let active = model.actors[0].id;
  let round = 1;
  const maxRound = 'horizon' in analysis ? analysis.horizon : model.horizon;
  const actorButtons = new Map<string, HTMLButtonElement>();
  for (const actor of model.actors) {
    const marker = node('button', 'actor-marker', actor.label);
    marker.type = 'button';
    marker.title = actor.label;
    const point = positions.get(actor.id)!;
    marker.style.left = (point.x / width * 100) + '%';
    marker.style.top = (point.y / height * 100) + '%';
    marker.onclick = () => { active = actor.id; render(); };
    actorButtons.set(actor.id, marker);
    network.append(marker);
  }
  const timeline = node('div', 'actor-round');
  const prev = node('button', 'button secondary', '上一步');
  const next = node('button', 'button secondary', '下一步');
  prev.type = next.type = 'button';
  const label = node('span', 'actor-round-label');
  label.setAttribute('aria-live', 'polite');
  timeline.append(prev, label, next);
  board.append(timeline);

  function trace() {
    return analysis.runs.find((run) => run.decision === decision.select.value && run.scenario === scenario.select.value)?.trace ?? [];
  }

  function paint(turnActors: Set<string>) {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const { from, to } of edges) {
      const start = positions.get(from)!;
      const end = positions.get(to)!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const gap = 1 / Math.hypot(dx / 108, dy / 45);
      const x = end.x - dx * gap;
      const y = end.y - dy * gap;
      const angle = Math.atan2(dy, dx);
      const isSelected = active === from || active === to;
      context.strokeStyle = isSelected ? '#933e2c' : '#ad9d85';
      context.lineWidth = isSelected ? 4 : 2.5;
      context.beginPath();
      context.moveTo(start.x + dx * gap, start.y + dy * gap);
      context.lineTo(x, y);
      context.lineTo(x - 16 * Math.cos(angle - .5), y - 16 * Math.sin(angle - .5));
      context.moveTo(x, y);
      context.lineTo(x - 16 * Math.cos(angle + .5), y - 16 * Math.sin(angle + .5));
      context.stroke();
    }
    for (const [id, button] of actorButtons) {
      button.setAttribute('aria-pressed', String(id === active));
      button.dataset.acting = String(turnActors.has(id));
    }
  }

  function render() {
    const events = trace().filter((event) => event.step === round);
    paint(new Set(events.flatMap(({ actor }) => actor ? [actor] : [])));
    prev.disabled = round === 1;
    next.disabled = round === maxRound;
    label.textContent = '第 ' + round + ' / ' + maxRound + ' 步';
    info.replaceChildren(node('h4', undefined, names.get(active)));
    const actions = events.filter(({ actor }) => actor === active);
    if (!actions.length) info.append(node('p', 'model-note', '本步没有此方的行动记录。'));
    for (const event of actions) {
      const action = node('div', 'actor-action');
      action.append(node('strong', undefined, rules.get(event.rule) ?? event.rule));
      const summary = node('p', undefined, event.indeterminate ? '结果待定' : display(event.after));
      summary.append(references(bundle, event.basis));
      action.append(summary);
      if (event.utilities?.length) {
        action.append(node('p', 'model-note', '可行行动及效用 · ' +
          event.utilities.map(({ action: move, value }) => display(move) + ' ' + display(value)).join(' / ')));
      }
      info.append(action);
    }
    const related = edges.filter((edge) => active === edge.from || active === edge.to);
    if (related.length) {
      const list = node('ul', 'actor-links');
      related.forEach(({ from, to, fields: ids }) =>
        list.append(node('li', undefined, names.get(from) + ' → ' + names.get(to) + ' · ' + ids.map((id) => fields.get(id)).join('、'))));
      info.append(list);
    }
    if (events.some((event) => !event.actor)) {
      const updates = node('details', 'actor-world');
      updates.append(node('summary', undefined, '本步的全局状态'));
      for (const event of events.filter((event) => !event.actor)) {
        const row = node('p', undefined, (fields.get(event.field) ?? event.field) + ' · ' + display(event.after));
        row.append(references(bundle, event.basis));
        updates.append(row);
      }
      info.append(updates);
    }
  }

  function jump(step: number) {
    round = step;
    active = trace().find((event) => event.step === round && event.actor)?.actor ?? active;
    render();
  }
  prev.onclick = () => jump(round - 1);
  next.onclick = () => jump(round + 1);
  scenario.select.onchange = decision.select.onchange = () => jump(1);
  jump(1);
  return board;
}
