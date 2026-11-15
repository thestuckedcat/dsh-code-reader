// Chromium probe for the S2a read-only five-view workbench (independent
// verifier artefact; not a shipped plugin component).
//
// Drives the real isolated `dsh web` in an installed Electron Chromium and
// asserts docs/five-view-contract.md §7 per view against the frozen DOM hooks
// in §5, capturing one PNG per view plus the main end-to-end graph. It also
// re-checks the S1 read-only slice (snapshot -> entry -> source 152) so the old
// hooks cannot silently regress.
//
// Mechanisms reused from tools/readonly-slice/electron-probe.cjs (same
// verifier, 04-owned): opacity-0 showInactive window for a current composited
// screenshot frame and host first-run overlay dismissal (host UI only).
//
// Environment:
//   RV_URL                 isolated dsh web URL with one-time token
//   RV_OUT                 JSON result path
//   RV_SHOT_DIR            directory for per-view PNGs
//   RV_ENTRY_NAME          entry name (default bus_send)
//   RV_EXPECT_LINE         entry definition line (default 152)
//   RV_SNAPSHOT_ID         expected verified snapshot id (optional)
//   RV_TIMEOUT_MS          overall probe timeout (default 300000)
const {app, BrowserWindow} = require('electron');
const {createHash} = require('node:crypto');
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname, join} = require('node:path');

const url = process.env.RV_URL;
const out = process.env.RV_OUT;
const shotDir = process.env.RV_SHOT_DIR;
const expectEntry = process.env.RV_ENTRY_NAME || 'bus_send';
const expectLine = Number(process.env.RV_EXPECT_LINE || '152');
const expectSnapshotId = process.env.RV_SNAPSHOT_ID || null;
const expectEntryLines = (() => { try { return JSON.parse(process.env.RV_ENTRY_LINES || "{}"); } catch { return {}; } })();
const overallTimeoutMs = Number(process.env.RV_TIMEOUT_MS || 300000);
const VIEWS = ['coupling', 'tree', 'end_to_end', 'sequence', 'file'];
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
    console.error('five-views probe result write failed', String(error && error.message ? error.message : error));
  }
}

