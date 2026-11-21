import { agentEdges, observedAgentFlows } from './agent-graph.ts';
import type { AgentEdge } from './agent-graph.ts';
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
  startingScenario?: string,
) {
  const model = bundle.model!;
  const board = node('section', 'monitor actor-board');
  board.append(node('h3', undefined, '智能体推演'));
  board.id = 'agent-replay';
  board.tabIndex = -1;
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
  if (startingScenario) scenario.select.value = startingScenario;
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
  board.append(columns, node('p', 'actor-caption', '亮色箭头表示本轮实际读取了另一方改变过的状态。细线表示模型中可能发生的联系。'));

  let active = model.actors[0].id;
  let round = 1;
  const maxRound = 'horizon' in analysis ? analysis.horizon ?? model.horizon : model.horizon;
  let timer: number | undefined;
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
  const play = node('button', 'button secondary actor-play', '自动播放');
  play.type = 'button';
  play.setAttribute('aria-pressed', 'false');
  const slider = node('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = String(maxRound);
  slider.setAttribute('aria-label', '推演步数');
  const legend = node('p', 'actor-live-summary');
  legend.setAttribute('aria-live', 'polite');
  const turnLog = node('div', 'actor-turn-log');
  timeline.append(play, prev, slider, next, label);
  board.append(timeline, legend, turnLog);

  function trace() {
    return analysis.runs.find((run) => run.decision === decision.select.value && run.scenario === scenario.select.value)?.trace ?? [];
  }

  function paint(turnActors: Set<string>, flows: AgentEdge[]) {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const activeEdges = new Set(flows.map(({ from, to }) => from + ':' + to));
    const knownEdges = new Map([...edges, ...flows].map((edge) => [edge.from + ':' + edge.to, edge]));
    for (const [key, { from, to }] of knownEdges) {
      const start = positions.get(from)!;
      const end = positions.get(to)!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const gap = 1 / Math.hypot(dx / 108, dy / 45);
      const x = end.x - dx * gap;
      const y = end.y - dy * gap;
      const angle = Math.atan2(dy, dx);
      const fired = activeEdges.has(key);
      context.strokeStyle = fired ? '#70e0bf' : '#536767';
      context.lineWidth = fired ? 5.5 : 2.2;
      context.setLineDash(fired ? [] : [7, 6]);
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
    const flows = observedAgentFlows(trace(), round);
    paint(new Set(events.flatMap(({ actor }) => actor ? [actor] : [])), flows);
    legend.textContent = flows.length ? flows.map(({from, to, fields: ids}) =>
      names.get(from) + ' → ' + names.get(to) + ' · ' + ids.map((id) => fields.get(id)).join('、')).join('　') :
      '本步未记录跨参与方的状态读取。';
    turnLog.replaceChildren();
    for (const event of events) {
      const item = node(event.actor ? 'button' : 'div', 'turn-event');
      const actor = event.actor;
      if (actor) {
        (item as HTMLButtonElement).type = 'button';
        item.onclick = () => { active = actor; render(); };
      }
      item.append(node('span', undefined, names.get(actor ?? '') ?? '全局状态'),
        node('strong', undefined, rules.get(event.rule) ?? event.rule),
        node('span', undefined, display(event.before) + ' → ' + display(event.after)));
      turnLog.append(item);
    }
    if (!events.length) turnLog.append(node('p', 'model-note', '模型在此步没有记录状态变化。'));
    prev.disabled = round === 1;
    next.disabled = round === maxRound;
    label.textContent = '第 ' + round + ' / ' + maxRound + ' 步';
    slider.value = String(round);
    slider.setAttribute('aria-valuetext', label.textContent);
    info.replaceChildren(node('h4', undefined, names.get(active)));
    const profile = model.actors.find(({ id }) => id === active);
    if (profile?.objective) {
      const note = node('p', 'model-note', profile.objective);
      if (profile.basis) note.append(references(bundle, profile.basis));
      info.append(note);
    }
    const actions = events.filter(({ actor }) => actor === active);
    if (!actions.length) info.append(node('p', 'model-note', '本步没有此方的行动记录。'));
    for (const event of actions) {
      const action = node('div', 'actor-action');
      action.append(node('strong', undefined, rules.get(event.rule) ?? event.rule));
      const summary = node('p', undefined, event.indeterminate ? '结果待定' : display(event.after));
      summary.append(references(bundle, event.basis));
      action.append(summary);
      if (event.observations?.length) {
        action.append(node('p', 'model-note', '当时读取 · ' + event.observations
          .map(({ field, value }) => (fields.get(field) ?? field) + '＝' + display(value)).join('、')));
      }
      if (event.candidates?.length) {
        const alternatives = node('ul', 'actor-links');
        for (const item of event.candidates) {
          const label = display(item.action) + ' · ' + (item.feasible === true ? '可行，效用 ' + display(item.utility) :
            item.feasible === false ? '当前不可行' : '可行性待定');
          const row = node('li', undefined, label);
          row.append(references(bundle, item.basis));
          alternatives.append(row);
        }
        action.append(alternatives);
      } else if (event.utilities?.length) {
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
  function pause() {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    play.textContent = '自动播放';
    play.setAttribute('aria-pressed', 'false');
  }
  prev.onclick = () => { pause(); jump(round - 1); };
  next.onclick = () => { pause(); jump(round + 1); };
  slider.oninput = () => { pause(); jump(slider.valueAsNumber); };
  play.disabled = maxRound < 2;
  play.onclick = () => {
    if (timer !== undefined) { pause(); return; }
    if (round === maxRound) jump(1);
    play.textContent = '暂停';
    play.setAttribute('aria-pressed', 'true');
    timer = window.setInterval(() => {
      if (!board.isConnected || round >= maxRound) { pause(); return; }
      jump(round + 1);
      if (round >= maxRound) pause();
    }, 950);
  };
  scenario.select.onchange = decision.select.onchange = () => { pause(); jump(1); };
  jump(1);
  return board;
}
