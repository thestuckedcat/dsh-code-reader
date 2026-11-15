// Chromium probe for the S3a controlled-scenario slice (independent verifier
// artefact; not a shipped plugin component).
//
// Asserts docs/scenario-contract.md §7 on the real isolated rc.5 `dsh web`:
//   * stub rail -> profile selection -> step editor (interfaces/args),
//   * scenario A (reset, bus_register(1), bus_send(1,48)): 3 records, results
//     0/0/0, events incl DEFAULT_ROUTE/STORE_ROUTE/REQUEST/LOOKUP/CHECK_LENGTH/
//     TRANSFER/DIRECT/ENCODE/DOORBELL/WRITE, WRITE affects simulated_doorbell,
//     64-hex memory digests,
//   * scenario B (add set_platform_stub(-5) before bus_send): stub step
//     data-stubbed=true, bus_send result -5, no WRITE, LOCK 1->0,
//   * scenario C (bus_send(0,48) -> -2) and invalid args rejection with error
//     code and no new ledger generation,
//   * observed sequence mode: data-sequence-observed=true, messages include
//     bus_send(1, 48)/DOORBELL/WRITE/platform boundary/return 0; static mode
//     restores observed=false,
//   * undo disabled + S3b gap, real-device/compiler/trace-import gaps,
//   * console clean, no absolute-path leak, screenshots.
//
// Mechanisms (invisible opacity-0 window for current composited captures, host
// overlay dismissal, panel recovery) are the same verifier-owned mechanisms as
// tools/five-views-probe.cjs / tools/s2b-probe.cjs.
//
// Environment:
//   RV_URL, RV_OUT, RV_SHOT_DIR, RV_PROFILE_ID (default bus-demo-wasm),
//   RV_SNAPSHOT_ID, RV_TIMEOUT_MS (default 540000)
const {app, BrowserWindow} = require('electron');
const {createHash} = require('node:crypto');
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname, join} = require('node:path');

const url = process.env.RV_URL;
const out = process.env.RV_OUT;
const shotDir = process.env.RV_SHOT_DIR;
const profileId = process.env.RV_PROFILE_ID || 'bus-demo-wasm';
const expectSnapshotId = process.env.RV_SNAPSHOT_ID || null;
const overallTimeoutMs = Number(process.env.RV_TIMEOUT_MS || 540000);
const consoleLines = [];
const startedAt = Date.now();

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function writeResult(payload) {
  try {
    if (out) {
      mkdirSync(dirname(out), {recursive: true});
      writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    }
  } catch (error) {
    console.error('s3 probe result write failed', String(error && error.message ? error.message : error));
  }
}

function finish(payload) {
  payload.duration_ms = Date.now() - startedAt;
  payload.console_lines = consoleLines.slice(0, 400);
  payload.console_error_count = consoleLines.filter((line) => Number(line.level) >= 3).length;
  writeResult(payload);
  app.exit(payload.ok === true ? 0 : 1);
}

async function waitFor(win, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
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
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await evaluate(win, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      if (dialogs.length === 0) return {done: true, clicked: false};
      for (const dialog of dialogs) {
        const buttons = [...dialog.querySelectorAll('button')].filter(visible);
        const byText = (pattern) => buttons.find((node) => pattern.test((node.textContent || '').trim()));
        const byLabel = (pattern) => buttons.find((node) => pattern.test(node.getAttribute('aria-label') || ''));
        const candidate = byText(/稍后|跳过|继续/) ?? byLabel(/关闭|close|skip/i) ?? null;
        if (candidate) { candidate.click(); return {done: false, clicked: true}; }
      }
      return {done: false, clicked: false};
    })()`).catch(() => ({done: false, clicked: false}));
    if (state.done === true) return true;
    if (state.clicked !== true) {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
    }
    await sleep(400);
  }
  return false;
}

async function panelPresent(win) {
  return evaluate(win, `document.querySelector('[data-code-view="panel"]') !== null`).catch(() => false);
}

async function screenshot(win, result, name, scrollSelector = null) {
  await dismissHostOverlays(win).catch(() => null);
  if ((await panelPresent(win)) !== true) {
    result.panelLosses = result.panelLosses ?? [];
    result.panelLosses.push({at: name, at_ms: Date.now() - startedAt});
    await evaluate(win, clickSidebarEntry()).catch(() => null);
    await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 15000);
    await sleep(800);
  }
  await evaluate(win, `(() => {
    const target = ${scrollSelector === null ? "document.querySelector('[data-code-view=\"view\"]') ?? document.querySelector('[data-code-view=\"stub-panel\"]')" : scrollSelector};
    const element = target ?? document.querySelector('[data-code-view="stub-panel"]') ?? document.querySelector('[data-code-view="view"]');
    if (element) element.scrollIntoView({block: 'start'});
    return true;
  })()`).catch(() => null);
  await sleep(900);
  try { win.webContents.invalidate(); } catch { /* optional */ }
  await capturePng(win).catch(() => null);
  await sleep(450);
  try { win.webContents.invalidate(); } catch { /* optional */ }
  await capturePng(win).catch(() => null);
  await sleep(450);
  const capture = await capturePng(win);
  const record = {name, ok: capture.ok === true};
  if (capture.ok === true) {
    if (shotDir) {
      mkdirSync(shotDir, {recursive: true});
      const path = join(shotDir, `${name}.png`);
      writeFileSync(path, capture.bytes);
      record.path = path;
      record.bytes = capture.bytes.length;
      record.sha256 = sha(capture.bytes);
    } else {
      record.bytes = capture.bytes.length;
    }
  } else {
    record.error = capture.error;
  }
  result.screenshots[name] = record;
  return record;
}

function clickSidebarEntry() {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('button, [role="button"], [data-panel-id]')];
    const label = (element) => (element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '');
    const button = candidates.find((element) => visible(element) && label(element).includes('代码工作台'));
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`;
}

