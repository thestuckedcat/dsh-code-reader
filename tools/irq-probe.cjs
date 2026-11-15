// S4-prep T41 async/IRQ dsh-web probe (verifier-owned; read-only).
//
// Env:
//   RV_URL, RV_OUT, RV_SHOT_DIR, RV_TIMEOUT_MS
//   RV_SNAPSHOT_ID, RV_IRQ_SCENARIO, RV_REV1_SCENARIO
//   RV_ASYNC_EVENT (default IRQ), RV_ASYNC_CHIP (default 异步)
//
// Checks (contract docs/scenario-contract.md §11.3):
//   * observed mode: [data-sequence-async="true"] IRQ message + "异步" chip;
//   * static mode: no async marker;
//   * rev1 imported trace (no async declaration): no async marker;
//   * console errors = 0, no absolute path leak, screenshot evidence.
const {app, BrowserWindow} = require('electron');
const {mkdirSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');

const url = process.env.RV_URL;
const outPath = process.env.RV_OUT;
const shotDir = process.env.RV_SHOT_DIR;
const timeoutMs = Number(process.env.RV_TIMEOUT_MS || 600000);
const expectSnapshotId = process.env.RV_SNAPSHOT_ID || null;
const irqScenario = process.env.RV_IRQ_SCENARIO || null;
const rev1Scenario = process.env.RV_REV1_SCENARIO || null;
const asyncEvent = process.env.RV_ASYNC_EVENT || 'IRQ';
const asyncChip = process.env.RV_ASYNC_CHIP || '异步';
const startedAt = Date.now();
const consoleLines = [];
const result = {
  ok: false,
  probe: 'irq',
  started_at_utc: new Date(startedAt).toISOString(),
  steps: {},
  checks: {},
  failed_steps: [],
  observed: {},
  static: {},
  rev1: {},
  console_lines: [],
  console_error_count: null,
  absolute_paths: null,
  screenshots: {},
};

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function writeResult() {
  result.duration_ms = Date.now() - startedAt;
  result.console_error_count = consoleLines.filter((line) => Number(line.level) >= 3).length;
  result.console_lines = consoleLines.slice(0, 400);
  result.ok = Object.values(result.checks).every((value) => value === true);
  result.finished_at_utc = new Date().toISOString();
  if (outPath) {
    try { mkdirSync(join(outPath, '..'), {recursive: true}); } catch { /* ignore */ }
    try { writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8'); } catch { /* ignore */ }
  }
  const code = result.ok === true ? 0 : 1;
  try { app.exit(code); } catch { process.exit(code); }
}

function check(name, ok) {
  result.checks[name] = ok === true;
  if (ok !== true) result.failed_steps.push(name);
  return ok === true;
}

async function waitFor(win, expression, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression).catch(() => false);
    if (value) return value;
    await sleep(250);
  }
  return false;
}

function evaluate(win, expression) {
  return win.webContents.executeJavaScript(expression);
}

async function capturePng(win) {
  try {
    const image = await win.webContents.capturePage();
    return {ok: true, bytes: image.toPNG()};
  } catch (error) {
    return {ok: false, error: String(error && error.message ? error.message : error)};
  }
}

async function dismissHostOverlays(win) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await evaluate(win, `(() => {
      const visible = (element) => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      if (dialogs.length === 0) return {done: true, clicked: false};
      for (const dialog of dialogs) {
        const buttons = [...dialog.querySelectorAll('button')].filter(visible);
        const candidate = buttons.find((node) => /稍后|跳过|继续|关闭|close/i.test((node.textContent || '') + (node.getAttribute('aria-label') || '')));
        if (candidate) { candidate.click(); return {done: false, clicked: true}; }
      }
      return {done: false, clicked: false};
    })()`).catch(() => ({done: false, clicked: false}));
    if (state.done === true) return true;
    if (state.clicked !== true) {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
    }
    await sleep(350);
  }
  return false;
}

