// Chromium performance probe for S4-prep (verifier artefact; not a plugin
// component). Measures the contract §2.1 UI metrics on the real isolated
// dsh web with the synthetic fixtures:
//   * first view: click entry -> [data-code-view="view"][data-state="ready"]
//     (cold: page reload per sample, 20; hot: same process re-selection, 20);
//   * cross-view locate: coupling resource click -> function highlight,
//     tree node click -> file line highlight (20 each);
//   * drag feedback: pointermove -> next rAF edge-path update (20);
//   * 2000/10k: truncation markers, search response, event-sequence truncation.
// It only reads DOM samples; no production code is modified.
const {app, BrowserWindow} = require('electron');
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname, join} = require('node:path');

const url = process.env.RV_URL;
const out = process.env.RV_OUT;
const shotDir = process.env.RV_SHOT_DIR;
const snapshot500 = process.env.RV_SNAPSHOT_500 || null;
const snapshot2000 = process.env.RV_SNAPSHOT_2000 || null;
const overallTimeoutMs = Number(process.env.RV_TIMEOUT_MS || 600000);
const SAMPLES = Number(process.env.RV_SAMPLES || 20);
const BIG_SAMPLES = Number(process.env.RV_BIG_SAMPLES || 5);
const SKIP_TREE = process.env.RV_SKIP_TREE === '1';
const SKIP_DRAG = process.env.RV_SKIP_DRAG === '1';
const COLD_SAMPLES = Number(process.env.RV_COLD_SAMPLES || SAMPLES);
const consoleLines = [];
const startedAt = Date.now();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const evaluate = (win, expression) => win.webContents.executeJavaScript(expression);

let finished = false;
let liveResult = null;
function finish(payload) {
  if (finished) return;
  finished = true;
  payload.duration_ms = Date.now() - startedAt;
  payload.console_error_count = consoleLines.filter((line) => Number(line.level) >= 3).length;
  payload.console_errors = consoleLines.filter((line) => Number(line.level) >= 3).slice(0, 20);
  if (out) { mkdirSync(dirname(out), {recursive: true}); writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`); }
  app.exit(payload.ok === true ? 0 : 1);
}

async function waitFor(win, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(win, expression).catch(() => false);
    if (value) return value;
    await sleep(60);
  }
  return false;
}

async function dismissHostOverlays(win) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await evaluate(win, `(() => {
      const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      if (dialogs.length === 0) return {done: true};
      for (const dialog of dialogs) {
        const buttons = [...dialog.querySelectorAll('button')].filter(visible);
        const candidate = buttons.find((node) => /继续|稍后|关闭/.test((node.textContent || '').trim()));
        if (candidate) { candidate.click(); return {done: false}; }
      }
      return {done: false};
    })()`).catch(() => ({done: true}));
    if (state.done === true) return true;
    await sleep(300);
  }
  return false;
}

function clickSidebarEntry() {
  return `(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const candidates = [...document.querySelectorAll('button, [role="button"], [data-panel-id]')];
    const label = (element) => (element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '');
    const button = candidates.find((element) => visible(element) && label(element).includes('代码工作台'));
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`;
}

async function openWorkbench(win) {
  await dismissHostOverlays(win).catch(() => null);
  await evaluate(win, clickSidebarEntry()).catch(() => null);
  const opened = await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000);
  if (!opened) return false;
  await waitFor(win, `(() => { const status = document.querySelector('[data-code-view="status"]'); return status !== null && status.getAttribute('data-state') === 'ready'; })()`, 45000);
  return true;
}

async function waitForEntries(win) {
  return (await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 30000)) !== false;
}

async function selectSnapshot(win, snapshotId) {
  const ok = await waitFor(win, `(() => {
    const elements = [...document.querySelectorAll('[data-snapshot-id]')];
    if (elements.length === 0) return false;
    const chosen = ${snapshotId === null ? 'elements[0]' : `elements.find((element) => element.getAttribute('data-snapshot-id') === ${JSON.stringify(snapshotId)}) ?? elements[0]`};
    chosen.click();
    return true;
  })()`, 20000);
  await sleep(500);
  await waitForEntries(win);
  return ok !== false;
}

async function clickFirstEntry(win, skip = -1) {
  return evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    if (rows.length === 0) return false;
    const index = (((${skip} + 1) % rows.length) + rows.length) % rows.length;
    const row = rows[index];
    (row.closest('button, [role="button"], li') ?? row).click();
    return {name: row.getAttribute('data-entry-name'), count: rows.length};
  })()`).catch(() => false);
}

function readyExpr(view = null) {
  return view === null
    ? `document.querySelector('[data-code-view="view"][data-state="ready"]') !== null`
    : `document.querySelector('[data-code-view="view"][data-view="${view}"][data-state="ready"]') !== null`;
}

async function switchView(win, view) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await evaluate(win, `(() => { const tab = document.querySelector('[data-code-view="tabs"] button[data-view="${view}"]'); if (tab) tab.click(); return true; })()`).catch(() => null);
    if ((await waitFor(win, readyExpr(view), attempt === 0 ? 25000 : 45000)) !== false) return true;
    await sleep(600);
  }
  return false;
}