function selectionExpr() {
  return `(() => {
    const element = document.querySelector('[data-code-view="selection"]');
    if (!element) return null;
    try { return JSON.parse(element.textContent); } catch { return {raw: element.textContent.slice(0, 3000)}; }
  })()`;
}

function absolutePathLeakExpr() {
  return `(() => {
    const panel = document.querySelector('[data-code-view="panel"]');
    const text = panel === null ? document.body.innerText : panel.innerText;
    const matches = String(text || '').match(/[A-Za-z]:[\\\\/][^\\s"'<>]*/g) || [];
    return {count: matches.length, samples: matches.slice(0, 10)};
  })()`;
}

// ---------------------------------------------------------------------------
// open workbench (S1/S2a baseline context)
// ---------------------------------------------------------------------------
async function openWorkbench(win, result) {
  result.sidebarProbe = await waitFor(win, `(() => {
    const byAria = [...document.querySelectorAll('[aria-label]')].filter((element) => (element.getAttribute('aria-label') || '').includes('代码工作台'));
    if (byAria.length > 0) return {aria_count: byAria.length};
    return document.body.textContent.includes('代码工作台') ? {text_content_has: true} : false;
  })()`, 60000);
  result.steps.sidebarEntry = result.sidebarProbe !== false && result.sidebarProbe !== null;
  await dismissHostOverlays(win);
  await evaluate(win, clickSidebarEntry()).catch(() => null);
  result.steps.panelOpened = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000));
  if (!result.steps.panelOpened) return false;
  result.steps.statusReady = Boolean(await waitFor(win, `(() => {
    const status = document.querySelector('[data-code-view="status"]');
    return status !== null && status.getAttribute('data-state') === 'ready';
  })()`, 40000));
  result.snapshotCandidates = await evaluate(win, `(() => [...document.querySelectorAll('[data-snapshot-id]')].map((element) => ({
    snapshot_id: element.getAttribute('data-snapshot-id'),
    status: element.getAttribute('data-snapshot-status'),
  })))()`).catch(() => []);
  const chosen = (() => {
    if (expectSnapshotId !== null) {
      const exact = result.snapshotCandidates.find((candidate) => candidate.snapshot_id === expectSnapshotId);
      if (exact) return exact;
    }
    return result.snapshotCandidates.find((candidate) => candidate.status === 'verified') ?? result.snapshotCandidates[0] ?? null;
  })();
  if (chosen !== null) {
    await evaluate(win, `(() => {
      const element = [...document.querySelectorAll('[data-snapshot-id]')].find((node) => node.getAttribute('data-snapshot-id') === ${JSON.stringify(chosen.snapshot_id)});
      if (element) element.click();
      return true;
    })()`).catch(() => null);
  }
  result.steps.entryListed = Boolean(await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 40000));
  result.clickEntry = await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === 'bus_send');
    if (!row) return {ok: false};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  result.steps.entryClicked = result.clickEntry.ok === true;
  return result.steps.panelOpened;
}