async function openWorkbench(win) {
  result.steps.sidebar = Boolean(await waitFor(win, `(() => {
    const byAria = [...document.querySelectorAll('[aria-label]')].some((element) => (element.getAttribute('aria-label') || '').includes('代码工作台'));
    return byAria || document.body.textContent.includes('代码工作台');
  })()`, 60000));
  await dismissHostOverlays(win);
  await evaluate(win, `(() => {
    const visible = (element) => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const candidates = [...document.querySelectorAll('button, [role="button"], [data-panel-id]')];
    const button = candidates.find((element) => visible(element) && ((element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '')).includes('代码工作台'));
    if (button) button.click();
    return true;
  })()`).catch(() => null);
  await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000);
  await waitFor(win, `(() => { const s = document.querySelector('[data-code-view="status"]'); return s !== null && s.getAttribute('data-state') === 'ready'; })()`, 40000);
  result.steps.panel = Boolean(await evaluate(win, `document.querySelector('[data-code-view="panel"]') !== null`).catch(() => false));
  const snapshot = expectSnapshotId ?? await evaluate(win, `(() => { const row = document.querySelector('[data-snapshot-id][data-snapshot-status="verified"], [data-snapshot-id]'); return row ? row.getAttribute('data-snapshot-id') : null; })()`).catch(() => null);
  result.snapshot_id = snapshot;
  await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-snapshot-id]')];
    const row = rows.find((element) => element.getAttribute('data-snapshot-id') === ${JSON.stringify(snapshot)});
    if (row) row.click();
    return true;
  })()`).catch(() => null);
  result.steps.snapshot = Boolean(await waitFor(win, `document.querySelectorAll('[data-snapshot-id]').length > 0`, 30000));
  result.steps.entries = Boolean(await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 40000));
  await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === 'bus_send') ?? rows[0];
    if (row) (row.closest('button, [role="button"], li') ?? row).click();
    return true;
  })()`).catch(() => null);
  result.steps.entry_clicked = true;
  await sleep(900);
  return result.steps.panel === true;
}

async function switchSequence(win) {
  await evaluate(win, `(() => { const tab = document.querySelector('[data-code-view="tabs"] button[data-view="sequence"]'); if (tab) tab.click(); return true; })()`).catch(() => null);
  result.steps.sequence_ready = Boolean(await waitFor(win, `(() => { const root = document.querySelector('[data-code-view="view"][data-view="sequence"]'); return root !== null && root.getAttribute('data-state') === 'ready'; })()`, 45000));
  await sleep(600);
  return result.steps.sequence_ready;
}

function asyncCountExpr() {
  return `(() => document.querySelectorAll('[data-sequence-async="true"]').length)()`;
}

async function setObservedScenario(win, scenarioId) {
  return evaluate(win, `(() => {
    const select = document.querySelector('[data-code-view="sequence-scenario"]');
    if (select === null) return {ok: false, reason: 'scenario selector missing'};
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(scenarioId)});
    select.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, value: select.value, options: [...select.options].map((option) => ({value: option.value, text: option.textContent}))};
  })()`).catch((error) => ({ok: false, reason: String(error)}));
}

async function observedDetail(win) {
  return evaluate(win, `(() => {
    const root = document.querySelector('[data-code-view="view"][data-view="sequence"]');
    const panel = root ?? document.querySelector('[data-code-view="panel"]');
    const text = panel === null ? '' : (panel.innerText || '');
    const asyncNodes = [...document.querySelectorAll('[data-sequence-async="true"]')].map((element) => ({
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      parent: (element.parentElement?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
    }));
    const chips = [...(panel?.querySelectorAll('*') ?? [])].filter((element) => {
      const own = (element.textContent || '').trim();
      return own === ${JSON.stringify(asyncChip)} && element.children.length === 0;
    }).map((element) => ({tag: element.tagName, className: String(element.className || ''), text: (element.textContent || '').trim()}));
    const observedRoot = panel?.querySelector('[data-sequence-observed="true"]') !== null;
    const asyncChipNodes = [...document.querySelectorAll('[data-sequence-async-chip]')].map((element) => ({text: (element.textContent || '').trim().slice(0, 80), className: String(element.className || '')}));
    const asyncNoteNodes = [...document.querySelectorAll('[data-sequence-async-note]')].map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240));
    return {observed_root: observedRoot, async_nodes: asyncNodes, async_count: asyncNodes.length, chips, async_chip_attr_count: asyncChipNodes.length, async_chip_nodes: asyncChipNodes, async_note_count: asyncNoteNodes.length, async_notes: asyncNoteNodes, text: text.replace(/\\s+/g, ' ').slice(0, 1200)};
  })()`).catch(() => ({observed_root: false, async_nodes: [], async_count: 0, chips: [], async_chip_attr_count: 0, async_chip_nodes: [], async_note_count: 0, async_notes: [], text: ''}));
}

async function absolutePathLeak(win) {
  return evaluate(win, `(() => {
    const panel = document.querySelector('[data-code-view="panel"]');
    const text = panel === null ? document.body.innerText : panel.innerText;
    const matches = String(text || '').match(/[A-Za-z]:[\\\\/][^\\s"'<>]*/g) || [];
    return {count: matches.length, samples: matches.slice(0, 10)};
  })()`).catch(() => ({count: 0, samples: []}));
}

