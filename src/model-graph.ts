import { reads } from './agent-graph.ts';
import type { Bundle, Expr, Model, Scalar } from './schema.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

const signs = { and: '且', or: '或', not: '非', eq: '=', lt: '<', lte: '≤', gt: '>', gte: '≥',
  add: '+', sub: '−', mul: '×', div: '÷' };

function expression(value: Expr, names: Map<string, string>): string {
  if (value === null) return '待定';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value !== 'object') return String(value);
  if ('ref' in value) return names.get(value.ref) ?? value.ref;
  return value.op === 'not' ? '非（' + expression(value.args[0], names) + '）' :
    '（' + value.args.map((arg) => expression(arg, names)).join(' ' + signs[value.op] + ' ') + '）';
}

type Transition = Model['rules'][number] | NonNullable<Model['policies']>[number];

export function drawModelGraph(bundle: Bundle, references: (bundle: Bundle, ids: string[]) => HTMLElement) {
  const model = bundle.model!;
  const variables = new Map(model.variables.map((item) => [item.id, item]));
  const names = new Map(model.variables.map(({ id, label }) => [id, label]));
  const actors = new Map(model.actors.map(({ id, label }) => [id, label]));
  const transitions: Transition[] = [...(model.policies ?? []), ...model.rules];
  const section = el('section', 'monitor model-graph');
  section.id = 'model-structure';
  section.append(el('h3', undefined, '模型结构'));
  const controls = el('label', 'model-rule-select', '查看规则');
  const selector = el('select');
  for (const [index, rule] of transitions.entries()) {
    const option = el('option', undefined, rule.label);
    option.value = String(index);
    selector.append(option);
  }
  controls.append(selector);
  section.append(controls);

  const graph = el('div', 'rule-diagram');
  const describe = el('p', 'model-note', '各方按上一轮可见的状态行动，规则的结果在下一轮生效。');
  section.append(graph, describe);

  function initial(value: Scalar, unit?: string) {
    return expression(value, names) + (typeof value === 'number' && unit && unit !== '1' ? ' ' + unit : '');
  }

  function render() {
    const rule = transitions[Number(selector.value)];
    const sourceFields = new Set<string>();
    const readValues = 'actions' in rule ? rule.actions.flatMap(({ when, utility }) => [when, utility]) : [rule.when, rule.value];
    readValues.forEach((expr) => reads(expr, sourceFields));
    const input = el('section', 'rule-node');
    input.append(el('h4', undefined, '读取的条件'));
    for (const id of sourceFields) {
      const field = variables.get(id)!;
      const type = { parameter: '情景参数', state: '状态', decision: '改写条件' }[field.role];
      const item = el('p', 'rule-variable', field.label + ' · ' + type);
      item.append(el('small', undefined, '初值 ' + initial(field.initial, field.unit)));
      if (field.visibility && rule.actor) {
        const visibleAt = field.visibility[rule.actor];
        const visibility = typeof visibleAt === 'number' ? '第 ' + visibleAt + ' 步起可见' : '此方不可见';
        item.append(el('small', undefined, visibility));
      }
      input.append(item);
    }
    if (!sourceFields.size) input.append(el('p', undefined, '无外部变量输入'));

    const operation = el('section', 'rule-node rule-operation');
    operation.append(el('h4', undefined, 'actions' in rule ? '行动与效用' : '状态更新规则'),
      el('p', 'rule-owner', (actors.get(rule.actor ?? '') ?? '全局规则') + ' · 第 ' + rule.start + '–' + rule.until + ' 步'));
    if ('actions' in rule) {
      for (const action of rule.actions) {
        const card = el('div', 'rule-action');
        card.append(el('strong', undefined, expression(action.value, names)),
          el('p', undefined, '可行条件 ' + expression(action.when, names)),
          el('p', undefined, '效用 ' + expression(action.utility, names)), references(bundle, action.basis));
        operation.append(card);
      }
    } else {
      operation.append(el('p', undefined, '触发条件 ' + expression(rule.when, names)),
        el('p', undefined, '更新为 ' + expression(rule.value, names)));
    }
    operation.append(references(bundle, rule.basis));

    const target = variables.get(rule.target)!;
    const result = el('section', 'rule-node');
    result.append(el('h4', undefined, '写入的状态'), el('strong', undefined, target.label),
      el('p', undefined, '初值 ' + initial(target.initial, target.unit)));
    if (target.values) result.append(el('p', undefined, '可取值 ' + target.values.join('、')));
    const projections = model.metrics.filter(({ field }) => field === target.id);
    if (projections.length) result.append(el('p', undefined, '对应指标 ' + projections.map(({ label }) => label).join('、')));
    graph.replaceChildren(input, el('span', 'rule-arrow', '→'), operation, el('span', 'rule-arrow', '→'), result);
  }
  selector.onchange = render;
  render();
  return section;
}