// ---------------------------------------------------------------------------
// stub-panel helpers
// ---------------------------------------------------------------------------
async function openStubPanel(win, result) {
  const clicked = await evaluate(win, `(() => {
    const rail = document.querySelector('[data-rail="stub"]');
    if (!rail) return {ok: false, reason: 'stub rail missing'};
    rail.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  const ready = await waitFor(win, `(() => {
    const panel = document.querySelector('[data-code-view="stub-panel"]');
    if (!panel) return false;
    return {present: true, text_length: (panel.innerText || '').length};
  })()`, 30000).catch(() => false);
  result.steps.stubPanelOpened = clicked.ok === true && ready !== false && ready !== null;
  await sleep(800);
  return result.steps.stubPanelOpened;
}

async function readStubState(win) {
  return evaluate(win, `(() => {
    const panel = document.querySelector('[data-code-view="stub-panel"]');
    const profiles = [...document.querySelectorAll('[data-stub-profile]')].map((element) => ({
      tag: element.tagName.toLowerCase(),
      value: element.value ?? element.getAttribute('data-profile-id') ?? null,
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    }));
    const steps = [...document.querySelectorAll('[data-stub-step][data-step-index]')].map((element) => {
      const select = element.querySelector('[data-step-interface]');
      const args = [...element.querySelectorAll('[data-step-arg]')];
      return {
        index: Number(element.getAttribute('data-step-index')),
        interface_value: select === null ? null : (select.value ?? select.getAttribute('data-interface') ?? null),
        interface_text: select === null ? '' : (select.innerText || select.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        args: args.map((input) => ({value: input.value, min: input.getAttribute('min'), max: input.getAttribute('max')})),
        text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      };
    });
    const records = [...document.querySelectorAll('[data-stub-record][data-call-id]')].map((element) => {
      const events = [...element.querySelectorAll('[data-stub-event]')].map((event) => ({
        kind: event.getAttribute('data-event-kind') || '',
        text: (event.innerText || event.textContent || '').trim().slice(0, 120),
        title: event.getAttribute('title'),
        a: (() => { const match = /a=(-?\\d+)/.exec(event.getAttribute('title') || ''); return match === null ? null : Number(match[1]); })(),
        b: (() => { const match = /b=(-?\\d+)/.exec(event.getAttribute('title') || ''); return match === null ? null : Number(match[1]); })(),
        c: (() => { const match = /c=(-?\\d+)/.exec(event.getAttribute('title') || ''); return match === null ? null : Number(match[1]); })(),
      }));
      const affects = [...element.querySelectorAll('[data-stub-affect][data-resource-id]')].map((affect) => ({
        resource_id: affect.getAttribute('data-resource-id'),
        text: (affect.innerText || affect.textContent || '').trim().slice(0, 160),
      }));
      const digestMatch = /\\b[0-9a-f]{64}\\b/.exec(element.innerText || element.textContent || '');
      return {
        call_id: element.getAttribute('data-call-id'),
        status: element.getAttribute('data-status'),
        stubbed: element.getAttribute('data-stubbed'),
        result: element.getAttribute('data-result'),
        text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
        events,
        affects,
        memory_digest: digestMatch === null ? null : digestMatch[0],
      };
    });
    return {
      text: panel === null ? '' : (panel.innerText || panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 6000),
      profiles,
      steps,
      records,
      busy: panel === null ? null : panel.getAttribute('data-busy'),
      run_disabled: (() => { const run = document.querySelector('[data-stub-run]'); return run === null ? null : run.disabled === true; })(),
      add_present: document.querySelector('[data-stub-add-step]') !== null,
      stop_on_error: (() => { const toggle = document.querySelector('[data-stub-stop-on-error]'); return toggle === null ? null : (toggle.checked === true || toggle.getAttribute('data-state')); })(),
      undo: (() => {
        const undo = document.querySelector('[data-stub-undo]');
        return undo === null ? null : {disabled: undo.disabled === true, text: (undo.innerText || undo.textContent || '').trim().slice(0, 200)};
      })(),
      gaps: [...document.querySelectorAll('[data-stub-gap], [data-code-view="gap-code"]')].map((element) => (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240)),
      editor_present: document.querySelector('[data-stub-editor]') !== null,
      generation_text: (() => { const element = document.querySelector('[data-stub-generation]'); return element === null ? null : (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240); })(),
      plan_text: (() => { const element = document.querySelector('[data-stub-plan]'); return element === null ? null : (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240); })(),
      error_codes: [...document.querySelectorAll('[data-code-view="error"][data-error-code], [data-error-code]')].map((element) => element.getAttribute('data-error-code')),
      selection: (() => { const element = document.querySelector('[data-code-view="selection"]'); if (!element) return null; try { return JSON.parse(element.textContent); } catch { return null; } })(),
    };
  })()`).catch(() => ({text: '', profiles: [], steps: [], records: []}));
}

/** Resize the editor step list one click at a time (React needs a paint between clicks). */
async function resizeSteps(win, target) {
  let last = null;
  for (let guard = 0; guard < 80; guard += 1) {
    const state = await evaluate(win, `(() => ({count: document.querySelectorAll('[data-stub-step][data-step-index]').length,
      addDisabled: document.querySelector('[data-stub-add-step]')?.disabled === true}))()`).catch(() => null);
    if (state === null) return false;
    last = state.count;
    if (state.count === target) return true;
    if (state.count < target) {
      if (state.addDisabled) return false;
      await evaluate(win, `(() => { const button = document.querySelector('[data-stub-add-step]'); if (button) button.click(); return true; })()`).catch(() => null);
    } else {
      const clicked = await evaluate(win, `(() => {
        const rows = [...document.querySelectorAll('[data-stub-step][data-step-index]')];
        const row = rows[rows.length - 1];
        if (!row) return false;
        const remove = row.querySelector('[data-step-remove]');
        if (!remove) return false;
        remove.click();
        return true;
      })()`).catch(() => false);
      if (clicked !== true) return false;
    }
    await sleep(400);
  }
  return last === target;
}

async function setScenarioSteps(win, stepsSpec) {
  const resized = await resizeSteps(win, stepsSpec.length);
  return {ok: resized, row_count: resized === true ? stepsSpec.length : null};
}

async function setScenarioStepsLegacy(win, stepsSpec) {
  return evaluate(win, `(() => {
    const spec = ${JSON.stringify(stepsSpec)};
    const addStep = () => {
      const button = document.querySelector('[data-stub-add-step]');
      if (!button) return false;
      button.click();
      return true;
    };
    const stepRows = () => [...document.querySelectorAll('[data-stub-step][data-step-index]')];
    // Trim extra steps (remove button inside the step row).
    for (let guard = 0; guard < 30; guard += 1) {
      const rows = stepRows();
      if (rows.length <= spec.length) break;
      const row = rows[rows.length - 1];
      const remove = row.querySelector('[data-step-remove]')
        ?? [...row.querySelectorAll('button')].find((button) => /移除|删除|remove/.test((button.textContent || '') + (button.getAttribute('aria-label') || '')));
      if (!remove) break;
      remove.click();
    }
    for (let guard = 0; guard < 30 && stepRows().length < spec.length; guard += 1) {
      if (!addStep()) break;
    }
    return {ok: stepRows().length === spec.length, row_count: stepRows().length};
  })()`).catch(() => ({ok: false}));
}

/** Fill one scenario step's interface + args (fresh native value setters). */
async function fillStep(win, index, step) {
  const wanted = String(step.interface);
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await evaluate(win, `(() => {
      const rows = [...document.querySelectorAll('[data-stub-step][data-step-index]')];
      const row = rows.find((element) => Number(element.getAttribute('data-step-index')) === ${index});
      if (!row) return {ok: false, reason: 'row missing'};
      const select = row.querySelector('[data-step-interface]');
      if (!select) return {ok: false, reason: 'interface select missing'};
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(wanted)});
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true};
    })()`).catch(() => ({ok: false}));
    await sleep(400);
    const current = await evaluate(win, `(() => {
      const rows = [...document.querySelectorAll('[data-stub-step][data-step-index]')];
      const row = rows.find((element) => Number(element.getAttribute('data-step-index')) === ${index});
      const select = row === undefined ? null : row.querySelector('[data-step-interface]');
      return select === null ? null : select.value;
    })()`).catch(() => null);
    if (current === wanted) return {ok: true, value: current};
  }
  return last ?? {ok: false};
}
async function fillArgs(win, index, args) {
  return evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-stub-step][data-step-index]')];
    const row = rows.find((element) => Number(element.getAttribute('data-step-index')) === ${index});
    if (!row) return {ok: false, reason: 'row missing'};
    const inputs = [...row.querySelectorAll('[data-step-arg]')];
    if (inputs.length < ${args.length}) return {ok: false, reason: 'arg input count', expected: ${args.length}, found: inputs.length};
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (let index = 0; index < ${args.length}; index += 1) {
      setter.call(inputs[index], String(${JSON.stringify(args)}[index]));
      inputs[index].dispatchEvent(new Event('input', {bubbles: true}));
      inputs[index].dispatchEvent(new Event('change', {bubbles: true}));
    }
    return {ok: true, values: ${JSON.stringify(args)}};
  })()`).catch(() => ({ok: false}));
  await sleep(300);
  const values = await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-stub-step][data-step-index]')];
    const row = rows.find((element) => Number(element.getAttribute('data-step-index')) === ${index});
    return row === undefined ? [] : [...row.querySelectorAll('[data-step-arg]')].map((input) => input.value);
  })()`).catch(() => []);
  return {ok: Array.isArray(values) && values.length >= args.length && args.every((value, argIndex) => String(values[argIndex]) === String(value)), values};
}

async function buildScenario(win, stepsSpec) {
  const sized = await setScenarioSteps(win, stepsSpec);
  await sleep(400);
  const filled = [];
  for (let index = 0; index < stepsSpec.length; index += 1) {
    filled.push(await fillStep(win, index, stepsSpec[index]));
    await sleep(350);
    if (Array.isArray(stepsSpec[index].args) && stepsSpec[index].args.length > 0) {
      await waitFor(win, `(() => {
        const rows = [...document.querySelectorAll('[data-stub-step][data-step-index]')];
        const row = rows.find((element) => Number(element.getAttribute('data-step-index')) === ${index});
        return row !== undefined && row.querySelectorAll('[data-step-arg]').length >= ${stepsSpec[index].args.length};
      })()`, 8000);
      filled.push(await fillArgs(win, index, stepsSpec[index].args));
      await sleep(250);
    }
  }
  await sleep(500);
  return {sized, filled};
}

async function clickRun(win) {
  await waitFor(win, `(() => { const run = document.querySelector('[data-stub-run]'); return run !== null && run.disabled !== true; })()`, 15000);
  return evaluate(win, `(() => {
    const run = document.querySelector('[data-stub-run]');
    if (!run) return {ok: false, reason: 'run button missing'};
    run.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
}

async function waitForRun(win, expectedRecords, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readStubState(win);
    if ((last.records ?? []).length >= expectedRecords && last.busy !== 'true') return last;
    await sleep(400);
  }
  return last;
}