async function screenshot(win, name) {
  await dismissHostOverlays(win).catch(() => null);
  await sleep(500);
  const capture = await capturePng(win);
  if (capture.ok && shotDir) {
    mkdirSync(shotDir, {recursive: true});
    const path = join(shotDir, `${name}.png`);
    writeFileSync(path, capture.bytes);
    result.screenshots[name] = {path, bytes: capture.bytes.length};
  } else {
    result.screenshots[name] = {ok: false, error: capture.error ?? 'capture failed'};
  }
  return result.screenshots[name];
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({show: false, width: 1500, height: 950, webPreferences: {contextIsolation: true, sandbox: false, backgroundThrottling: false}});
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message).slice(0, 400);
      if (text.includes('Electron Security Warning')) return;
      consoleLines.push({level, message: text, at_ms: Date.now() - startedAt});
    });
    await win.loadURL(url);
    result.steps.page_loaded = true;
    try { win.setOpacity(0); win.showInactive(); result.steps.window_invisible = true; } catch { result.steps.window_invisible = false; }
    await waitFor(win, 'document.body && document.body.innerText.length > 100', 60000);
    await sleep(900);
    check('workbench_open', await openWorkbench(win));
    check('sequence_ready', await switchSequence(win));

    // static mode must not show async markers
    const staticBefore = await observedDetail(win);
    result.static = {async_count: staticBefore.async_count, chips: staticBefore.chips.length, text: staticBefore.text.slice(0, 400)};
    check('static_no_async_marker', staticBefore.async_count === 0);

    // observed mode with the IRQ ledger
    await evaluate(win, `(() => { const button = document.querySelector('[data-sequence-mode="observed"]'); if (button) button.click(); return true; })()`).catch(() => null);
    await sleep(1200);
    result.steps.observed_enabled = Boolean(await evaluate(win, `(() => { const button = document.querySelector('[data-sequence-mode="observed"]'); return button !== null && button.disabled !== true; })()`).catch(() => false));
    if (irqScenario !== null) {
      result.scenario_select = await setObservedScenario(win, irqScenario);
      await sleep(800);
    }
    const markerSeen = await waitFor(win, `${asyncCountExpr()} > 0`, 25000);
    result.steps.async_marker_seen = markerSeen !== false;
    await sleep(700);
    const observed = await observedDetail(win);
    const observedText = `${observed.text}\n${observed.async_nodes.map((node) => node.parent + ' ' + node.text).join('\n')}`;
    result.observed = observed;
    result.observed.async_event_present = observedText.includes(asyncEvent);
    check('observed_async_marker', observed.async_count > 0);
    check('observed_irq_message', observed.async_count > 0 && result.observed.async_event_present);
    check('observed_async_chip', observed.chips.length > 0 || observed.async_chip_attr_count > 0 || observedText.includes(asyncChip));
    check('observed_async_chip_attr', observed.async_chip_attr_count > 0 && observed.async_chip_nodes.some((node) => node.text.includes(asyncChip)));
    check('observed_async_note', observed.async_note_count > 0 && observed.async_notes.every((note) => note.includes(asyncChip) && /台账|已执行|导入/.test(note)));
    check('observed_root', observed.observed_root === true);
    check('static_vs_observed_diff', staticBefore.async_count === 0 && observed.async_count > 0);

    // rev1 imported trace (no async declaration): no marker
    if (rev1Scenario !== null) {
      result.rev1_select = await setObservedScenario(win, rev1Scenario);
      await sleep(1800);
      const rev1 = await observedDetail(win);
      result.rev1 = {async_count: rev1.async_count, chips: rev1.chips.length, text: rev1.text.slice(0, 400)};
      check('rev1_no_async_marker', rev1.async_count === 0);
    } else {
      check('rev1_no_async_marker', false);
    }

    // static again must remain free of async markers
    await evaluate(win, `(() => { const button = document.querySelector('[data-sequence-mode="static"]'); if (button) button.click(); return true; })()`).catch(() => null);
    await sleep(700);
    const staticAfter = await observedDetail(win);
    result.static_after = {async_count: staticAfter.async_count};
    check('static_after_no_async_marker', staticAfter.async_count === 0);

    // back to IRQ observed state for the evidence screenshot
    await evaluate(win, `(() => { const button = document.querySelector('[data-sequence-mode="observed"]'); if (button) button.click(); return true; })()`).catch(() => null);
    await sleep(600);
    if (irqScenario !== null) { await setObservedScenario(win, irqScenario); }
    await waitFor(win, `${asyncCountExpr()} > 0`, 20000);
    await sleep(500);
    result.absolute_paths = await absolutePathLeak(win);
    check('no_absolute_paths', result.absolute_paths.count === 0);
    check('console_errors_zero', consoleLines.filter((line) => Number(line.level) >= 3).length === 0);
    const shot = await screenshot(win, 'async-irq');
    check('screenshot', shot !== undefined && shot.ok !== false && shot.bytes > 0);

    result.steps.window_closed = true;
    win.destroy();
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    result.ok = false;
  } finally {
    writeResult();
  }
});

setTimeout(() => {
  result.timeout = true;
  result.ok = false;
  writeResult();
}, timeoutMs);