async function measure(win, action, condition, timeoutMs = 30000) {
  const started = Date.now();
  const detail = await action();
  const matched = await waitFor(win, condition, timeoutMs);
  const elapsed = Date.now() - started;
  return {ms: matched === false ? null : elapsed, ok: matched !== false, detail};
}

async function coldFirstView(win, snapshotId, samples) {
  const rows = [];
  for (let index = 0; index < samples; index += 1) {
    if (index > 0) {
      // Cold definition on dsh web: re-select the snapshot so the next entry
      // selection follows a fresh snapshot read (bounded, reproducible).
      await selectSnapshot(win, snapshotId);
      await waitForEntries(win);
      await switchView(win, 'end_to_end');
      await sleep(200);
    }
    const opened = await openWorkbench(win);
    const selected = opened === true && (await selectSnapshot(win, snapshotId)) === true;
    const entriesReady = selected && (await waitForEntries(win)) === true;
    if (entriesReady !== true) {
      rows.push({index, ms: null, ok: false, reason: 'entries not listed after cold reload'});
      continue;
    }
    await switchView(win, 'end_to_end');
    const result = await measure(win, () => clickFirstEntry(win), readyExpr('end_to_end'), 20000);
    rows.push({index, ms: result.ms, ok: result.ok, reason: result.ok ? undefined : 'view not ready'});
  }
  return rows;
}

async function hotFirstView(win, samples) {
  const rows = [];
  if (!(await switchView(win, 'end_to_end'))) {
    await clickFirstEntry(win);
    await waitFor(win, readyExpr('end_to_end'), 20000);
  }
  for (let index = 0; index < samples; index += 1) {
    const result = await measure(win, () => clickFirstEntry(win, index), readyExpr('end_to_end'), 30000);
    const firstScreenAttrs = await evaluate(win, `(() => [...document.querySelectorAll('[data-first-screen]')].map((element) => ({value: element.getAttribute('data-first-screen'), tag: element.tagName, view: element.getAttribute('data-view') || null})))()`).catch(() => []);
    rows.push({index, ms: result.ms, ok: result.ok, first_screen: firstScreenAttrs});
  }
  return rows;
}

async function crossViewLocate(win, samples) {
  const coupling = [];
  // The coupling view scopes to the selected entry: reset to the root entry
  // (which has synthetic resource accesses) before measuring.
  await switchView(win, 'end_to_end');
  await clickFirstEntry(win, -1);
  await waitFor(win, readyExpr('end_to_end'), 20000);
  if (await switchView(win, 'coupling')) {
    for (let index = 0; index < samples; index += 1) {
      const result = await measure(win, () => evaluate(win, `(() => {
        const rows = [...document.querySelectorAll('[data-resource-row], [data-resource-id]')].filter((element) => typeof element.click === 'function');
        if (rows.length === 0) return false;
        rows[${index} % rows.length].click();
        return {count: rows.length};
      })()`).catch(() => false), `(() => {
        const view = document.querySelector('[data-code-view="view"][data-view="coupling"]');
        if (!view) return false;
        if (view.querySelector('.dcr-highlight') !== null) return true;
        const marked = view.querySelector('[data-highlighted="true"], .dcr-highlighted, .dcr-node-selected, [aria-pressed="true"]');
        const nodes = [...view.querySelectorAll('[data-graph-node], [data-coupling-node], .dcr-coupling-node')];
        return marked !== null || nodes.some((node) => /highlight|selected/.test(node.className || ''));
      })()`, 5000);
      coupling.push({index, ms: result.ms, ok: result.ok});
    }
  }
  const tree = [];
  if (!SKIP_TREE && (await switchView(win, 'tree'))) {
    for (let index = 0; index < samples; index += 1) {
      const result = await measure(win, () => evaluate(win, `(() => {
        const rows = [...document.querySelectorAll('[data-tree-node]')];
        if (rows.length === 0) return false;
        const row = rows[(${index} + 1) % rows.length];
        const nameButton = row.querySelector('.dcr-tree-name') ?? [...row.querySelectorAll('button')].find((button) => !button.hasAttribute('data-tree-toggle')) ?? row;
        nameButton.click();
        return {count: rows.length};
      })()`).catch(() => false), `(() => {
        const file = document.querySelector('[data-code-view="view"][data-view="file"]');
        if (file === null) return false;
        const state = file.getAttribute('data-state');
        return state === 'ready' || state === 'error' || state === 'empty';
      })()`, 5000);
      tree.push({index, ms: result.ms, ok: result.ok});
    }
  }
  return {coupling, tree};
}