// ---------------------------------------------------------------------------
// S3b helpers: undo / trace import / observed scenario selector
// ---------------------------------------------------------------------------
function idsIn(text) {
  return [...new Set(String(text ?? '').match(/scn_[0-9a-f]{12}/g) ?? [])];
}

function scenarioGenerationFromText(text) {
  const match = /(?:台账当前代|generation|代次)\s*(\d+)/.exec(String(text ?? ''));
  return match === null ? null : Number(match[1]);
}

function readExtraState(win) {
  return evaluate(win, `(() => {
    const rec = (element) => element === null ? null : {
      tag: element.tagName.toLowerCase(),
      value: element.value ?? null,
      disabled: element.disabled === true,
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    };
    const selector = document.querySelector('[data-code-view="sequence-scenario"]');
    const options = selector === null ? [] : [...selector.querySelectorAll('option')].map((option) => ({
      value: option.value,
      text: (option.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      selected: option.selected === true,
    }));
    return {
      undo_count: rec(document.querySelector('[data-stub-undo-count]')),
      undo_button: rec(document.querySelector('[data-stub-undo]')),
      undo_status: rec(document.querySelector('[data-stub-undo-status]')),
      trace_input: rec(document.querySelector('[data-trace-import-input]')),
      trace_button: rec(document.querySelector('[data-trace-import]')),
      trace_status: rec(document.querySelector('[data-trace-import-status]')),
      imported_marker: document.querySelector('[data-sequence-imported="true"]') !== null,
      imported_marker_text: (() => { const element = document.querySelector('[data-sequence-imported="true"]'); return element === null ? null : (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400); })(),
      observed: document.querySelector('[data-sequence-observed="true"]') !== null,
      scenario_selector: selector === null ? null : {tag: selector.tagName.toLowerCase(), options, value: selector.value ?? null, text: (selector.innerText || selector.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600)},
      sequence_text: (() => { const root = document.querySelector('[data-code-view="view"][data-view="sequence"]'); return root === null ? '' : (root.innerText || root.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 8000); })(),
      observed_attr_text: (() => { const element = document.querySelector('[data-sequence-observed]'); return element === null ? null : (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 800); })(),
      imported_limitations_visible: /imported_trace_not_executed_by_host|resource_effects_unknown_for_imported_trace|imported|导入/.test((document.querySelector('[data-code-view="stub-panel"]')?.innerText || '')),
    };
  })()`).catch(() => ({}));
}