function finish(payload) {
  payload.duration_ms = Date.now() - startedAt;
  payload.console_lines = consoleLines.slice(0, 300);
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

/** Current composited frame as PNG (window is shown with opacity 0). Hidden
 * windows can lag compositor frames, so each evidence capture first settles the
 * panel/view scroll, dismisses host overlays (host UI only) and takes two frames
 * (the second one is used). */
async function capturePng(win) {
  try {
    const image = await win.webContents.capturePage();
    return {ok: true, bytes: image.toPNG()};
  } catch (error) {
    return {ok: false, error: String(error && error.message ? error.message : error)};
  }
}

async function screenshot(win, result, name) {
  await dismissHostOverlays(win).catch(() => null);
  await evaluate(win, `(() => {
    const view = document.querySelector('[data-code-view="view"]');
    if (view) view.scrollIntoView({block: 'start'});
    return true;
  })()`).catch(() => null);
  await sleep(700);
  await capturePng(win).catch(() => null);
  await sleep(400);
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

// Host first-run overlay dismissal (best effort; host UI, never a gate).
async function dismissHostOverlays(win) {
  const attempts = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await evaluate(win, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      if (dialogs.length === 0) return {done: true, dialogs: [], clicked: false};
      for (const dialog of dialogs) {
        const buttons = [...dialog.querySelectorAll('button')].filter(visible);
        const byText = (pattern) => buttons.find((node) => pattern.test((node.textContent || '').trim()));
        const byLabel = (pattern) => buttons.find((node) => pattern.test(node.getAttribute('aria-label') || ''));
        const candidate = byText(/稍后|跳过|继续/) ?? byLabel(/关闭|close|skip/i) ?? null;
        if (candidate) {
          candidate.click();
          return {done: false, dialogs: dialogs.map((el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').slice(0, 80)), clicked: true, button: (candidate.textContent || candidate.getAttribute('aria-label') || '').slice(0, 40)};
        }
      }
      const closer = [...document.querySelectorAll('button')].filter(visible).find((node) =>
        /关闭|close/i.test(node.getAttribute('aria-label') || '') || ['×', '✕'].includes((node.textContent || '').trim()));
      if (closer) {
        closer.click();
        return {done: false, dialogs: dialogs.map((el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').slice(0, 80)), clicked: true, button: 'generic-close'};
      }
      return {done: false, dialogs: dialogs.map((el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').slice(0, 80)), clicked: false};
    })()`).catch((error) => ({done: false, clicked: false, error: String(error && error.message ? error.message : error)}));
    attempts.push({done: state.done === true, clicked: state.clicked === true, dialogs: state.dialogs ?? []});
    if (state.done === true) return {dismissed: true, attempts};
    if (state.clicked !== true) {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
    }
    await sleep(400);
  }
  return {dismissed: false, attempts};
}

function clickSidebarEntry() {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], [data-panel-id]')];
    const label = (element) => (element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '');
    const matching = candidates.filter((element) => visible(element) && label(element).includes('代码工作台'));
    const button = matching.find((element) => element.tagName === 'BUTTON' || element.getAttribute('role') === 'button')
      ?? matching[0];
    if (!button) {
      const leaf = [...document.querySelectorAll('*')].find((element) => visible(element)
        && element.children.length === 0 && (element.textContent || '').trim() === '代码工作台');
      if (!leaf) return {ok: false, aria_count: matching.length, body_has_label: document.body.innerText.includes('代码工作台')};
      const clickable = leaf.closest('button, a, [role="button"], [role="menuitem"]') ?? leaf;
      clickable.click();
      return {ok: true, tag: clickable.tagName, fallback: true};
    }
    button.click();
    return {ok: true, tag: button.tagName, aria: button.getAttribute('aria-label') || ''};
  })()`;
}

/** Read the shared Selection JSON rendered by the panel (old hook kept). */
function selectionExpr() {
  return `(() => {
    const element = document.querySelector('[data-code-view="selection"]');
    if (!element) return null;
    try { return JSON.parse(element.textContent); } catch { return {raw: element.textContent.slice(0, 2000)}; }
  })()`;
}

function panelTextExpr(limit = 8000) {
  return `(() => {
    const panel = document.querySelector('[data-code-view="panel"]');
    return panel === null ? '' : (panel.innerText || panel.textContent || panel.getAttribute('aria-label') || '').slice(0, ${limit});
  })()`;
}

function absolutePathLeakExpr() {
  return `(() => {
    const panel = document.querySelector('[data-code-view="panel"]');
    const text = panel === null ? document.body.innerText : panel.innerText;
    const matches = String(text || '').match(/[A-Za-z]:[\\\\/][^\\s"'<>]*/g) || [];
    const suspicious = matches.filter((value) => !/^[A-Za-z]:[\\\\/](?:$|\\/)/.test(value) || value.length > 2);
    return {count: matches.length, samples: matches.slice(0, 10)};
  })()`;
}

/** Selected/highlight flag detection for elements that have no fixed hook. */
function elementSnapshotExpr(selectorExpression) {
  return `(() => {
    const element = ${selectorExpression};
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      attributes: Object.fromEntries([...element.attributes].map((attr) => [attr.name, attr.value.slice(0, 200)])),
      className: (element.getAttribute('class') || '').slice(0, 300),
      rect: {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)},
      stroke: getComputedStyle(element).stroke,
    };
  })()`;
}

function looksSelected(snapshot) {
  if (!snapshot) return false;
  const attrs = snapshot.attributes ?? {};
  if (attrs['data-selected'] === 'true' || attrs['aria-selected'] === 'true' || attrs['aria-current'] === 'true') return true;
  if (attrs['data-highlight'] === 'true' || attrs['data-active'] === 'true') return true;
  if (Object.values(attrs).some((value) => /selected|highlight|active|current/i.test(String(value)))) return true;
  return /selected|highlight|active|current|focused/i.test(snapshot.className ?? '');
}

/** Poll until `predicate(snapshot)` holds, returning {matched, snapshot, before, after_ms}. */
async function waitForSnapshotChange(win, selectorExpression, {timeoutMs = 6000, intervalMs = 300} = {}) {
  const before = await evaluate(win, elementSnapshotExpr(selectorExpression)).catch(() => null);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const after = await evaluate(win, elementSnapshotExpr(selectorExpression)).catch(() => null);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed && looksSelected(after)) return {matched: true, before, after};
    if (changed && !looksSelected(after)) {
      // keep polling: many implementations re-render attributes before final state
    }
  }
  const final = await evaluate(win, elementSnapshotExpr(selectorExpression)).catch(() => null);
  return {matched: looksSelected(final) && JSON.stringify(final) !== JSON.stringify(before), before, after: final};
}

// ---------------------------------------------------------------------------
// view switching + shared helpers
// ---------------------------------------------------------------------------
async function readTabs(win) {
  return evaluate(win, `(() => [...document.querySelectorAll('[data-code-view="tabs"] button[data-view]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      view: element.getAttribute('data-view'),
      text: (element.innerText || element.textContent || '').trim().slice(0, 40),
      selected: element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-pressed') === 'true'
        || element.getAttribute('data-selected') === 'true' || /selected|active/i.test(element.className || ''),
      visible: rect.width > 0 && rect.height > 0,
    };
  }))()`).catch(() => []);
}

async function clickTab(win, view) {
  return evaluate(win, `(() => {
    const button = document.querySelector('[data-code-view="tabs"] button[data-view=${JSON.stringify(view)}]');
    if (!button) return {ok: false, reason: 'tab not found'};
    button.click();
    return {ok: true, view: ${JSON.stringify(view)}, text: (button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim().slice(0, 40)};
  })()`).catch((error) => ({ok: false, reason: String(error && error.message ? error.message : error)}));
}

async function waitViewReady(win, view, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(win, `(() => {
      const root = document.querySelector('[data-code-view="view"][data-view=${JSON.stringify(view)}]');
      if (!root) return null;
      return {
        state: root.getAttribute('data-state'),
        text_length: (root.innerText || root.textContent || root.getAttribute('aria-label') || '').length,
      };
    })()`).catch(() => null);
    if (last !== null && last.state === 'ready') return {ready: true, state: last.state, text_length: last.text_length};
    if (last !== null && (last.state === 'error' || last.state === 'empty')) return {ready: false, state: last.state, text_length: last.text_length};
    await sleep(300);
  }
  return {ready: false, state: last === null ? 'missing' : last.state, text_length: last === null ? 0 : last.text_length};
}

async function readViewText(win, view, limit = 6000) {
  return evaluate(win, `(() => {
    const root = document.querySelector('[data-code-view="view"][data-view=${JSON.stringify(view)}]');
    return root === null ? '' : (root.innerText || root.textContent || root.getAttribute('aria-label') || '').slice(0, ${limit});
  })()`).catch(() => '');
}

async function readGaps(win) {
  return evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-code-view="gap-code"]')].map((element) => ({
      code: element.getAttribute('data-gap-code') || element.getAttribute('data-code') || '',
      text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 240),
    }));
    const legacy = [...document.querySelectorAll('[data-gap-code]')].map((element) => ({
      code: element.getAttribute('data-gap-code') || '',
      text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 240),
    }));
    const merged = [];
    for (const row of [...rows, ...legacy]) {
      if (!merged.some((existing) => existing.text === row.text && existing.code === row.code)) merged.push(row);
    }
    return merged;
  })()`).catch(() => []);
}

// ---------------------------------------------------------------------------
// opening: panel -> verified snapshot -> entry (S1 regression + S2a context)
// ---------------------------------------------------------------------------
async function openWorkbench(win, result) {
  result.sidebarProbe = await waitFor(win, `(() => {
    const byAria = [...document.querySelectorAll('[aria-label]')].filter((element) => (element.getAttribute('aria-label') || '').includes('代码工作台'));
    const textContentHas = document.body.textContent.includes('代码工作台');
    if (byAria.length === 0 && !textContentHas) return false;
    return {aria_count: byAria.length, text_content_has: textContentHas};
  })()`, 60000);
  result.steps.sidebarEntry = result.sidebarProbe !== false && result.sidebarProbe !== null;
  result.overlaysBeforeOpen = await dismissHostOverlays(win);
  result.clickOpen = await evaluate(win, clickSidebarEntry());
  result.steps.panelOpened = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000));
  if (!result.steps.panelOpened) return false;
  result.steps.statusReady = Boolean(await waitFor(win, `(() => {
    const status = document.querySelector('[data-code-view="status"]');
    return status !== null && status.getAttribute('data-state') === 'ready';
  })()`, 40000));

  // S1 regression: select a verified snapshot and the bus_send entry.
  result.snapshotCandidates = await evaluate(win, `(() => [...document.querySelectorAll('[data-snapshot-id]')].map((element) => ({
    snapshot_id: element.getAttribute('data-snapshot-id'),
    status: element.getAttribute('data-snapshot-status'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  })))()`).catch(() => []);
  const chosen = (() => {
    const candidates = result.snapshotCandidates;
    if (expectSnapshotId !== null) {
      const exact = candidates.find((candidate) => candidate.snapshot_id === expectSnapshotId);
      if (exact) return exact;
    }
    return candidates.find((candidate) => candidate.status === 'verified') ?? candidates[0] ?? null;
  })();
  result.chosenSnapshot = chosen;
  if (chosen !== null) {
    result.clickSnapshot = await evaluate(win, `(() => {
      const element = [...document.querySelectorAll('[data-snapshot-id]')].find((node) => node.getAttribute('data-snapshot-id') === ${JSON.stringify(chosen.snapshot_id)});
      if (!element) return {ok: false};
      element.click();
      return {ok: true};
    })()`).catch(() => ({ok: false}));
    result.steps.snapshotClicked = result.clickSnapshot.ok === true;
  }
  result.steps.entryListed = Boolean(await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 40000));
  result.clickEntry = await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === ${JSON.stringify(expectEntry)});
    if (!row) return {ok: false, names: rows.map((element) => element.getAttribute('data-entry-name')).slice(0, 40)};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true, entry_id: row.getAttribute('data-entry-id')};
  })()`).catch(() => ({ok: false}));
  result.steps.entryClicked = result.clickEntry.ok === true;
  result.s1SourceLine = await waitFor(win, `(() => {
    const source = document.querySelector('[data-code-view="source"]');
    if (!source) return false;
    const row = [...source.querySelectorAll('[data-line]')].find((element) => element.getAttribute('data-line') === '${expectLine}');
    if (!row) return false;
    const text = (row.innerText || row.textContent || row.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    return text.includes(${JSON.stringify(expectEntry)}) ? {line: ${expectLine}, text} : false;
  })()`, 40000).catch(() => false);
  result.steps.s1SourceLine = Boolean(result.s1SourceLine);
  result.selectionOpen = await evaluate(win, selectionExpr()).catch(() => null);
  return result.steps.s1SourceLine;
}

