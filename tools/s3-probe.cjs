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
// S3a: stub run scenario A/B/C
// ---------------------------------------------------------------------------
const EVENT_SET = ['DEFAULT_ROUTE', 'STORE_ROUTE', 'REQUEST', 'LOOKUP', 'CHECK_LENGTH', 'TRANSFER', 'DIRECT', 'ENCODE', 'DOORBELL', 'WRITE'];

async function checkStubRun(win, result) {
  const detail = {ok: false, steps: {}};
  await openStubPanel(win, result);
  detail.state0 = await readStubState(win);
  detail.steps.panelOpened = result.steps.stubPanelOpened === true;
  // Profile selection (label/binding/module sha); prefer the demo profile.
  detail.profile = await evaluate(win, `(() => {
    const elements = [...document.querySelectorAll('[data-stub-profile]')];
    if (elements.length === 0) return {ok: false, reason: 'no profile selector'};
    const select = elements.find((element) => element.tagName === 'SELECT');
    if (select) {
      const option = [...select.options].find((entry) => entry.value === ${JSON.stringify(profileId)});
      if (option) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event('change', {bubbles: true}));
      }
      return {ok: true, mode: 'select', options: [...select.options].map((entry) => entry.value).slice(0, 10)};
    }
    const candidate = elements.find((element) => (element.innerText || '').includes(${JSON.stringify(profileId)}));
    if (candidate) { candidate.click(); return {ok: true, mode: 'click'}; }
    return {ok: false, mode: 'unknown', texts: elements.map((element) => (element.innerText || '').slice(0, 80))};
  })()`).catch(() => ({ok: false}));
  await waitFor(win, `document.querySelector('[data-stub-editor]') !== null`, 15000);
  await sleep(900);
  detail.state1 = await readStubState(win);
  detail.steps.profileSelector = detail.profile.ok === true;
  detail.steps.profileInterfaces = (detail.state1.editor_present === true) || /interface_count|stub_profile_interfaces_unavailable/.test(detail.state1.text ?? '') === false;
  detail.steps.profileBindingVisible = /code-view-bus-demo|semantic-x86_64|bus-demo-wasm|69c8622d/.test(detail.state1.text);
  detail.interfaceOptions = await evaluate(win, `(() => {
    const select = document.querySelector('[data-step-interface]');
    if (!select) return [];
    return [...select.options].map((option) => option.value || (option.textContent || '').trim());
  })()`).catch(() => []);
  detail.steps.interfaceOptions = ['bus_send', 'set_platform_stub'].every((name) => detail.interfaceOptions.includes(name));
  detail.steps.stepEditor = detail.state1.editor_present === true && (detail.state1.steps ?? []).length > 0 && detail.state1.add_present === true;
  detail.steps.stopOnError = detail.state1.stop_on_error !== null;

  // Scenario A: reset, bus_register(1), bus_send(1,48) -> 3 records 0/0/0.
  const scenarioA = [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'bus_send', args: [1, 48]},
  ];
  detail.buildA = await buildScenario(win, scenarioA);
  detail.stateStepsA = await readStubState(win);
  detail.steps.stepsBuiltA = (detail.stateStepsA.steps ?? []).length === 3
    && detail.stateStepsA.steps.map((step) => step.interface_value).join(',') === scenarioA.map((step) => step.interface).join(',');
  detail.runA = await clickRun(win);
  detail.recordsA = await waitForRun(win, 3);
  detail.recordsA = detail.recordsA ?? {records: []};
  const recordsA = detail.recordsA.records ?? [];
  detail.steps.recordsA3 = recordsA.length === 3;
  // Host worker semantics (Lead-confirmed): reset/void -> result null, bus_register ->
  // 0, bus_send -> 0. The record may expose `data-result` or a textual arrow.
  const recordResult = (record) => {
    if (record.result !== null && record.result !== undefined && /^-?\d+$/.test(String(record.result))) return Number(record.result);
    const match = /(?:→|->|结果)\s*(-?\d+|null|—|-)/.exec(String(record.text));
    if (match === null) return undefined;
    if (match[1] === 'null' || match[1] === '—' || match[1] === '-') return null;
    return Number(match[1]);
  };
  const resultsA = recordsA.map(recordResult);
  detail.resultsA = resultsA;
  detail.steps.resultsA000 = recordsA.length === 3
    && (resultsA[0] === null || resultsA[0] === 0 || resultsA[0] === undefined)
    && resultsA[1] === 0 && resultsA[2] === 0;
  const eventsA = recordsA.flatMap((record) => (record.events ?? []).map((event) => event.kind));
  detail.eventsA = [...new Set(eventsA)];
  detail.steps.eventSetA = EVENT_SET.every((name) => detail.eventsA.includes(name));
  detail.steps.writeAffects = recordsA.some((record) => (record.events ?? []).some((event) => event.kind === 'WRITE')
    && (record.affects ?? []).some((affect) => /simulated_doorbell/.test(affect.resource_id + ' ' + affect.text)));
  detail.steps.memoryDigest = recordsA.every((record) => /^[0-9a-f]{64}$/.test(record.memory_digest ?? ''));
  detail.steps.callIds = recordsA.every((record) => typeof record.call_id === 'string' && record.call_id.length > 0);
  detail.steps.statusOk = recordsA.every((record) => record.status === 'ok');
  detail.generationFirstA = detail.recordsA?.selection?.run_generation ?? null;
  await clickRun(win);
  const rerunA = await waitForRun(win, 3);
  detail.recordsA2 = rerunA;
  detail.generationSecondA = rerunA?.selection?.run_generation ?? null;
  const firstGen = Number(detail.generationFirstA);
  const secondGen = Number(detail.generationSecondA);
  detail.steps.generationIncrement = Number.isInteger(firstGen) && Number.isInteger(secondGen) && secondGen === firstGen + 1;
  await screenshot(win, result, 'stub-run', "document.querySelector('[data-stub-records]') ?? document.querySelector('[data-stub-panel]')");
  // Observed timing must be read while the happy scenario is the latest ledger
  // entry (the client uses the focused/latest scenario id for observed mode).
  detail.observedSequence = await captureObservedSequence(win, result);
  result.views.observedSequence = detail.observedSequence;
  await openStubPanel(win, result);

  // Scenario B: reset, bus_register(1), set_platform_stub(-5), bus_send(1,48)
  // -> stub step data-stubbed=true, bus_send -5, no WRITE, LOCK 1->0.
  const scenarioB = [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'set_platform_stub', args: [-5]},
    {interface: 'bus_send', args: [1, 48]},
  ];
  detail.buildB = await buildScenario(win, scenarioB);
  detail.runB = await clickRun(win);
  detail.recordsB = await waitForRun(win, 4);
  const recordsB = detail.recordsB.records ?? [];
  detail.steps.recordsB4 = recordsB.length === 4;
  const stubRecord = recordsB.find((record) => record.stubbed === 'true');
  detail.stubRecord = stubRecord ?? null;
  detail.steps.stubStepMarked = stubRecord !== undefined;
  const sendRecordB = recordsB.find((record) => /bus_send\(1,\s*48\)/.test(record.text));
  detail.sendRecordB = sendRecordB ?? null;
  detail.steps.sendResultMinus5 = sendRecordB !== undefined && /(^|\D)-5(\D|$)/.test(String(sendRecordB.result ?? sendRecordB.text));
  detail.steps.noWriteInB = sendRecordB !== undefined && !(sendRecordB.events ?? []).some((event) => event.kind === 'WRITE');
  const lockRecord = recordsB.find((record) => (record.events ?? []).some((event) => event.kind === 'LOCK'));
  const lockEvents = (lockRecord?.events ?? []).filter((event) => event.kind === 'LOCK');
  detail.lockEvents = lockEvents.map((event) => ({text: event.text, a: event.a, b: event.b, c: event.c, title: event.title}));
  detail.steps.lockOneToZero = lockEvents.length >= 2
    && lockEvents[0].a === 1
    && lockEvents[lockEvents.length - 1].a === 0;
  const nonSendB = recordsB.filter((record) => !/bus_send\(1,\s*48\)/.test(record.text));
  detail.steps.statusOkB = nonSendB.every((record) => record.status === 'ok')
    && (sendRecordB?.status === 'error' || sendRecordB?.status === 'ok');
  detail.steps.sendStatusErrorB = sendRecordB?.status === 'error';
  await screenshot(win, result, 'stub-stub', "document.querySelector('.dcr-stub-record-stubbed') ?? document.querySelector('[data-stub-records]') ?? document.querySelector('[data-stub-panel]')");

  // Scenario C: reset, bus_send(0,48) -> -2 (unregistered channel).
  const scenarioC = [
    {interface: 'reset', args: []},
    {interface: 'bus_send', args: [0, 48]},
  ];
  await buildScenario(win, scenarioC);
  await clickRun(win);
  detail.recordsC = await waitForRun(win, 2);
  const recordsC = (detail.recordsC?.records ?? []).filter((record) => /bus_send\(0,\s*48\)/.test(record.text));
  detail.sendRecordC = recordsC[0] ?? null;
  detail.steps.sendResultMinus2 = detail.sendRecordC !== null && /(^|\D)-2(\D|$)/.test(String(detail.sendRecordC.result ?? detail.sendRecordC.text));

  // Invalid args: bus_send(4,48) (channel max 3) must be rejected with an error
  // code and add no ledger record.
  const ledgerBefore = await readStubState(win);
  await buildScenario(win, [{interface: 'bus_send', args: [4, 48]}]);
  detail.runInvalid = await clickRun(win);
  await sleep(2500);
  detail.invalidState = await readStubState(win);
  detail.steps.invalidRejected = (detail.invalidState.error_codes ?? []).length > 0
    || /INVALID_ARGUMENT|OUT_OF_RANGE|非法|超出/.test(detail.invalidState.text + ' ' + (detail.invalidState.error_codes ?? []).join(','));
  detail.steps.invalidNoLedger = (detail.invalidState.records ?? []).length === (ledgerBefore.records ?? []).length;
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.stubRun = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// S3a: observed sequence mode
// ---------------------------------------------------------------------------
async function captureObservedSequence(win, result) {
  const detail = {ok: false, steps: {}};
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
  detail.modeControl = await evaluate(win, `(() => {
    const control = document.querySelector('[data-code-view="sequence-mode"]');
    const buttons = [...document.querySelectorAll('[data-code-view="sequence-mode"] button, [data-sequence-mode] , [data-mode]')].map((element) => ({
      text: (element.innerText || element.textContent || '').trim().slice(0, 40),
      mode: element.getAttribute('data-mode') || element.getAttribute('data-sequence-mode') || '',
    }));
    return {present: control !== null || buttons.length > 0, buttons};
  })()`).catch(() => ({present: false, buttons: []}));
  detail.steps.modeControl = detail.modeControl.present === true;
  await waitFor(win, `(() => { const button = document.querySelector('[data-sequence-mode="observed"]'); return button !== null && button.disabled !== true; })()`, 30000).catch(() => null);
  detail.clickObserved = await evaluate(win, `(() => {
    const candidates = [...document.querySelectorAll('[data-code-view="sequence-mode"] button, [data-sequence-mode], [data-mode]')];
    const observed = candidates.find((element) => /observed|运行观测/.test((element.innerText || '') + ' ' + (element.getAttribute('data-mode') || '') + ' ' + (element.getAttribute('aria-label') || '')));
    if (observed) { observed.click(); return {ok: true}; }
    const toggle = document.querySelector('[data-code-view="sequence-mode"]');
    if (toggle) { toggle.click(); return {ok: true, via: 'control'}; }
    return {ok: false};
  })()`).catch(() => ({ok: false}));
  detail.observedReady = await waitFor(win, `(() => {
    const observed = document.querySelector('[data-sequence-observed="true"]');
    if (!observed) return false;
    const messages = document.querySelectorAll('[data-sequence-message][data-message-kind]').length;
    return messages > 0 ? {messages} : false;
  })()`, 40000).catch(() => false);
  detail.steps.observedMode = detail.observedReady !== false && detail.observedReady !== null;
  await sleep(600);
  detail.messages = await evaluate(win, `(() => [...document.querySelectorAll('[data-sequence-message][data-message-kind]')].map((element) => ({
    kind: element.getAttribute('data-message-kind'),
    observed: element.getAttribute('data-observed'),
    text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
  })))()`).catch(() => []);
  const text = (detail.messages ?? []).map((message) => message.text).join('\n');
  detail.messageKinds = [...new Set((detail.messages ?? []).map((message) => message.kind))];
  detail.steps.callMessage = /bus_send\(1,\s*48\)/.test(text);
  detail.steps.eventMessages = /DOORBELL/.test(text) && /WRITE/.test(text);
  detail.steps.platformBoundary = /平台|platform|设备\/库边界|boundary/.test(text);
  detail.steps.returnMessage = /返回|return/.test(text);
  detail.steps.allObserved = (detail.messages ?? []).every((message) => message.observed === 'true');
  detail.observedAttrText = await evaluate(win, `(() => {
    const element = document.querySelector('[data-sequence-observed]');
    return element === null ? null : (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600);
  })()`).catch(() => null);
  await screenshot(win, result, 'sequence-observed', "document.querySelector('[data-code-view=\"view\"][data-view=\"sequence\"]')");
  // Back to static prediction: observed must be false/absent.
  detail.clickStatic = await evaluate(win, `(() => {
    const candidates = [...document.querySelectorAll('[data-code-view="sequence-mode"] button, [data-sequence-mode], [data-mode]')];
    const staticMode = candidates.find((element) => /static|静态预测/.test((element.innerText || '') + ' ' + (element.getAttribute('data-mode') || '')));
    if (staticMode) { staticMode.click(); return {ok: true}; }
    return {ok: false};
  })()`).catch(() => ({ok: false}));
  await sleep(1500);
  detail.staticState = await evaluate(win, `(() => ({
    observed_true: document.querySelector('[data-sequence-observed="true"]') !== null,
    warning: (() => { const element = document.querySelector('[data-sequence-warning]'); return element === null ? null : (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200); })(),
    modes: [...document.querySelectorAll('[data-code-view="sequence-mode"] button, [data-mode]')].map((element) => (element.innerText || '').trim().slice(0, 20)),
  }))()`).catch(() => ({observed_true: true}));
  detail.steps.staticRestored = detail.staticState.observed_true === false && /静态预测/.test(detail.staticState.warning ?? '');
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.observedSequence = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// S3a: gaps / undo / selection fields
// ---------------------------------------------------------------------------
async function checkStubChrome(win, result) {
  const detail = {ok: false, steps: {}};
  await openStubPanel(win, result);
  detail.state = await readStubState(win);
  detail.steps.undoDisabled = detail.state.undo !== null && detail.state.undo.disabled === true;
  detail.steps.undoGap = /回退|S3b|前缀重放/.test(detail.state.undo?.text ?? '') || (detail.state.gaps ?? []).some((gap) => /回退|S3b/.test(gap));
  detail.steps.s3bGap = (detail.state.gaps ?? []).some((gap) => /回退|S3b|scenario_undo/.test(gap));
  detail.steps.realDeviceGap = (detail.state.gaps ?? []).some((gap) => /真实设备|设备|未授权|real_device_dispatch/.test(gap));
  detail.steps.compilerGap = /编译器|构建|编译/.test(detail.state.text ?? '') || (detail.state.gaps ?? []).some((gap) => /编译器|构建/.test(gap));
  detail.steps.traceImportGap = (detail.state.gaps ?? []).some((gap) => /轨迹|导入|trace_import/.test(gap));
  detail.selection = detail.state.selection ?? await evaluate(win, selectionExpr()).catch(() => null);
  detail.steps.selectionFields = detail.selection !== null && typeof detail.selection === 'object'
    && ['scenario_id', 'run_generation', 'call_id'].every((field) => Object.prototype.hasOwnProperty.call(detail.selection, field));
  detail.steps.runLedgerVisible = (detail.state.records ?? []).length > 0;
  detail.capabilityGaps = ['ai_summary', 'scenario_undo', 'trace_import', 'real_device_dispatch'].filter((code) => (detail.state.text ?? '').includes(code));
  detail.steps.capabilityGaps = detail.capabilityGaps.length >= 3;
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.stubChrome = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const result = {
    ok: false,
    probe: 's3',
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

    const stubRun = await checkStubRun(win, result);
    result.steps.stubRun = stubRun.ok === true;
    // Observed sequence was captured inside checkStubRun while the happy
    // scenario was the latest ledger entry.
    result.steps.observedSequence = result.views.observedSequence?.ok === true;
    const chrome = await checkStubChrome(win, result);
    result.steps.stubChrome = chrome.ok === true;

    // Main evidence frame: stub panel with the final ledger records.
    await openStubPanel(win, result);
    await sleep(600);
    await screenshot(win, result, 'main', "document.querySelector('[data-stub-records]') ?? document.querySelector('[data-code-view=\"stub-panel\"]')");
    result.steps.mainScreenshot = (result.screenshots.main ?? {}).ok === true;

    result.selection = await evaluate(win, selectionExpr()).catch(() => null);
    result.steps.selectionFields = result.selection !== null && typeof result.selection === 'object'
      && ['scenario_id', 'run_generation', 'call_id'].every((field) => Object.prototype.hasOwnProperty.call(result.selection, field));
    result.leak = await evaluate(win, absolutePathLeakExpr()).catch(() => ({count: -1, samples: []}));
    result.steps.noAbsolutePaths = result.leak.count === 0;
    result.steps.noConsoleErrors = consoleLines.filter((line) => Number(line.level) >= 3).length === 0;

    const requiredSteps = [
      'pageLoaded', 'bodySettled', 'workbenchOpened',
      'stubRun', 'observedSequence', 'stubChrome',
      'mainScreenshot', 'selectionFields', 'noAbsolutePaths', 'noConsoleErrors',
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