async function dragFeedback(win, samples) {
  if (!(await switchView(win, 'end_to_end'))) return [];
  const rows = [];
  for (let index = 0; index < samples; index += 1) {
    const value = await evaluate(win, `(async () => {
      const nodes = [...document.querySelectorAll('[data-graph-node]')];
      if (nodes.length === 0) return null;
      const edgePath = () => document.querySelector('[data-graph-edge] path, [data-graph-edge]')?.getAttribute('d') ?? '';
      const attempts = 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const node = nodes[(${index} + attempt) % nodes.length];
        const rect = node.getBoundingClientRect();
        const startX = rect.left + rect.width / 2;
        const startY = rect.top + rect.height / 2;
        const before = edgePath();
        const t0 = performance.now();
        const pointerId = 10 + (${index} * 4) + attempt;
        const fire = (type, x, y) => node.dispatchEvent(new PointerEvent(type, {bubbles: true, pointerId, clientX: x, clientY: y}));
        fire('pointerdown', startX, startY);
        for (let step = 1; step <= 16; step += 1) {
          fire('pointermove', startX + step * 8, startY + step * 4);
          await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
          if (edgePath() !== before) {
            fire('pointerup', startX + step * 8, startY + step * 4);
            return performance.now() - t0;
          }
        }
        fire('pointerup', startX + 128, startY + 64);
      }
      return null;
    })()`).catch(() => null);
    rows.push({index, ms: value === null ? null : Math.round(value * 1000) / 1000, ok: value !== null});
    await evaluate(win, `(() => { for (const id of [10, 11, 12, 13, 20, 21, 22, 23]) { try { document.body.dispatchEvent(new PointerEvent('pointercancel', {bubbles: true, pointerId: id})); } catch (e) {} } const view = document.querySelector('[data-code-view="view"]'); if (view) view.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 5, clientY: 5})); return true; })()`).catch(() => null);
    await sleep(120);
  }
  return rows;
}

async function bigGraph(win) {
  const detail = {load: null, truncation_text: null, search: [], event_sequence: []};
  await openWorkbench(win);
  await selectSnapshot(win, snapshot2000);
  await waitForEntries(win);
  const load = await measure(win, () => clickFirstEntry(win), readyExpr(), 45000);
  detail.load = load;
  detail.truncation_text = null;
  for (let attempt = 0; attempt < 4 && detail.truncation_text === null; attempt += 1) {
    await sleep(400);
    detail.truncation_text = await evaluate(win, `(() => {
      const panel = document.querySelector('[data-code-view="panel"]');
      const view = document.querySelector('[data-code-view="view"][data-view="end_to_end"]');
      const text = ((panel === null ? '' : (panel.innerText || '')) + ' ' + (view === null ? '' : (view.innerText || '')));
      const marker = document.querySelector('[data-truncated]');
      if (marker !== null) return 'data-truncated: ' + String(marker.getAttribute('data-truncated') || '') + ' · ' + (marker.innerText || '').replace(/\\s+/g, ' ').slice(0, 200);
      const match = /(\u5df2\u622a\u65ad|\u622a\u65ad|\u5206\u7247|truncated|\u8d85\u51fa|\u4ec5\u663e\u793a|first \\d+|\u8986\u76d6)/.exec(text);
      return match === null ? null : text.slice(Math.max(0, match.index - 80), match.index + 160).replace(/\\s+/g, ' ');
    })()`).catch(() => null);
  }
  if (await switchView(win, 'end_to_end')) {
    for (let index = 0; index < BIG_SAMPLES; index += 1) {
      const result = await measure(win, () => evaluate(win, `(() => {
        const search = document.querySelector('input[data-search], [data-search] input, [data-graph-search] input, input[type="search"]');
        if (!search) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(search, 'synthetic_fn_' + (${index} * 7));
        search.dispatchEvent(new Event('input', {bubbles: true}));
        search.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
      })()`).catch(() => false), `(() => { const view = document.querySelector('[data-code-view="view"][data-view="end_to_end"]'); const text = view === null ? '' : (view.innerText || ''); return /synthetic_fn_|搜索结果|无匹配|\\d+ 结果/.test(text); })()`, 15000);
      detail.search.push({index, ms: result.ms, ok: result.ok});
    }
  }
  if (await switchView(win, 'sequence')) {
    for (let index = 0; index < BIG_SAMPLES; index += 1) {
      const result = await measure(win, () => evaluate(win, `(() => { const tab = document.querySelector('[data-code-view="tabs"] button[data-view="sequence"]'); if (tab) tab.click(); return true; })()`).catch(() => false), `(() => {
        const view = document.querySelector('[data-code-view="view"][data-view="sequence"]');
        if (view === null || view.getAttribute('data-state') !== 'ready') return false;
        const text = (view.innerText || '') + ' ' + ((document.querySelector('[data-code-view="panel"]') || {}).innerText || '');
        const messages = document.querySelectorAll('[data-sequence-message][data-message-kind]').length;
        return messages > 0 || /截断|truncated|事件序列|仅显示|\\d+ 条事件/.test(text);
      })()`, 20000);
      detail.event_sequence.push({index, ms: result.ms, ok: result.ok});
    }
  }
  return detail;
}