// ---------------------------------------------------------------------------
// view 1: coupling
// ---------------------------------------------------------------------------
async function checkCoupling(win, result) {
  const detail = {ok: false};
  detail.columns = await evaluate(win, `(() => [...document.querySelectorAll('[data-coupling-column]')].map((element) => element.getAttribute('data-coupling-column')))()`).catch(() => []);
  detail.steps = {
    columns: ['writer', 'resource', 'reader'].every((column) => detail.columns.includes(column)),
  };

  detail.resourceNodes = await evaluate(win, `(() => [...document.querySelectorAll('[data-resource-node][data-resource-id]')].map((element) => ({
    resource_id: element.getAttribute('data-resource-id'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  })))()`).catch(() => []);
  detail.routesNode = detail.resourceNodes.find((node) => /routes/.test(node.text)) ?? null;
  detail.steps.resourceNodeRoutes = detail.routesNode !== null;

  detail.functionNodes = await evaluate(win, `(() => [...document.querySelectorAll('[data-function-node][data-entry-id]')].map((element) => ({
    function_id: element.getAttribute('data-entry-id'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
  })))()`).catch(() => []);
  detail.steps.functionNodes = detail.functionNodes.length > 0;

  detail.accessEdges = await evaluate(win, `(() => [...document.querySelectorAll('[data-access-edge]')].map((element) => ({
    access: element.getAttribute('data-access'),
    certainty: element.getAttribute('data-certainty'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 320),
  })))()`).catch(() => []);
  detail.writeExact = detail.accessEdges.filter((edge) => edge.access === 'write' && edge.certainty === 'exact'
    && /max_len/.test(edge.text) && /bus\.c:46\b/.test(edge.text));
  detail.readMay = detail.accessEdges.filter((edge) => edge.access === 'read' && edge.certainty === 'may' && /max_len/.test(edge.text));
  const readLines = new Set();
  for (const edge of detail.readMay) {
    for (const match of edge.text.matchAll(/bus\.c:(\d+)/g)) readLines.add(Number(match[1]));
  }
  detail.readLines = [...readLines].sort((left, right) => left - right);
  detail.steps.writeExactMaxLen46 = detail.writeExact.length > 0;
  detail.steps.readMay929398 = [92, 93, 98].every((line) => detail.readLines.includes(line));

  // Left rail: "全局资源" tab + resource rows; clicking a row must highlight the
  // matching resource node in the graph (the exact highlight attribute is not
  // frozen, so any selected/active/highlight attribute or class change counts).
  detail.rail = await evaluate(win, `(() => {
    const resourceTab = document.querySelector('[data-rail="resources"]');
    if (resourceTab) resourceTab.click();
    return {
      rail_present: resourceTab !== null,
      resource_tab_text: resourceTab === null ? null : (resourceTab.textContent || '').trim().slice(0, 40),
      stub_rail: document.querySelector('[data-rail="stub"]') !== null,
    };
  })()`).catch(() => ({rail_present: false, stub_rail: false}));
  await sleep(600);
  detail.railRows = await evaluate(win, `(() => [...document.querySelectorAll('[data-resource-row][data-resource-id]')].map((element) => ({
    resource_id: element.getAttribute('data-resource-id'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  })))()`).catch(() => []);
  detail.steps.railResources = detail.rail.rail_present === true && (detail.railRows ?? []).length > 0;

  // Stub rail placeholder (scenario execution is CW-T3; S2a must show the
  // actual gap and a disabled placeholder instead of a working action).
  detail.stubClick = await evaluate(win, `(() => {
    const stub = document.querySelector('[data-rail="stub"]');
    if (!stub) return {ok: false};
    stub.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(700);
  detail.stubPanel = await evaluate(win, `(() => {
    const panel = document.querySelector('[data-stub-panel]');
    if (panel === null) return null;
    return {
      text: (panel.innerText || panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      disabled_placeholder: panel.querySelector('button[disabled]') !== null,
    };
  })()`).catch(() => null);
  detail.steps.stubPanel = detail.stubPanel !== null
    && /场景|打桩|CW-T3/.test(detail.stubPanel.text)
    && detail.stubPanel.disabled_placeholder === true;
  await evaluate(win, `(() => { const tab = document.querySelector('[data-rail="resources"]'); if (tab) tab.click(); })()`).catch(() => {});
  await sleep(500);

  const routesRow = (detail.railRows ?? []).find((row) => /routes/.test(row.text)) ?? null;
  detail.railRoutesRow = routesRow;
  if (routesRow !== null) {
    const nodeSelector = `[...document.querySelectorAll('[data-resource-node][data-resource-id]')].find((element) => element.getAttribute('data-resource-id') === ${JSON.stringify(routesRow.resource_id)}) ?? null`;
    const before = await evaluate(win, elementSnapshotExpr(nodeSelector)).catch(() => null);
    detail.railClick = await evaluate(win, `(() => {
      const row = [...document.querySelectorAll('[data-resource-row][data-resource-id]')]
        .find((element) => element.getAttribute('data-resource-id') === ${JSON.stringify(routesRow.resource_id)});
      if (!row) return {ok: false};
      (row.closest('button, [role="button"], li') ?? row).click();
      return {ok: true};
    })()`).catch(() => ({ok: false}));
    // Poll for the highlight state because the click state applies on a later
    // React commit than the synchronous DOM read.
    const deadline = Date.now() + 8000;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(300);
      after = await evaluate(win, elementSnapshotExpr(nodeSelector)).catch(() => null);
      if (after !== null && JSON.stringify(after) !== JSON.stringify(before) && looksSelected(after)) break;
    }
    detail.railHighlight = {before, after, matched: after !== null && JSON.stringify(after) !== JSON.stringify(before) && looksSelected(after)};
    detail.steps.railClickHighlights = detail.railHighlight.matched === true;
  } else {
    detail.steps.railClickHighlights = false;
  }

  // Gap rows must stay verbatim (group collapse / interface library / AI
  // summary / run observation placeholders are S2a gaps, not empty arrays).
  detail.gaps = await readGaps(win);
  const gapText = detail.gaps.map((gap) => `${gap.code} ${gap.text}`).join(' | ');
  detail.gapTextSamples = detail.gaps.slice(0, 20);
  detail.steps.gapsOriginal = ['组折叠', '接口库', 'AI 归纳', '运行观测'].every((label) => gapText.includes(label))
    || ['group_collapse', 'interface_library', 'ai_summary', 'run_observation'].filter((code) => gapText.includes(code)).length >= 3;

  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.coupling = detail;
  await screenshot(win, result, 'coupling');
  return detail;
}

// ---------------------------------------------------------------------------
// view 2: tree
// ---------------------------------------------------------------------------
async function readTreeNodes(win) {
  return evaluate(win, `(() => [...document.querySelectorAll('[data-tree-node]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      node_id: element.getAttribute('data-node-id'),
      depth: Number(element.getAttribute('data-depth')),
      text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 320),
      visible: rect.width > 0 && rect.height > 0,
      toggles: element.querySelectorAll('[data-tree-toggle]').length,
    };
  }))()`).catch(() => []);
}

async function expandTree(win, result, targets) {
  result.treeExpansionRounds = [];
  for (let round = 0; round < 8; round += 1) {
    const nodes = await readTreeNodes(win);
    const text = nodes.map((node) => node.text).join('\n');
    const missing = targets.filter((target) => !text.includes(target));
    result.treeExpansionRounds.push({round, node_count: nodes.length, missing});
    if (missing.length === 0) return nodes;
    const toggled = await evaluate(win, `(() => {
      const toggles = [...document.querySelectorAll('[data-tree-toggle]')];
      let clicked = 0;
      for (const toggle of toggles) {
        const expanded = toggle.getAttribute('aria-expanded') === 'true' || toggle.getAttribute('data-expanded') === 'true';
        if (!expanded) {
          const rect = toggle.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            toggle.click();
            clicked += 1;
          }
        }
      }
      return clicked;
    })()`).catch(() => 0);
    if (toggled === 0) return nodes;
    await sleep(500);
  }
  return readTreeNodes(win);
}

async function checkTree(win, result) {
  const detail = {ok: false, steps: {}, targets: ['lookup_route', 'check_length', 'dispatch_transfer']};
  detail.rootNodes = await evaluate(win, `(() => [...document.querySelectorAll('[data-tree-node]')].filter((element) => Number(element.getAttribute('data-depth')) === 0).map((element) => ({
    node_id: element.getAttribute('data-node-id'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 320),
  })))()`).catch(() => []);
  // Contract §7.3: the entry bus_send is the tree root (the row shows the
  // symbol/call-site/entry chip; the root row itself carries no file:line).
  detail.steps.root = (detail.rootNodes ?? []).some((node) => node.text.includes(expectEntry) && /入口/.test(node.text));
  detail.nodes = await expandTree(win, result, detail.targets);
  const nodeText = (detail.nodes ?? []).map((node) => node.text);
  detail.steps.expanded = detail.targets.every((target) => nodeText.some((text) => text.includes(target)));
  const checkLengthNode = (detail.nodes ?? []).find((node) => node.text.includes('check_length'));
  detail.checkLengthNode = checkLengthNode ?? null;
  detail.steps.guardText = checkLengthNode !== undefined
    && /if\s*\(|!\s*check_length|check_length\(route, length\)/.test(checkLengthNode.text);
  const lookupNode = (detail.nodes ?? []).find((node) => node.text.includes('lookup_route'));
  detail.lookupNode = lookupNode ?? null;
  const lookupLineMatch = lookupNode === null ? null : /bus\.c:(\d+)/.exec(lookupNode.text);
  // The tree row text shows the *callsite* file:line; the definition line comes
  // from the orchestrator (engine view-entries projection) for the file jump.
  detail.lookupCallsiteLine = lookupLineMatch === null ? null : Number(lookupLineMatch[1]);
  detail.lookupLine = expectEntryLines.lookup_route ?? detail.lookupCallsiteLine;

  if (lookupNode !== null) {
    detail.nodeClick = await evaluate(win, `(() => {
      const node = [...document.querySelectorAll('[data-tree-node]')].find((element) => element.getAttribute('data-node-id') === ${JSON.stringify(lookupNode.node_id)});
      if (!node) return {ok: false};
      const nameButton = node.querySelector('.dcr-tree-name') ?? [...node.querySelectorAll('button')].find((button) => !button.hasAttribute('data-tree-toggle')) ?? node;
      nameButton.click();
      return {ok: true};
    })()`).catch(() => ({ok: false}));
    // Contract §6/§7: clicking a tree node locates it in the file view. The
    // "location" signal is not frozen: accept a selected/highlight/current row,
    // a current-line attribute, or the target line being scrolled into view.
    detail.fileAfterTreeClick = await waitViewReady(win, 'file', 20000);
    detail.steps.treeClickLocatesFile = detail.fileAfterTreeClick.ready === true;
    if (detail.steps.treeClickLocatesFile) {
      detail.fileLines = await evaluate(win, `(() => [...document.querySelectorAll('[data-file-line]')].filter((element) => {
        const selected = element.getAttribute('data-selected') === 'true' || element.getAttribute('aria-selected') === 'true'
          || element.getAttribute('data-highlight') === 'true' || /selected|highlight|current|active/i.test(element.className || '');
        return selected;
      }).map((element) => Number(element.getAttribute('data-line'))))()`).catch(() => []);
      detail.locationEvidence = await evaluate(win, `(() => {
        const targetLine = ${detail.lookupLine === null ? 'null' : detail.lookupLine};
        if (targetLine === null) return null;
        const row = [...document.querySelectorAll('[data-file-line]')].find((element) => Number(element.getAttribute('data-line')) === targetLine);
        if (row === null) return {target_present: false};
        const view = document.querySelector('[data-code-view="view"][data-view="file"]');
        const scroller = row.closest('[style*="overflow"], .dcr-file-scroll, .dcr-scroll') ?? view;
        const rowRect = row.getBoundingClientRect();
        const viewRect = (scroller ?? view).getBoundingClientRect();
        const currentAttrs = [];
        for (const element of [row, view, scroller]) {
          if (element === null || element === undefined) continue;
          for (const attribute of element.attributes ?? []) {
            if (/current|selected|highlight|active/i.test(attribute.name) || /current|selected|highlight/i.test(attribute.value)) currentAttrs.push([element.tagName, attribute.name, attribute.value.slice(0, 80)]);
          }
        }
        return {
          target_present: true,
          in_viewport: rowRect.top >= viewRect.top - 4 && rowRect.bottom <= viewRect.bottom + 4,
          current_attrs: currentAttrs,
          row_visible: rowRect.width > 0 && rowRect.height > 0,
        };
      })()`).catch(() => null);
      detail.steps.treeClickFileLine = detail.lookupLine !== null
        && ((detail.fileLines ?? []).includes(detail.lookupLine)
          || detail.locationEvidence?.in_viewport === true
          || (detail.locationEvidence?.current_attrs ?? []).length > 0);
      detail.fileSelectedLines = detail.fileLines ?? [];
    } else {
      detail.steps.treeClickFileLine = false;
    }
    // Return to the tree view for the screenshot state.
    await clickTab(win, 'tree');
    await waitViewReady(win, 'tree', 20000);
  } else {
    detail.steps.treeClickLocatesFile = false;
    detail.steps.treeClickFileLine = false;
  }
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.tree = detail;
  await screenshot(win, result, 'tree');
  return detail;
}

// ---------------------------------------------------------------------------
// view 3: end-to-end graph
// ---------------------------------------------------------------------------
function graphNodesExpr() {
  return `(() => [...document.querySelectorAll('[data-graph-node][data-node-id]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      node_id: element.getAttribute('data-node-id'),
      kind: element.getAttribute('data-node-kind'),
      shape: element.getAttribute('data-shape'),
      role: element.getAttribute('data-role') || element.getAttribute('data-node-role') || '',
      text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      rect: {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)},
    };
  }))()`;
}

function graphEdgesExpr() {
  return `(() => [...document.querySelectorAll('[data-graph-edge]')].map((element) => {
    const styleProbe = [element, ...element.querySelectorAll('line, path, polyline')];
    let dashArray = '';
    let stroke = '';
    for (const probe of styleProbe) {
      const computed = getComputedStyle(probe);
      dashArray += ' ' + (computed.strokeDasharray || '') + ' ' + (probe.getAttribute('stroke-dasharray') || '');
      stroke += ' ' + (computed.stroke || '') + ' ' + (probe.getAttribute('stroke') || '');
    }
    return {
      edge_id: element.getAttribute('data-edge-id'),
      kind: element.getAttribute('data-edge-kind'),
      certainty: element.getAttribute('data-certainty'),
      color: element.getAttribute('data-color'),
      line: element.getAttribute('data-line') || element.getAttribute('data-style') || '',
      className: element.getAttribute('class') || '',
      dashArray: dashArray.trim().slice(0, 200),
      stroke: stroke.trim().slice(0, 200),
      text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 320),
    };
  }))()`;
}

function edgeGeometryExpr() {
  return `(() => {
    const view = document.querySelector('[data-code-view="view"][data-view="end_to_end"]');
    if (!view) return {edges: [], viewLines: []};
    const collect = (root, id) => {
      const parts = [];
      const elements = [...root.querySelectorAll('line, polyline, path')];
      const rootTag = String(root.tagName || '').toLowerCase();
      if (rootTag === 'line' || rootTag === 'polyline' || rootTag === 'path') elements.push(root);
      for (const element of elements) {
        const tag = element.tagName.toLowerCase();
        if (tag === 'line') {
          parts.push({type: 'line', x1: Number(element.getAttribute('x1')), y1: Number(element.getAttribute('y1')), x2: Number(element.getAttribute('x2')), y2: Number(element.getAttribute('y2'))});
        } else if (tag === 'polyline') {
          parts.push({type: 'polyline', points: String(element.getAttribute('points') || '')});
        } else if (tag === 'path') {
          parts.push({type: 'path', d: String(element.getAttribute('d') || '')});
        }
      }
      return {id, parts};
    };
    const edges = [...view.querySelectorAll('[data-graph-edge]')].map((element) => collect(element, element.getAttribute('data-edge-id') || element.getAttribute('data-edge-kind') || 'edge'));
    const nodeElements = new Set([...view.querySelectorAll('[data-graph-node]')]);
    const viewLines = [...view.querySelectorAll('line, polyline')].filter((element) => {
      for (const node of nodeElements) if (node.contains(element)) return false;
      return true;
    }).map((element) => collect(element, 'view-line'));
    return {edges, viewLines};
  })()`;
}

function pathSegments(d) {
  const segments = [];
  const curves = [];
  let current = null;
  const tokens = String(d).match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let index = 0;
  let command = null;
  const read = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      index += 1;
      if (command === 'Z' || command === 'z') {
        current = null;
        continue;
      }
      if ((command === 'H' || command === 'h' || command === 'V' || command === 'v') && index >= tokens.length) break;
      continue;
    }
    const relative = command === command.toLowerCase();
    if (command === 'M' || command === 'm') {
      const x = read();
      const y = read();
      current = relative && current !== null ? {x: current.x + x, y: current.y + y} : {x, y};
      command = relative ? 'l' : 'L';
    } else if (command === 'L' || command === 'l') {
      const x = read();
      const y = read();
      const next = relative && current !== null ? {x: current.x + x, y: current.y + y} : {x, y};
      if (current !== null) segments.push({from: current, to: next});
      current = next;
    } else if (command === 'H' || command === 'h') {
      const x = read();
      const next = {x: relative && current !== null ? current.x + x : x, y: current === null ? 0 : current.y};
      if (current !== null) segments.push({from: current, to: next});
      current = next;
    } else if (command === 'V' || command === 'v') {
      const y = read();
      const next = {x: current === null ? 0 : current.x, y: relative && current !== null ? current.y + y : y};
      if (current !== null) segments.push({from: current, to: next});
      current = next;
    } else {
      // Curved/arc command: record and consume its numeric arguments conservatively.
      curves.push(command);
      index += 1;
    }
  }
  return {segments, curves};
}

function polylineSegments(points) {
  const numbers = String(points).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? [];
  const segments = [];
  for (let index = 2; index + 1 < numbers.length; index += 2) {
    segments.push({from: {x: numbers[index - 2], y: numbers[index - 1]}, to: {x: numbers[index], y: numbers[index + 1]}});
  }
  return segments;
}

function analyseGeometry(geometry) {
  const segments = [];
  const curves = [];
  let sources = 0;
  const edgeIds = new Set();
  for (const edge of geometry.edges ?? []) {
    let edgeSegments = 0;
    for (const part of edge.parts ?? []) {
      if (part.type === 'line') {
        if ([part.x1, part.y1, part.x2, part.y2].every((value) => Number.isFinite(value))) {
          segments.push({from: {x: part.x1, y: part.y1}, to: {x: part.x2, y: part.y2}});
          edgeSegments += 1;
        }
      } else if (part.type === 'polyline') {
        const parsed = polylineSegments(part.points);
        segments.push(...parsed);
        edgeSegments += parsed.length;
      } else if (part.type === 'path') {
        const parsed = pathSegments(part.d);
        segments.push(...parsed.segments);
        curves.push(...parsed.curves);
        edgeSegments += parsed.segments.length;
      }
    }
    if (edgeSegments > 0) {
      sources += 1;
      edgeIds.add(edge.id);
    }
  }
  if (sources === 0) {
    for (const line of geometry.viewLines ?? []) {
      for (const part of line.parts ?? []) {
        if (part.type === 'line' && [part.x1, part.y1, part.x2, part.y2].every((value) => Number.isFinite(value))) {
          segments.push({from: {x: part.x1, y: part.y1}, to: {x: part.x2, y: part.y2}});
        }
      }
    }
  }
  let diagonal = 0;
  let orthogonal = 0;
  for (const segment of segments) {
    const dx = Math.abs(segment.to.x - segment.from.x);
    const dy = Math.abs(segment.to.y - segment.from.y);
    if (dx <= 0.75 || dy <= 0.75) orthogonal += 1;
    else diagonal += 1;
  }
  return {segments: segments.length, orthogonal, diagonal, curves: curves.length, edge_sources: sources};
}

async function dragNode(win, nodeId, dx, dy) {
  const scrolled = await evaluate(win, `(() => {
    const element = [...document.querySelectorAll('[data-graph-node]')].find((node) => node.getAttribute('data-node-id') === ${JSON.stringify(nodeId)});
    if (!element) return null;
    element.scrollIntoView({block: 'center'});
    const rect = element.getBoundingClientRect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  })()`).catch(() => null);
  if (scrolled === null || scrolled.width <= 0) return {ok: false, reason: 'node bbox missing'};
  await sleep(350);
  const before = await evaluate(win, `(() => {
    const element = [...document.querySelectorAll('[data-graph-node]')].find((node) => node.getAttribute('data-node-id') === ${JSON.stringify(nodeId)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  })()`).catch(() => null);
  if (before === null) return {ok: false, reason: 'node missing after scroll'};
  const startX = Math.round(before.x + before.width / 2);
  const startY = Math.round(before.y + before.height / 2);
  const nodeSelector = `[...document.querySelectorAll('[data-graph-node]')].find((node) => node.getAttribute('data-node-id') === ${JSON.stringify(nodeId)})`;
  const viewportSelector = `document.querySelector('.dcr-canvas-viewport')`;
  const dispatch = (type, clientX, clientY, targetSelector) => evaluate(win, `(() => {
    const target = ${targetSelector};
    if (!target) return false;
    target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1, clientX: ${clientX}, clientY: ${clientY},
    }));
    return true;
  })()`).catch(() => false);
  const primary = {down: await dispatch('pointerdown', startX, startY, nodeSelector)};
  await sleep(200);
  for (const fraction of [0.2, 0.4, 0.6, 0.8, 1]) {
    primary[`move_${fraction}`] = await dispatch('pointermove', Math.round(startX + dx * fraction), Math.round(startY + dy * fraction), viewportSelector);
    await sleep(90);
  }
  primary.up = await dispatch('pointerup', Math.round(startX + dx), Math.round(startY + dy), viewportSelector);
  await sleep(300);
  const movedPrimary = await evaluate(win, `(() => {
    const element = [...document.querySelectorAll('[data-graph-node]')].find((node) => node.getAttribute('data-node-id') === ${JSON.stringify(nodeId)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {x: Math.round(rect.x), y: Math.round(rect.y)};
  })()`).catch(() => null);
  const movedByPrimary = movedPrimary !== null
    && (Math.abs(movedPrimary.x - Math.round(before.x)) > 12 || Math.abs(movedPrimary.y - Math.round(before.y)) > 12);
  if (movedByPrimary) {
    return {ok: true, method: 'pointer-events', primary, before: {x: Math.round(before.x), y: Math.round(before.y)}, moved: movedPrimary};
  }
  // Fallback: raw mouse input events (some Electron/Chromium builds synthesize
  // pointer events from these; the client only listens to pointer events).
  win.webContents.sendInputEvent({type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1});
  await sleep(150);
  for (let step = 1; step <= 6; step += 1) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(startX + (dx * step) / 6),
      y: Math.round(startY + (dy * step) / 6),
      button: 'left',
      movementX: Math.round(dx / 6),
      movementY: Math.round(dy / 6),
    });
    await sleep(80);
  }
  win.webContents.sendInputEvent({type: 'mouseUp', x: Math.round(startX + dx), y: Math.round(startY + dy), button: 'left', clickCount: 1});
  await sleep(400);
  const movedFallback = await evaluate(win, `(() => {
    const element = [...document.querySelectorAll('[data-graph-node]')].find((node) => node.getAttribute('data-node-id') === ${JSON.stringify(nodeId)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {x: Math.round(rect.x), y: Math.round(rect.y)};
  })()`).catch(() => null);
  return {ok: true, method: 'mouse-events', primary, before: {x: Math.round(before.x), y: Math.round(before.y)}, moved: movedFallback};
}

async function checkEndToEnd(win, result) {
  const detail = {ok: false, steps: {}};
  detail.nodes = await evaluate(win, graphNodesExpr()).catch(() => []);
  detail.edges = await evaluate(win, graphEdgesExpr()).catch(() => []);
  const nodeText = (detail.nodes ?? []).map((node) => `${node.kind} ${node.text}`);
  detail.entryNode = (detail.nodes ?? []).find((node) => node.kind === 'entry' && node.text.includes(expectEntry)) ?? null;
  detail.decisionNodes = (detail.nodes ?? []).filter((node) => node.kind === 'decision');
  detail.exitNodes = (detail.nodes ?? []).filter((node) => node.kind === 'exit');
  detail.externalNodes = (detail.nodes ?? []).filter((node) => node.kind === 'external');
  detail.steps.entryNode = detail.entryNode !== null;
  detail.steps.decisionNode = detail.decisionNodes.length > 0;
  detail.errorExit = detail.exitNodes.find((node) => node.text.includes('-90') && (/error/i.test(node.role) || /error/i.test(node.text))) ?? null;
  detail.steps.errorExit = detail.errorExit !== null;
  detail.errorEdge = (detail.edges ?? []).find((edge) => edge.kind === 'return' && /-90/.test(edge.text)) ?? null;
  detail.steps.errorEdgeColor = detail.errorEdge !== null && /exception|error|red/i.test(`${detail.errorEdge.color} ${detail.errorEdge.stroke} ${detail.errorEdge.line}`);
  // External boundary node for the unresolved platform_write callee (engine
  // merges per-callee external nodes; select by kind + label, not by node id).
  detail.platformNode = detail.externalNodes.find((node) => /platform_write/.test(node.text)) ?? null;
  detail.steps.externalPlatformWrite = detail.platformNode !== null;
  detail.externalEdge = (detail.edges ?? []).find((edge) => edge.kind === 'external' && /platform_write/.test(edge.text)) ?? null;
  const isDashed = (edge) => edge !== null && (/dashed/i.test(edge.className ?? '')
    || (/^(?!none$)/.test((edge.dashArray ?? '').trim()) && /\d/.test(edge.dashArray ?? '')));
  detail.steps.externalEdgeDashed = detail.externalEdge !== null && isDashed(detail.externalEdge);
  detail.externalEdgeStyle = detail.externalEdge === null ? null : {dashArray: detail.externalEdge.dashArray, className: detail.externalEdge.className};
  detail.guardEdge = (detail.edges ?? []).find((edge) => edge.kind === 'guard') ?? null;
  detail.steps.guardEdge = detail.guardEdge !== null;
  detail.steps.noAbsolutePathNode = nodeText.every((text) => !/[A-Za-z]:[\\/]/.test(text));

  // Orthogonal routing: every edge segment must be horizontal or vertical.
  detail.geometry = analyseGeometry(await evaluate(win, edgeGeometryExpr()).catch(() => ({edges: [], viewLines: []})));
  detail.steps.orthogonalEdges = detail.geometry.segments > 0 && detail.geometry.diagonal === 0 && detail.geometry.curves === 0;
  detail.steps.orthogonalOnlyHV = detail.geometry.segments > 0 && detail.geometry.diagonal === 0;

  // Direction DOWN: entry above decision/process and above exits.
  const centerY = (node) => node.rect.y + node.rect.height / 2;
  const processNodes = (detail.nodes ?? []).filter((node) => node.kind === 'process');
  detail.steps.directionDown = detail.entryNode !== null
    && (detail.decisionNodes.length > 0 ? detail.decisionNodes.every((node) => centerY(node) > centerY(detail.entryNode)) : true)
    && (processNodes.length > 0 ? processNodes.some((node) => centerY(node) > centerY(detail.entryNode)) : true)
    && (detail.exitNodes.length === 0 || detail.exitNodes.some((node) => centerY(node) > centerY(detail.entryNode)));

  // Fit / relayout controls.
  detail.controls = await evaluate(win, `(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')].map((element) => ({
      text: (element.textContent || '').trim().slice(0, 40),
      aria: element.getAttribute('aria-label') || '',
      fit: element.hasAttribute('data-graph-fit'),
      relayout: element.hasAttribute('data-graph-relayout'),
      search: element.hasAttribute('data-graph-search'),
    }));
    return {
      fit: document.querySelector('[data-graph-fit]') !== null || buttons.some((button) => button.fit || /适应/.test(button.text + button.aria)),
      relayout: document.querySelector('[data-graph-relayout]') !== null || document.querySelector('[data-graph-relayout]') !== null
        || buttons.some((button) => button.relayout || /规整|整理|自动布局/.test(button.text + button.aria)),
      search: document.querySelector('[data-graph-search]') !== null || buttons.some((button) => button.search || /搜索/.test(button.text + button.aria)),
      buttons: buttons.slice(0, 40),
    };
  })()`).catch(() => ({fit: false, relayout: false, search: false, buttons: []}));
  detail.steps.fitControl = detail.controls.fit === true;
  detail.steps.relayoutControl = detail.controls.relayout === true;

  // Drag a process/decision node, then relayout must restore the arranged layout.
  const dragTarget = processNodes.find((node) => node.rect.width > 0) ?? (detail.decisionNodes[0] ?? null);
  detail.dragTarget = dragTarget === null ? null : {node_id: dragTarget.node_id, before: dragTarget.rect};
  if (dragTarget !== null) {
    detail.drag = await dragNode(win, dragTarget.node_id, 140, 90);
    await sleep(700);
    // The drag helper scrolls the canvas so the node is visible; the comparison
    // baseline must be the post-scroll rect from the helper, not the pre-scroll
    // bounding box.
    detail.beforeDragRect = detail.drag?.before ?? null;
    detail.afterDragRect = detail.drag?.moved ?? null;
    detail.steps.dragMoved = detail.drag?.ok === true && detail.beforeDragRect !== null && detail.afterDragRect !== null
      && (Math.abs(detail.afterDragRect.x - detail.beforeDragRect.x) > 15 || Math.abs(detail.afterDragRect.y - detail.beforeDragRect.y) > 15);
    detail.relayoutClick = await evaluate(win, `(() => {
      const byAttr = document.querySelector('[data-graph-relayout]');
      if (byAttr) { byAttr.click(); return {ok: true, via: 'attr'}; }
      const button = [...document.querySelectorAll('button, [role="button"]')].find((element) => /规整|整理|自动布局/.test((element.textContent || '') + (element.getAttribute('aria-label') || '')));
      if (button) { button.click(); return {ok: true, via: 'text'}; }
      return {ok: false};
    })()`).catch(() => ({ok: false}));
    await sleep(1000);
    detail.afterRelayoutRect = await evaluate(win, `(() => {
      const element = [...document.querySelectorAll('[data-graph-node]')].find((node) => node.getAttribute('data-node-id') === ${JSON.stringify(dragTarget.node_id)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {x: Math.round(rect.x), y: Math.round(rect.y)};
    })()`).catch(() => null);
    const restored = detail.afterRelayoutRect !== null && detail.beforeDragRect !== null
      && Math.abs(detail.afterRelayoutRect.x - detail.beforeDragRect.x) <= 24
      && Math.abs(detail.afterRelayoutRect.y - detail.beforeDragRect.y) <= 24;
    detail.relayoutRecord = {restored, after: detail.afterRelayoutRect, before: detail.beforeDragRect};
    detail.steps.relayoutRestored = detail.relayoutClick.ok === true && restored;
  } else {
    detail.steps.dragMoved = false;
    detail.steps.relayoutRestored = false;
  }

  // Fit control is exercised for the main screenshot state.
  if (detail.controls.fit === true) {
    detail.fitClick = await evaluate(win, `(() => {
      const element = document.querySelector('[data-graph-fit]');
      if (element) { element.click(); return {ok: true, via: 'attr'}; }
      const button = [...document.querySelectorAll('button, [role="button"]')].find((node) => /适应/.test((node.textContent || '') + (node.getAttribute('aria-label') || '')));
      if (button) { button.click(); return {ok: true, via: 'text'}; }
      return {ok: false};
    })()`).catch(() => ({ok: false}));
    await sleep(600);
  }
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.end_to_end = detail;
  await screenshot(win, result, 'end_to_end');
  return detail;
}

// ---------------------------------------------------------------------------
// view 4: sequence (static prediction only)
// ---------------------------------------------------------------------------
async function checkSequence(win, result) {
  const detail = {ok: false, steps: {}};
  detail.warning = await evaluate(win, `(() => {
    const element = document.querySelector('[data-sequence-warning]');
    return element === null ? null : (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 600);
  })()`).catch(() => null);
  detail.steps.staticWarning = typeof detail.warning === 'string' && /静态预测/.test(detail.warning);
  detail.observed = await evaluate(win, `(() => {
    const view = document.querySelector('[data-code-view="view"][data-view="sequence"]');
    const candidates = [view, document.querySelector('[data-sequence-warning]')].filter((element) => element !== null);
    for (const element of candidates) {
      if (element.hasAttribute('data-observed')) return {value: element.getAttribute('data-observed'), source: 'attribute'};
    }
    const text = view === null ? '' : view.innerText;
    if (/observed\\s*[:=]\\s*false/i.test(text)) return {value: 'false', source: 'text'};
    return {value: null, source: 'none'};
  })()`).catch(() => ({value: null}));
  detail.steps.observedFalse = detail.observed.value === 'false';
  detail.messages = await evaluate(win, `(() => [...document.querySelectorAll('[data-sequence-message]')].map((element) => ({
    message_id: element.getAttribute('data-message-id'),
    kind: element.getAttribute('data-message-kind'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
  })))()`).catch(() => []);
  const messageText = (detail.messages ?? []).map((message) => message.text).join('\n');
  detail.steps.messages = [expectEntry, 'lookup_route', 'check_length', 'platform_write'].every((label) => messageText.includes(label));
  detail.messageKinds = [...new Set((detail.messages ?? []).map((message) => message.kind))];
  detail.steps.kinds = (detail.messages ?? []).length >= 4 && detail.messageKinds.includes('call');
  detail.steps.externalKinds = detail.messageKinds.includes('external');
  // Participants are visual chrome, not a frozen §5 hook: record them but do
  // not gate the acceptance on a participant selector that does not exist.
  detail.participants = await evaluate(win, `(() => [...document.querySelectorAll('.dcr-seq-participant, [data-sequence-participant], [data-participant-id]')].map((element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 80)))()`).catch(() => []);
  detail.participants_found = (detail.participants ?? []).length >= 2;
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.sequence = detail;
  await screenshot(win, result, 'sequence');
  return detail;
}

// ---------------------------------------------------------------------------
// view 5: file
// ---------------------------------------------------------------------------
async function checkFile(win, result) {
  const detail = {ok: false, steps: {}};
  detail.fileTree = await evaluate(win, `(() => [...document.querySelectorAll('[data-file-tree] [data-file-path]')].map((element) => ({
    path: element.getAttribute('data-file-path'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 120),
  })))()`).catch(() => []);
  detail.steps.fileTree = (detail.fileTree ?? []).some((row) => /(^|\/)bus\.c$/.test(row.path ?? '') || /bus\.c/.test(row.text));
  detail.clickFile = await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-file-tree] [data-file-path]')];
    const row = rows.find((element) => /bus\.c/.test(element.getAttribute('data-file-path') || '') || /bus\.c/.test(element.innerText || element.textContent || element.getAttribute('aria-label') || ''));
    if (!row) return {ok: false};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(700);
  const readFileLines = () => evaluate(win, `(() => [...document.querySelectorAll('[data-file-line]')].map((element) => ({
    line: Number(element.getAttribute('data-line')),
    file_line_attr: element.getAttribute('data-file-line'),
    text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    selected: element.getAttribute('data-selected') === 'true' || element.getAttribute('aria-selected') === 'true'
      || element.getAttribute('data-highlight') === 'true' || /selected|highlight|current|active/i.test(element.className || ''),
  })))()`).catch(() => []);
  detail.lines = await readFileLines();
  detail.steps.lineCount = detail.lines.length === 174;
  detail.line46 = detail.lines.find((line) => line.line === 46) ?? null;
  detail.steps.line46 = detail.line46 !== null;
  detail.line46Text = detail.line46 !== null && /max_len/.test(detail.line46.text);
  detail.steps.line46Text = detail.line46Text === true;
  detail.firstLine = detail.lines[0] ?? null;
  detail.lastLine = detail.lines[detail.lines.length - 1] ?? null;
  detail.steps.lineRange = detail.firstLine?.line === 1 && detail.lastLine?.line === 174;
  // Contract §7.6 uses the literal selector [data-file-line="46"]: the
  // data-file-line attribute must carry the line number (Lead ruling).
  detail.strictFileLineHook = await evaluate(win, `(() => {
    const strict = document.querySelector('[data-file-line="46"]');
    return {
      strict_found: strict !== null,
      legacy_found: document.querySelector('[data-file-line][data-line="46"]') !== null,
      sample_attr: (document.querySelector('[data-file-line]') || {}).getAttribute ? document.querySelector('[data-file-line]').getAttribute('data-file-line') : null,
    };
  })()`).catch(() => ({strict_found: false, legacy_found: false}));
  detail.steps.fileLine46Hook = detail.strictFileLineHook.strict_found === true;

  // Clicking a line highlights it.
  detail.clickLine46 = await evaluate(win, `(() => {
    const element = document.querySelector('[data-file-line][data-line="46"]') ?? document.querySelector('[data-line="46"]');
    if (!element) return {ok: false};
    (element.querySelector('button, [role="button"]') ?? element).click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(500);
  detail.line46Highlight = await waitFor(win, `(() => {
    const element = document.querySelector('[data-file-line][data-line="46"]');
    if (!element) return false;
    const selected = element.getAttribute('data-selected') === 'true' || element.getAttribute('aria-selected') === 'true'
      || element.getAttribute('data-highlight') === 'true' || /selected|highlight|current|active/i.test(element.className || '');
    return selected ? {selected: true, className: String(element.getAttribute('class') || ''), dataHighlight: element.getAttribute('data-highlight')} : false;
  })()`, 5000);
  detail.steps.line46Highlight = detail.line46Highlight !== false && detail.line46Highlight !== null;

  // Resource -> file jump: selecting the routes resource opens the details
  // panel; its 「定位源码」 action must switch to the file view and locate the
  // resource definition line (bus.c:26). Contract §6/§7.6.
  await clickTab(win, 'coupling');
  const couplingReady = await waitViewReady(win, 'coupling', 20000);
  detail.resourceJump = {coupling_ready: couplingReady.ready};
  if (couplingReady.ready) {
    detail.resourceJump.select = await evaluate(win, `(() => {
      const row = [...document.querySelectorAll('[data-resource-row][data-resource-id]')]
        .find((element) => /routes/.test(element.innerText || element.textContent || element.getAttribute('aria-label') || ''));
      if (!row) return {ok: false};
      const text = (row.innerText || row.textContent || '').replace(/\\s+/g, ' ');
      const lineMatch = /bus\\.c:(\\d+)/.exec(text);
      (row.closest('button, [role="button"], li') ?? row).click();
      return {ok: true, line: lineMatch === null ? null : Number(lineMatch[1]), text: text.slice(0, 200)};
    })()`).catch(() => ({ok: false}));
    await sleep(900);
    detail.resourceJump.locate = await evaluate(win, `(() => {
      const details = document.querySelector('[data-code-view="details"]');
      if (!details) return {ok: false, reason: 'details panel not opened by resource selection'};
      const button = [...details.querySelectorAll('button, [role="button"]')]
        .find((element) => /定位源码|定位文件|跳到源码/.test((element.textContent || '') + (element.getAttribute('aria-label') || '')));
      if (!button) return {ok: false, reason: 'details 定位源码 button missing', detailsText: (details.textContent || '').slice(0, 500)};
      button.click();
      return {ok: true};
    })()`).catch((error) => ({ok: false, reason: String(error && error.message ? error.message : error)}));
    detail.fileAfterResourceJump = await waitViewReady(win, 'file', 15000);
    await sleep(900);
    const targetResourceLine = detail.resourceJump.select.line ?? 26;
    detail.resourceJump.targetLine = targetResourceLine;
    detail.resourceJumpLine = await evaluate(win, `(() => {
      const target = ${targetResourceLine};
      const lines = [...document.querySelectorAll('[data-file-line]')];
      const row = lines.find((element) => Number(element.getAttribute('data-line')) === target);
      if (row === null) return {target_present: false, target};
      const view = document.querySelector('[data-code-view="view"][data-view="file"]');
      const rowRect = row.getBoundingClientRect();
      const viewRect = (view ?? row).getBoundingClientRect();
      const attrs = [...row.attributes].map((attribute) => [attribute.name, attribute.value.slice(0, 80)]);
      const marked = row.getAttribute('data-selected') === 'true' || row.getAttribute('aria-selected') === 'true'
        || row.getAttribute('data-highlight') === 'true' || /selected|highlight|current|active/i.test(String(row.getAttribute('class') || ''));
      return {
        target_present: true,
        marked,
        in_viewport: rowRect.top >= viewRect.top - 6 && rowRect.bottom <= viewRect.bottom + 6,
        attrs,
      };
    })()`).catch(() => ({target_present: false}));
    detail.steps.resourceJump = detail.resourceJump.select.ok === true
      && detail.resourceJump.locate.ok === true
      && detail.fileAfterResourceJump.ready === true
      && detail.resourceJumpLine.target_present === true
      && (detail.resourceJumpLine.marked === true || detail.resourceJumpLine.in_viewport === true);
  } else {
    detail.steps.resourceJump = false;
  }

  detail.ok = Object.values(detail.steps).every((value) => value === true);
  // screenshot in file-view state
  await screenshot(win, result, 'file');
  result.views.file = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// shared chrome: legend / details / gaps / console / absolute paths
// ---------------------------------------------------------------------------
async function checkChrome(win, result) {
  const detail = {ok: false, steps: {}};
  // Details panel: select a function first if the panel is closed.
  let details = await evaluate(win, `(() => {
    const element = document.querySelector('[data-code-view="details"]');
    return element === null ? null : {text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').slice(0, 1600)};
  })()`).catch(() => null);
  if (details === null) {
    await clickTab(win, 'tree');
    const treeReady = await waitViewReady(win, 'tree', 20000);
    if (treeReady.ready) {
      await evaluate(win, `(() => {
        const row = [...document.querySelectorAll('[data-tree-node]')].find((element) => /lookup_route/.test(element.textContent || ''));
        if (!row) return;
        const nameButton = row.querySelector('.dcr-tree-name') ?? [...row.querySelectorAll('button')].find((button) => !button.hasAttribute('data-tree-toggle')) ?? row;
        nameButton.click();
      })()`).catch(() => {});
      await sleep(1200);
    }
    details = await evaluate(win, `(() => {
      const element = document.querySelector('[data-code-view="details"]');
      return element === null ? null : {text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').slice(0, 1600)};
    })()`).catch(() => null);
  }
  detail.details = details;
  detail.steps.details = details !== null;

  // Legend: opened by the top-right "?" button (aria contains 颜色图例); the
  // legend stays mounted with `hidden` until the click state applies.
  detail.legendClick = await evaluate(win, `(() => {
    const button = [...document.querySelectorAll('button, [role="button"]')].find((element) => {
      const text = (element.textContent || '').trim();
      const aria = element.getAttribute('aria-label') || '';
      return text === '?' || /图例|legend/i.test(aria);
    });
    if (!button) return {found: false};
    button.click();
    return {found: true, text: (button.textContent || '').trim(), aria: button.getAttribute('aria-label') || ''};
  })()`).catch(() => ({found: false}));
  await sleep(700);
  detail.legend = await evaluate(win, `(() => {
    const legend = document.querySelector('[data-code-view="legend"]');
    if (legend === null) return null;
    const rect = legend.getBoundingClientRect();
    return {
      present: true,
      hidden: legend.hasAttribute('hidden'),
      visible: rect.width > 0 && rect.height > 0,
      text: (legend.innerText || legend.textContent || '').slice(0, 1600),
    };
  })()`).catch(() => null);
  detail.steps.legend = detail.legend !== null
    && (detail.legend.visible === true || detail.legend.hidden === false)
    && /静态确定|候选|未知|异常|边界/.test(detail.legend.text ?? '');

  detail.gaps = await readGaps(win);
  result.gaps = detail.gaps;
  const allGapText = (detail.gaps ?? []).map((gap) => `${gap.code} ${gap.text}`).join(' | ');
  detail.steps.gapsVerbatim = ['组折叠', '接口库', 'AI 归纳', '运行观测'].some((label) => allGapText.includes(label))
    || ['group_collapse', 'interface_library', 'ai_summary', 'run_observation'].some((code) => allGapText.includes(code));
  detail.leak = await evaluate(win, absolutePathLeakExpr()).catch(() => ({count: -1, samples: []}));
  detail.steps.noAbsolutePaths = detail.leak.count === 0;
  detail.selection = await evaluate(win, selectionExpr()).catch(() => null);
  detail.steps.selectionFocusFields = detail.selection !== null && typeof detail.selection === 'object'
    && Object.prototype.hasOwnProperty.call(detail.selection, 'focus_resource_id')
    && Object.prototype.hasOwnProperty.call(detail.selection, 'focus_callsite_id');
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.chrome = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const result = {
    ok: false,
    probe: 'five-views',
    url: url ? url.replace(/token=[^&]+/, 'token=<redacted>') : null,
    entry_name: expectEntry,
    expected_line: expectLine,
    expected_snapshot_id: expectSnapshotId,
    views: {},
    screenshots: {},
    steps: {},
    checks: {},
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
    win.webContents.on('render-process-gone', (_event, details) => {
      result.steps.rendererGone = details;
    });
    await win.loadURL(url);
    result.steps.pageLoaded = true;
    try {
      win.setOpacity(0);
      win.showInactive();
      result.steps.windowShownInvisible = true;
    } catch (error) {
      result.steps.windowShownInvisible = false;
      result.windowShowError = String(error && error.message ? error.message : error);
    }
    await waitFor(win, 'document.body && document.body.innerText.length > 0', 60000);
    result.steps.bodySettled = true;

    const opened = await openWorkbench(win, result);
    result.steps.workbenchOpened = opened === true;
    result.steps.tabsVisible = Boolean(await waitFor(win, `document.querySelectorAll('[data-code-view="tabs"] button[data-view]').length >= 5`, 20000));
    result.tabs = await readTabs(win);
    result.steps.tabsFive = ['coupling', 'tree', 'end_to_end', 'sequence', 'file'].every((view) => result.tabs.some((tab) => tab.view === view));

    // Per-view loop: switch, assert ready, verify, screenshot.
    const viewChecks = {
      coupling: checkCoupling,
      tree: checkTree,
      end_to_end: checkEndToEnd,
      sequence: checkSequence,
      file: checkFile,
    };
    result.viewStates = {};
    result.recoveries = [];
    const panelPresent = () => evaluate(win, `document.querySelector('[data-code-view="panel"]') !== null`).catch(() => false);
    const tabsPresent = () => evaluate(win, `document.querySelectorAll('[data-code-view="tabs"] button[data-view]').length >= 5`).catch(() => false);
    const ensurePanel = async (where) => {
      if (await panelPresent() && await tabsPresent()) return true;
      // Input-injection recovery only: if a synthetic drag/click artifact closed
      // the panel, reopen it and record the event (it is not silently ignored).
      await evaluate(win, clickSidebarEntry()).catch(() => {});
      const recovered = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 15000));
      result.recoveries.push({where, recovered, at_ms: Date.now() - startedAt});
      return recovered;
    };
    await ensurePanel('before-loop');
    for (const view of VIEWS) {
      await ensurePanel(`before-${view}`);
      const switchResult = await clickTab(win, view);
      const ready = await waitViewReady(win, view, 45000);
      result.viewStates[view] = {click: switchResult, state: ready.state, ready: ready.ready};
      if (!ready.ready) {
        result.steps[`view_${view}_ready`] = false;
        await screenshot(win, result, `${view}-not-ready`);
        continue;
      }
      const detail = await viewChecks[view](win, result);
      result.steps[`view_${view}_ready`] = true;
      result.steps[`view_${view}_assertions`] = detail.ok === true;
      result.panelAfterView = result.panelAfterView ?? {};
      result.panelAfterView[view] = {panel: await panelPresent(), tabs: await tabsPresent()};
    }

    // Chrome/legend/details/gaps + console + absolute path checks.
    await ensurePanel('before-chrome');
    const chrome = await checkChrome(win, result);
    result.steps.chrome = chrome.ok === true;
    result.steps.noConsoleErrors = consoleLines.filter((line) => Number(line.level) >= 3).length === 0;
    result.steps.panelStable = (result.recoveries ?? []).length === 0;

    // Main flowchart screenshot: end-to-end view after fit, with the legend
    // drawer closed again so the graph is the subject of the evidence frame.
    const closeLegend = await evaluate(win, `(() => {
      const legend = document.querySelector('[data-code-view="legend"]');
      if (legend === null || legend.hasAttribute('hidden')) return {closed: false, open: false};
      const button = [...document.querySelectorAll('button, [role="button"]')].find((element) => {
        const aria = element.getAttribute('aria-label') || '';
        const text = (element.textContent || '').trim();
        return text === '?' || /图例|legend/i.test(aria);
      });
      if (button) button.click();
      return {closed: button !== undefined, open: true};
    })()`).catch(() => ({closed: false, open: false}));
    result.legendClosedBeforeMain = closeLegend;
    await sleep(500);
    const endTab = await clickTab(win, 'end_to_end');
    const endReady = await waitViewReady(win, 'end_to_end', 30000);
    if (endReady.ready) {
      await evaluate(win, `(() => {
        const fit = document.querySelector('[data-graph-fit]');
        if (fit) fit.click();
        return true;
      })()`).catch(() => null);
      await sleep(500);
      await screenshot(win, result, 'main');
    }
    result.steps.mainScreenshot = (result.screenshots.main ?? {}).ok === true;

    // Panel-level final state.
    result.panelSelection = await evaluate(win, selectionExpr()).catch(() => null);
    result.panelTextTail = await evaluate(win, panelTextExpr(4000)).catch(() => '');
    result.finalOverlay = await evaluate(win, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      return {dialog_count: dialogs.length, texts: dialogs.map((element) => (element.innerText || element.textContent || element.getAttribute('aria-label') || '').slice(0, 100))};
    })()`).catch(() => null);

    const requiredSteps = [
      'pageLoaded', 'bodySettled', 'workbenchOpened', 'tabsVisible', 'tabsFive',
      'noConsoleErrors', 'chrome',
      ...VIEWS.map((view) => `view_${view}_ready`),
      ...VIEWS.map((view) => `view_${view}_assertions`),
      'mainScreenshot',
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
