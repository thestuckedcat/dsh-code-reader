function initSequenceView() {
  const form = byId('sequence-form');
  const list = byId('sequence-steps');
  const chart = byId('sequence-chart');
  const statusLine = byId('sequence-status');
  const runButton = byId('sequence-run');
  const buildStep = (name) => ({ name, args: interfaceFields[name].map(([, value]) => value) });
  const steps = ['bus_register', 'bus_send'].map(buildStep);
  let generated = false;

  function reorder(from, to) {
    [steps[from], steps[to]] = [steps[to], steps[from]];
    renderSteps();
    list.children[to].querySelector('select').focus();
  }

  function renderSteps() {
    list.replaceChildren(...steps.map((step, index) => {
      const row = el('div', 'sequence-step');
      row.dataset.step = index + 1;
      const choice = el('label', '', `接口 ${index + 1}`);
      const select = el('select', '');
      for (const name of Object.keys(interfaceFields)) {
        const option = el('option', '', `${name}()`);
        option.value = name;
        option.selected = name === step.name;
        select.append(option);
      }
      select.addEventListener('change', () => {
        steps[index] = buildStep(select.value);
        renderSteps();
        list.children[index].querySelector('select').focus();
      });
      choice.append(select);
      row.append(choice);

      const args = el('div', 'sequence-args');
      for (const [position, [name, , min, max]] of interfaceFields[step.name].entries()) {
        const label = el('label', '', name);
        const input = el('input', '');
        Object.assign(input, { type: 'number', min, max, required: true, value: step.args[position] });
        input.addEventListener('input', () => {
          step.args[position] = input.valueAsNumber;
          warnPreviousDiagram();
        });
        label.append(input);
        args.append(label);
      }
      if (args.childElementCount) row.append(args);

      const actions = el('div', 'side-actions');
      for (const [label, disabled, action] of [
        ['上移', index === 0, () => reorder(index, index - 1)],
        ['下移', index === steps.length - 1, () => reorder(index, index + 1)],
        ['移除', false, () => { steps.splice(index, 1); renderSteps(); }],
      ]) {
        const button = el('button', '', label);
        button.type = 'button';
        button.disabled = disabled;
        button.addEventListener('click', action);
        actions.append(button);
      }
      row.append(actions);
      return row;
    }));
    runButton.disabled = steps.length === 0;
    warnPreviousDiagram();
  }

  function warnPreviousDiagram() {
    if (generated) statusLine.textContent = '接口顺序或参数已修改。下方保留上次结果。';
  }

  const caller = 0;
  const driver = 1;
  const state = 2;
  const platform = 3;
  const register = 4;
  const traceRoutes = new Map([
    [events.DEFAULT_ROUTE, [state, driver]], [events.STORE_ROUTE, [driver, state]],
    [events.LOOKUP, [state, driver]], [events.CHECK_LENGTH, [driver, driver]],
    [events.TRANSFER, [driver, driver]], [events.STAGE, [driver, state]],
    [events.LOCK, [driver, state]], [events.IRQ, [driver, state]],
  ]);

  function messages({ name, args, result, observed }) {
    const destination = name === 'set_platform_stub' ? platform : driver;
    const rows = [{ from: caller, to: destination, label: `${name}(${args.join(', ')})`, call: name }];
    const add = (from, to, label, type = '') => rows.push({ from, to, label, type });
    for (const [event, a, b, value] of observed) {
      const route = traceRoutes.get(event);
      if (route) add(...route, describe[event][1](a, b, value));
      if (event === events.LIBRARY) {
        add(driver, platform, `platform_write(${hex(a, 4)}, ${hex(b, 8)})`);
        if (value) add(platform, driver, `平台返回 ${value}`, 'error');
      } else if (event === events.WRITE) {
        add(platform, register, `TX_DOORBELL ← ${hex(b, 8)}`);
        add(platform, driver, '平台返回 0', 'return');
      }
    }
    add(destination, caller, `返回 ${result ?? 'void'}`, result < 0 ? 'error' : 'return');
    return rows;
  }

  function draw(log) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs = {}, content) => {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (content !== undefined) node.textContent = content;
      return node;
    };
    const participants = ['调用方', '驱动', '驱动资源', '平台库', '模拟寄存器'];
    const columns = participants.map((_, index) => 97 + index * 214);
    const width = columns.at(-1) + 97;
    const sections = log.map((step) => ({ name: step.name, rows: messages(step) }));
    const height = 70 + sections.reduce((sum, section) => sum + 23 + section.rows.length * 37, 0);
    const timeline = svg('svg', { class: 'sequence-svg', width, height, viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': '按本次 C 执行事件绘制的时序图' });
    const defs = svg('defs');
    for (const [type, color] of [['call', '#91c6ef'], ['return', '#83ceb0'], ['error', '#f19a94']]) {
      const marker = svg('marker', { id: `sequence-${type}`, markerWidth: 8, markerHeight: 8, refX: 8, refY: 4,
        orient: 'auto', markerUnits: 'userSpaceOnUse' });
      marker.append(svg('path', { d: 'M0 0L8 4L0 8Z', fill: color }));
      defs.append(marker);
    }
    timeline.append(defs);

    for (const [index, name] of participants.entries()) {
      const x = columns[index];
      timeline.append(svg('line', { class: 'sequence-lane', x1: x, x2: x, y1: 45, y2: height - 10 }),
        svg('rect', { x: x - 72, y: 12, width: 144, height: 32, rx: 4, fill: '#223244', stroke: '#587795' }),
        svg('text', { x, y: 32, 'text-anchor': 'middle' }, name));
    }

    let y = 62;
    for (const [index, section] of sections.entries()) {
      timeline.append(svg('rect', { x: 9, y: y - 12, width: width - 18, height: 22, rx: 3, fill: '#243448' }),
        svg('text', { x: 18, y: y + 3, class: 'sequence-muted' }, `${index + 1} · ${section.name}()`));
      y += 23;
      for (const { from, to, label, type, call } of section.rows) {
        const a = columns[from];
        const b = columns[to];
        const self = a === b;
        const line = self ? `M${a} ${y}h52v14h-52` : `M${a} ${y}H${b}`;
        const arrow = svg('path', { d: line, class: `sequence-arrow ${type ?? ''}`, 'marker-end': `url(#sequence-${type || 'call'})` });
        const annotation = svg('text', { x: self ? a + 6 : (a + b) / 2, y: y - 4,
          'text-anchor': self ? 'start' : 'middle', class: type === 'error' ? 'error-label' : '' }, label);
        if (call) annotation.dataset.call = call;
        timeline.append(arrow, annotation);
        y += 37;
      }
    }
    chart.replaceChildren(timeline);
    chart.scrollTo(0, 0);
  }

  byId('sequence-add').addEventListener('click', () => {
    steps.push(buildStep('bus_send'));
    renderSteps();
    list.lastElementChild.querySelector('select').focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (steps.length === 0) return;
    form.inert = true;
    statusLine.textContent = '正在执行 C 样例…';
    try {
      const observed = [];
      const { instance } = await instantiateFixture((...event) => observed.push(event));
      const runtime = instance.exports;
      runtime.reset();
      const log = steps.map(({ name, args }) => {
        observed.length = 0;
        const result = runtime[name](...args);
        return { name, args, result, observed: [...observed] };
      });
      draw(log);
      generated = true;
      statusLine.textContent = `已执行 ${log.length} 个接口 · 纵轴为事件顺序`;
    } catch (error) {
      statusLine.textContent = `时序生成失败：${error.message}`;
    } finally {
      form.inert = false;
    }
  });
  renderSteps();
}

initSequenceView();