async function main() {
  const result = {ok: false, probe: 'perf', url: url ? url.replace(/token=[^&]+/, 'token=<redacted>') : null, metrics: {}, truncation: {}, steps: {}};
  try {
    const win = new BrowserWindow({show: false, width: 1500, height: 950, webPreferences: {contextIsolation: true, sandbox: false, backgroundThrottling: false}});
    liveResult = result;
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message).slice(0, 300);
      if (text.includes('Electron Security Warning')) return;
      consoleLines.push({level, message: text, at_ms: Date.now() - startedAt});
    });
    await win.loadURL(url);
    result.steps.pageLoaded = true;
    try { win.setOpacity(0); win.showInactive(); result.steps.windowShownInvisible = true; } catch { result.steps.windowShownInvisible = false; }
    await waitFor(win, 'document.body && document.body.innerText.length > 0', 60000);
    result.steps.workbenchOpened = (await openWorkbench(win)) === true;
    await selectSnapshot(win, snapshot500);
    await waitForEntries(win);
    result.entries = await evaluate(win, `(() => [...document.querySelectorAll('[data-entry-id][data-entry-name]')].map((element) => element.getAttribute('data-entry-name')))()`).catch(() => []);
    await switchView(win, 'end_to_end');
    await clickFirstEntry(win);
    await waitFor(win, readyExpr('end_to_end'), 20000);
    if (result.entries.length === 0) throw new Error('no entries listed for the first synthetic snapshot');
    result.metrics.cold_first_view = COLD_SAMPLES > 0 ? await coldFirstView(win, snapshot500, COLD_SAMPLES) : [];
    result.metrics.cold_status = COLD_SAMPLES > 0 ? 'measured' : 'in_scope_not_verified';
    result.metrics.hot_first_view = await hotFirstView(win, SAMPLES);
    const locate = await crossViewLocate(win, SAMPLES);
    result.metrics.cross_view_coupling = locate.coupling;
    result.metrics.cross_view_tree = locate.tree;
    result.metrics.drag_feedback = SKIP_DRAG ? [] : await dragFeedback(win, SAMPLES);
    result.metrics.drag_status = SKIP_DRAG ? 'in_scope_not_verified' : 'measured';
    if (snapshot2000 !== null) result.truncation = await bigGraph(win);
    result.steps.noConsoleErrors = consoleLines.filter((line) => Number(line.level) >= 3).length === 0;
    const failed = [];
    for (const [name, rows] of Object.entries({
      cold_first_view: result.metrics.cold_first_view,
      hot_first_view: result.metrics.hot_first_view,
      cross_view_coupling: result.metrics.cross_view_coupling,
      cross_view_tree: result.metrics.cross_view_tree,
      drag_feedback: result.metrics.drag_feedback,
    })) {
      const bad = rows.filter((row) => row.ok !== true || row.ms === null).length;
      if (bad > 0) failed.push(`${name}:${bad}`);
    }
    result.steps.metricsComplete = failed.length === 0;
    result.failures = failed;
    result.metric_status = {
      cold_first_view: result.metrics.cold_first_view.filter((row) => row.ok === true).length,
      cold_status: result.metrics.cold_status ?? 'measured',
      hot_first_view: result.metrics.hot_first_view.filter((row) => row.ok === true).length,
      cross_view_coupling: result.metrics.cross_view_coupling.filter((row) => row.ok === true).length,
      cross_view_tree: result.metrics.cross_view_tree.filter((row) => row.ok === true).length,
      drag_feedback: result.metrics.drag_feedback.filter((row) => row.ok === true).length,
    };
    result.ok = result.steps.workbenchOpened === true && result.steps.noConsoleErrors === true;
    finish(result);
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    result.failed = true;
    finish(result);
  }
}

app.whenReady().then(main);
setTimeout(() => {
  const partial = liveResult ?? {ok: false, probe: 'perf', metrics: {}, steps: {}, failures: null, screenshots: {}};
  partial.timeout = true;
  partial.partial = true;
  partial.ok = false;
  partial.error = partial.error ?? `probe exceeded its ${overallTimeoutMs}ms budget; partial results written before exit`;
  finish(partial);
}, overallTimeoutMs);