async function readS3b(win) {
  const base = await readStubState(win);
  const extra = await readExtraState(win);
  return {...base, ...extra, ids: idsIn(`${base.text}\n${extra.sequence_text ?? ''}`)};
}

async function setInputValue(win, selector, value) {
  return evaluate(win, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return {ok: false, reason: 'missing'};
    const proto = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(element, ${JSON.stringify(String(value))});
    element.dispatchEvent(new Event('input', {bubbles: true}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, value: element.value};
  })()`).catch(() => ({ok: false}));
}

async function clickStubControl(win, selector) {
  return evaluate(win, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return {ok: false, reason: 'missing'};
    element.click();
    return {ok: true, disabled: element.disabled === true};
  })()`).catch(() => ({ok: false}));
}

async function waitForText(win, selector, pattern, timeoutMs = 45000) {
  return waitFor(win, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return false;
    const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    return ${JSON.stringify(pattern)}.length === 0 || new RegExp(${JSON.stringify(pattern)}).test(text) ? {text} : false;
  })()`, timeoutMs).catch(() => false);
}

async function stubRunScenario(win, steps) {
  await buildScenario(win, steps);
  const run = await clickRun(win);
  const state = await waitForRun(win, steps.length);
  return {run, state};
}

// ---------------------------------------------------------------------------
// S3b: undo tail + prefix replay
// ---------------------------------------------------------------------------
async function checkUndo(win, result) {
  const detail = {ok: false, steps: {}};
  await openStubPanel(win, result);
  // Run the canonical 3-step scenario A (channel 1) first.
  const runA = await stubRunScenario(win, [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  detail.sourceA = {
    records: (runA.state?.records ?? []).map((record) => ({call_id: record.call_id, status: record.status, result: record.result, memory_digest: record.memory_digest, text: record.text})),
    ids: idsIn(runA.state?.text ?? ''),
    generation: runA.state?.selection?.run_generation ?? scenarioGenerationFromText(runA.state?.text ?? ''),
    step_count: runA.state?.steps?.length ?? null,
    selection: runA.state?.selection ?? null,
  };
  detail.steps.ranA = (detail.sourceA.records ?? []).length === 3 && detail.sourceA.step_count >= 0;
  detail.steps.sourceHas3 = (detail.sourceA.records ?? []).length === 3;
  detail.steps.sourceScenarioId = (detail.sourceA.ids ?? []).some((id) => /^scn_[0-9a-f]{12}$/.test(id));

  // Set undo count = 1 through the client control then trigger undo.
  detail.setCount = await setInputValue(win, '[data-stub-undo-count]', '1');
  detail.undoClick = await clickStubControl(win, '[data-stub-undo]');
  const undoDone = await waitFor(win, `(() => {
    const status = document.querySelector('[data-stub-undo-status]');
    const button = document.querySelector('[data-stub-undo]');
    if (status === null) return false;
    const text = (status.innerText || status.textContent || '').replace(/\\s+/g, ' ').trim();
    const busy = button !== null && button.disabled === true && /回退|重放|执行/.test((button.textContent || ''));
    if (/摘要一致|重放状态摘要|state_digest_verified|回退成功/.test(text)) return {text, ok: true};
    if (/失败|错误|INVALID|OUTCOME|STATE_CONFLICT|拒绝|不可/.test(text)) return {text, ok: false};
    return false;
  })()`, 60000).catch(() => false);
  detail.undoDone = undoDone;
  await sleep(1500);
  detail.afterUndo = await readS3b(win);
  const prefixIds = idsIn(detail.afterUndo.text ?? '');
  detail.prefixScenarios = prefixIds;
  const sourceIds = new Set(detail.sourceA.ids ?? []);
  detail.prefixScenarioId = prefixIds.find((id) => !sourceIds.has(id)) ?? prefixIds[0] ?? null;
  const sourceRecords = detail.sourceA.records ?? [];
  const replayed = (detail.afterUndo.records ?? []).slice(0, 2);
  detail.replayed = replayed.map((record) => ({call_id: record.call_id, memory_digest: record.memory_digest, result: record.result, status: record.status, text: record.text}));
  detail.steps.undoSuccess = detail.undoDone !== false && detail.undoDone !== null && detail.undoDone.ok === true
    && /摘要一致|state_digest_verified/.test(`${detail.undoDone.text ?? ''} ${detail.afterUndo.text ?? ''}`);
  detail.steps.newLedgerTwoSteps = (detail.afterUndo.records ?? []).length === 2
    || /前缀|step_count[^\d]*2|步骤\s*2/.test(detail.afterUndo.text ?? '');
  detail.steps.prefixRecordsMatch = replayed.length === 2 && sourceRecords.length >= 2
    && replayed.every((record, index) => record.call_id === sourceRecords[index].call_id
      && record.memory_digest === sourceRecords[index].memory_digest);
  detail.steps.undoCountVisible = /undo|回退/.test(detail.afterUndo.text ?? '') || /回退/.test(detail.undoDone?.text ?? '');
  detail.steps.stateDigestVerifiedVisible = /state_digest_verified|状态摘要一致|摘要一致/.test(`${detail.undoDone?.text ?? ''} ${detail.afterUndo.text ?? ''} ${detail.afterUndo.sequence_text ?? ''}`);
  detail.steps.undoStatusSuccess = (detail.undoDone?.text ?? '').length > 0 && detail.undoDone?.ok === true;
  // Step editor must mirror the 2-step prefix.
  const editorTwo = await waitFor(win, `document.querySelectorAll('[data-stub-step][data-step-index]').length === 2`, 15000).catch(() => false);
  detail.editorSteps = (detail.afterUndo.steps ?? []).length;
  detail.steps.editorTwoSteps = editorTwo !== false && editorTwo !== null;
  // observed selector should now list the prefix scenario.
  detail.observedSelector = detail.afterUndo.scenario_selector ?? null;
  // The observed-scenario selector is rendered in the sequence view; its prefix entry is
  // asserted in checkObservedScenarios (selectorListsScenarios + prefixSelected).
  detail.observedSelectorDeferred = {prefixScenarioId: detail.prefixScenarioId, note: 'checked in observedScenarios'} ;
  await screenshot(win, result, 'undo', "document.querySelector('[data-stub-undo-status]') ?? document.querySelector('[data-stub-records]')");

  // Rerun the prefix scenario: generation must increase.
  const prefixGenBefore = detail.afterUndo.selection?.run_generation ?? scenarioGenerationFromText(detail.afterUndo.text ?? '');
  await clickRun(win);
  const rerunState = await waitForRun(win, 2);
  detail.rerunPrefix = {
    records: (rerunState?.records ?? []).length,
    generation: rerunState?.selection?.run_generation ?? scenarioGenerationFromText(rerunState?.text ?? ''),
    status: (rerunState?.undo_status?.text ?? '').slice(0, 300),
  };
  detail.steps.rerunGenerationIncrement = Number.isInteger(prefixGenBefore) && Number.isInteger(detail.rerunPrefix.generation)
    && detail.rerunPrefix.generation > prefixGenBefore;

  // Out-of-range count must be rejected without changing the ledger.
  const beforeInvalid = await readS3b(win);
  detail.setInvalidCount = await setInputValue(win, '[data-stub-undo-count]', '99');
  detail.invalidUndoClick = await clickStubControl(win, '[data-stub-undo]');
  await sleep(2500);
  const invalidState = await readS3b(win);
  detail.invalidUndoStatus = invalidState.undo_status?.text ?? null;
  detail.steps.invalidCountRejected = /失败|错误|INVALID|OUTCOME|STATE_CONFLICT|拒绝|不可|超出|范围/.test(`${invalidState.undo_status?.text ?? ''} ${invalidState.text ?? ''}`)
    || invalidState.undo_button?.disabled === true;
  detail.steps.invalidCountLedgerUnchanged = (invalidState.records ?? []).length === (beforeInvalid.records ?? []).length
    && JSON.stringify(idsIn(invalidState.text ?? '')) === JSON.stringify(idsIn(beforeInvalid.text ?? ''));
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.undo = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// S3b: trace import (inbox file) + imported ledger
// ---------------------------------------------------------------------------
async function checkTraceImport(win, result) {
  const detail = {ok: false, steps: {}};
  await openStubPanel(win, result);
  detail.before = await readS3b(win);
  detail.traceFile = process.env.RV_TRACE_FILE || 'trace-bus-send.json';
  detail.setInput = await setInputValue(win, '[data-trace-import-input]', detail.traceFile);
  detail.clickImport = await clickStubControl(win, '[data-trace-import]');
  const importDone = await waitFor(win, `(() => {
    const status = document.querySelector('[data-trace-import-status]');
    if (status === null) return false;
    const text = (status.innerText || status.textContent || '').replace(/\\s+/g, ' ').trim();
    if (/成功|已导入|imported|台账/.test(text)) return {text, ok: true};
    if (/失败|错误|INVALID|拒绝|不可/.test(text)) return {text, ok: false};
    return false;
  })()`, 60000).catch(() => false);
  detail.importDone = importDone;
  await sleep(1500);
  detail.afterImport = await readS3b(win);
  const importedIds = idsIn(detail.afterImport.text ?? '');
  const beforeIds = new Set(idsIn(detail.before.text ?? ''));
  detail.importedScenarioId = importedIds.find((id) => !beforeIds.has(id)) ?? importedIds[0] ?? null;
  detail.steps.importSuccess = importDone !== false && importDone !== null && importDone.ok === true;
  detail.steps.importedLedgerVisible = /imported|导入/.test(detail.afterImport.text ?? '');
  detail.steps.importedLabelVisible = /外部采集|bus_send 轨迹|label/i.test(`${detail.afterImport.text ?? ''} ${detail.afterImport.imported_marker_text ?? ''}`);
  detail.steps.importedLimitations = /imported_trace_not_executed_by_host|resource_effects_unknown_for_imported_trace|未执行|导入台账/.test(`${detail.afterImport.text ?? ''} ${detail.afterImport.sequence_text ?? ''}`);
  detail.steps.importedUndoDisabled = detail.afterImport.undo_button?.disabled === true
    && /导入|无法重放|imported|不可回退/.test(`${detail.afterImport.text ?? ''} ${detail.afterImport.undo_status?.text ?? ''}`);
  detail.selectionAfterImport = detail.afterImport.selection ?? null;
  detail.steps.selectionUpdated = detail.selectionAfterImport !== null
    && (detail.importedScenarioId === null || detail.selectionAfterImport.scenario_id === detail.importedScenarioId);
  await screenshot(win, result, 'imported', "document.querySelector('[data-stub-records]') ?? document.querySelector('[data-stub-panel]')");
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.traceImport = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// S3b: observed multi-scenario selector
// ---------------------------------------------------------------------------
async function selectScenarioOption(win, scenarioId) {
  return evaluate(win, `(() => {
    const selector = document.querySelector('[data-code-view="sequence-scenario"]');
    if (selector === null) return {ok: false, reason: 'selector missing'};
    if (selector.tagName === 'SELECT') {
      const option = [...selector.options].find((entry) => entry.value === ${JSON.stringify(scenarioId)});
      if (!option) return {ok: false, reason: 'option missing', options: [...selector.options].map((entry) => entry.value)};
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(selector, option.value);
      selector.dispatchEvent(new Event('input', {bubbles: true}));
      selector.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true, value: selector.value};
    }
    const candidate = [...selector.querySelectorAll('button, option, [data-scenario-id], [role="option"]')]
      .find((element) => element.getAttribute('data-scenario-id') === ${JSON.stringify(scenarioId)}
        || element.value === ${JSON.stringify(scenarioId)}
        || (element.textContent || '').includes(${JSON.stringify(scenarioId)}));
    if (!candidate) return {ok: false, reason: 'candidate missing'};
    candidate.click();
    return {ok: true, tag: candidate.tagName};
  })()`).catch(() => ({ok: false}));
}

async function checkObservedScenarios(win, result) {
  const detail = {ok: false, steps: {}};
  // Trace import has usually selected the imported ledger; switch to observed.
  await evaluate(win, `(() => {
    const tab = document.querySelector('[data-code-view="tabs"] button[data-view="sequence"]');
    if (tab) tab.click();
    return true;
  })()`).catch(() => null);
  const ready = await waitFor(win, `(() => {
    const root = document.querySelector('[data-code-view="view"][data-view="sequence"]');
    return root !== null && root.getAttribute('data-state') === 'ready';
  })()`, 30000).catch(() => false);
  detail.steps.sequenceView = ready !== false && ready !== null;
  detail.observedClick = await evaluate(win, `(() => {
    const button = document.querySelector('[data-sequence-mode="observed"]');
    if (!button) return {ok: false, reason: 'observed button missing'};
    button.click();
    return {ok: true, disabled: button.disabled === true};
  })()`).catch(() => ({ok: false}));
  const observedReady = await waitFor(win, `(() => {
    if (document.querySelector('[data-sequence-observed="true"]') === null) return false;
    const selector = document.querySelector('[data-code-view="sequence-scenario"]');
    const messages = document.querySelectorAll('[data-sequence-message][data-message-kind]').length;
    if (selector === null) return false;
    return {messages, selector: true};
  })()`, 60000).catch(() => false);
  detail.observedReady = observedReady;
  detail.steps.observedMode = detail.observedClick.ok === true && observedReady !== false && observedReady !== null;
  detail.state = await readS3b(win);
  detail.selector = detail.state.scenario_selector;
  detail.options = (detail.selector?.options ?? []).map((option) => ({value: option.value, text: option.text, selected: option.selected}));
  detail.steps.selectorPresent = detail.selector !== null && (detail.options ?? []).length >= 1;
  detail.steps.selectorListsScenarios = (detail.options ?? []).length >= 2;
  const importedOption = (detail.options ?? []).find((option) => /imported|导入|外部采集/.test(option.text)) ?? null;
  const importedId = importedOption?.value ?? (detail.state.ids ?? []).find((id) => id !== (detail.importedScenarioIdHint ?? '')) ?? null;
  detail.importedOption = importedOption;
  detail.importedId = importedId ?? result.views.traceImport?.importedScenarioId ?? null;

  // 1) Imported scenario: messages must include bus_send(1,48)/DOORBELL/WRITE/return 0 and imported marker.
  if (detail.importedId !== null) {
    detail.selectImported = await selectScenarioOption(win, detail.importedId);
    const importedReady = await waitFor(win, `(() => {
      if (document.querySelector('[data-sequence-imported="true"]') === null) return false;
      const messages = document.querySelectorAll('[data-sequence-message][data-message-kind]').length;
      return messages > 0 ? {messages} : false;
    })()`, 45000).catch(() => false);
    await sleep(800);
    const importedState = await readS3b(win);
    detail.importedState = importedState;
    detail.steps.importedSelected = detail.selectImported.ok === true;
    detail.steps.importedMarker = importedReady !== false && importedReady !== null;
    const importedText = (importedState.sequence_text ?? '');
    detail.steps.importedMessages = /bus_send\(1,\s*48\)/.test(importedText) && /DOORBELL/.test(importedText)
      && /WRITE/.test(importedText) && /返回\s*0|return\s*0/.test(importedText);
    detail.steps.importedLabelVisible = /外部采集|bus_send 轨迹|imported/i.test(importedText + ' ' + (importedState.imported_marker_text ?? ''));
    await screenshot(win, result, 'observed-scenario', "document.querySelector('[data-code-view=\"view\"][data-view=\"sequence\"]')");
  }

  // 2) Prefix (undo) scenario: switching must follow scenario id / selection.
  const prefixId = detail.prefixId ?? result.views.undo?.prefixScenarioId ?? null;
  detail.prefixId = prefixId;
  if (prefixId !== null) {
    const beforeSwitch = await readS3b(win);
    detail.selectPrefix = await selectScenarioOption(win, prefixId);
    await sleep(2500);
    const prefixState = await readS3b(win);
    detail.prefixState = {selection: prefixState.selection ?? null, imported_marker: prefixState.imported_marker, text: (prefixState.sequence_text ?? '').slice(0, 1500)};
    detail.steps.prefixSelected = detail.selectPrefix.ok === true;
    detail.steps.prefixSelectionFollows = (prefixState.selection?.scenario_id ?? null) === prefixId;
    detail.steps.prefixImportedMarkerAbsent = prefixState.imported_marker !== true;
    detail.steps.messagesFollow = (prefixState.sequence_text ?? '') !== (beforeSwitch.sequence_text ?? '');
  }
  detail.selection = detail.state.selection ?? (await readS3b(win)).selection ?? null;
  detail.steps.selectionFields = detail.selection !== null && typeof detail.selection === 'object'
    && ['scenario_id', 'run_generation', 'call_id'].every((field) => Object.prototype.hasOwnProperty.call(detail.selection, field));
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.observedScenarios = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// S3b: chrome (console/leak/undo-gap/main screenshot)
// ---------------------------------------------------------------------------
async function checkChrome(win, result) {
  const detail = {ok: false, steps: {}};
  await openStubPanel(win, result);
  detail.state = await readS3b(win);
  detail.steps.undoVisible = detail.state.undo_button !== null;
  detail.steps.undoCountVisible = detail.state.undo_count !== null;
  detail.steps.undoStatusVisible = detail.state.undo_status !== null;
  detail.steps.traceInputVisible = detail.state.trace_input !== null;
  detail.steps.traceButtonVisible = detail.state.trace_button !== null;
  detail.steps.traceStatusVisible = detail.state.trace_status !== null;
  detail.steps.gaps = (detail.state.gaps ?? []).length > 0;
  detail.steps.importedLimitations = /imported_trace_not_executed_by_host|resource_effects_unknown_for_imported_trace|导入台账|未执行/.test(
    `${detail.state.text ?? ''} ${detail.state.sequence_text ?? ''} ${(result.views.traceImport?.afterImport?.text ?? '')}`,
  );
  await screenshot(win, result, 'main', "document.querySelector('[data-stub-panel]') ?? document.querySelector('[data-code-view=\"stub-panel\"]')");
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.chrome = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const result = {
    ok: false,
    probe: 's3b',
    url: url ? url.replace(/token=[^&]+/, 'token=<redacted>') : null,
    profile_id: profileId,
    views: {},
    screenshots: {},
    steps: {},
  };
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1500,
      height: 950,
      webPreferences: {contextIsolation: true, sandbox: false, backgroundThrottling: false},
    });
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message).slice(0, 400);
      if (text.includes('Electron Security Warning')) return;
      consoleLines.push({level, message: text, at_ms: Date.now() - startedAt});
    });
    await win.loadURL(url);
    result.steps.pageLoaded = true;
    try {
      win.setOpacity(0);
      win.showInactive();
      result.steps.windowShownInvisible = true;
    } catch {
      result.steps.windowShownInvisible = false;
    }
    await waitFor(win, 'document.body && document.body.innerText.length > 0', 60000);
    result.steps.bodySettled = true;
    const opened = await openWorkbench(win, result);
    result.steps.workbenchOpened = opened === true;

    const undo = await checkUndo(win, result);
    result.steps.undo = undo.ok === true;
    const trace = await checkTraceImport(win, result);
    result.steps.traceImport = trace.ok === true;
    const observed = await checkObservedScenarios(win, result);
    result.steps.observedScenarios = observed.ok === true;
    const chrome = await checkChrome(win, result);
    result.steps.chrome = chrome.ok === true;

    result.selection = await evaluate(win, selectionExpr()).catch(() => null);
    result.steps.selectionFields = result.selection !== null && typeof result.selection === 'object'
      && ['scenario_id', 'run_generation', 'call_id'].every((field) => Object.prototype.hasOwnProperty.call(result.selection, field));
    result.leak = await evaluate(win, absolutePathLeakExpr()).catch(() => ({count: -1, samples: []}));
    result.steps.noAbsolutePaths = result.leak.count === 0;
    result.steps.noConsoleErrors = consoleLines.filter((line) => Number(line.level) >= 3).length === 0;

    const requiredSteps = [
      'pageLoaded', 'bodySettled', 'workbenchOpened',
      'undo', 'traceImport', 'observedScenarios', 'chrome',
      'selectionFields', 'noAbsolutePaths', 'noConsoleErrors',
    ];
    result.required_steps = requiredSteps;
    result.failed_steps = requiredSteps.filter((step) => result.steps[step] !== true);
    result.ok = result.failed_steps.length === 0;
    finish(result);
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    result.failed_steps = Object.keys(result.steps).filter((step) => result.steps[step] !== true);
    finish(result);
  }
}

app.whenReady().then(main);

setTimeout(() => {
  finish({ok: false, timeout: true, steps: {}, views: {}, screenshots: {}, console_lines: consoleLines.slice(0, 100)});
}, overallTimeoutMs);
