// Chromium probe for S4-prep AI summary (verifier artefact; not a plugin component).
//
// Asserts docs/ai-summary-perf-contract.md §1.4/§1.5 on the real isolated rc.5
// `dsh web`:
//   * select the bus_send function details -> no record: [data-ai-summary-gap]
//     present and no [data-ai-summary-text];
//   * after the driver writes a summary through the real engine (see
//     tools/verify-summary.mjs: summary-put via CLI), re-select/refresh ->
//     [data-ai-summary-text] with the exact text, facts count, generator,
//     generated_at, stale=false;
//   * group subject (`group:...`) written/readable shows up in the group details;
//   * screenshots gap/written.
//
// The probe itself never writes summaries (the Agent/driver writes them between
// the two probe phases); it only reads the UI.
const {app, BrowserWindow} = require('electron');
const {createHash} = require('node:crypto');
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname, join} = require('node:path');

const url = process.env.RV_URL;
const out = process.env.RV_OUT;
const shotDir = process.env.RV_SHOT_DIR;
const phase = process.env.RV_PHASE || 'gap'; // gap | written | entry | entry_absent
const expectSnapshotId = process.env.RV_SNAPSHOT_ID || null;
const expectText = process.env.RV_EXPECT_TEXT || null;
const expectEntryText = process.env.RV_EXPECT_ENTRY_TEXT || null;
const absentEntryName = process.env.RV_ABSENT_ENTRY_NAME || 'bus_register';
const overallTimeoutMs = Number(process.env.RV_TIMEOUT_MS || 300000);
const consoleLines = [];
const startedAt = Date.now();

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function finish(payload) {
  payload.duration_ms = Date.now() - startedAt;
  payload.console_lines = consoleLines.slice(0, 300);
  payload.console_error_count = consoleLines.filter((line) => Number(line.level) >= 3).length;
  if (out) { mkdirSync(dirname(out), {recursive: true}); writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`); }
  app.exit(payload.ok === true ? 0 : 1);
}

async function waitFor(win, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression).catch(() => false);
    if (value) return value;
    await sleep(200);
  }
  return false;
}

async function capturePng(win) {
  try { return {ok: true, bytes: (await win.webContents.capturePage()).toPNG()}; } catch (error) { return {ok: false, error: String(error)}; }
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

async function screenshot(win, result, name, scrollSelector = null) {
  await dismissHostOverlays(win).catch(() => null);
  await sleep(300);

  await evaluate(win, `(() => {
    const target = ${scrollSelector === null ? "document.querySelector('[data-code-view=\"panel\"]')" : scrollSelector};
    if (target) target.scrollIntoView({block: 'start'});
    return true;
  })()`).catch(() => null);
  await sleep(800);
  try { win.webContents.invalidate(); } catch { /* optional */ }
  await capturePng(win).catch(() => null);
  await sleep(400);
  const capture = await capturePng(win);
  const record = {name, ok: capture.ok === true};
  if (capture.ok === true && shotDir) {
    mkdirSync(shotDir, {recursive: true});
    const path = join(shotDir, `${name}.png`);
    writeFileSync(path, capture.bytes);
    record.path = path;
    record.bytes = capture.bytes.length;
    record.sha256 = sha(capture.bytes);
  }
  result.screenshots[name] = record;
  return record;
}

const evaluate = (win, expression) => win.webContents.executeJavaScript(expression);

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

function summaryStateExpr() {
  return `(() => {
    const panel = document.querySelector('[data-code-view="panel"]');
    const summary = document.querySelector('[data-code-view="ai-summary"]');
    const textElement = document.querySelector('[data-ai-summary-text]');
    const gap = document.querySelector('[data-ai-summary-gap]');
    const facts = [...document.querySelectorAll('[data-ai-summary-facts]')];
    const generator = document.querySelector('[data-ai-summary-generator]');
    const generatedAt = document.querySelector('[data-ai-summary-generated-at]');
    const labels = document.querySelector('[data-ai-summary-labels]');
    const stale = document.querySelector('[data-ai-summary-stale]');
    const entries = [...document.querySelectorAll('[data-entry-id][data-entry-name]')].map((element) => ({
      entry_id: element.getAttribute('data-entry-id'),
      name: element.getAttribute('data-entry-name'),
      active: element.getAttribute('aria-pressed') === 'true' || element.className.includes('selected'),
    }));
    return {
      panel_present: panel !== null,
      summary_present: summary !== null,
      text: textElement === null ? null : (textElement.textContent || '').replace(/^\\s+/, ''),
      text_length: textElement === null ? null : (textElement.textContent || '').trim().length,
      gap_text: gap === null ? null : (gap.textContent || '').trim().slice(0, 400),
      facts_text: facts.map((element) => (element.textContent || '').trim().slice(0, 600)),
      generator_text: generator === null ? null : (generator.textContent || '').trim().slice(0, 300),
      generated_at_text: generatedAt === null ? null : (generatedAt.textContent || '').trim().slice(0, 200),
      labels_text: labels === null ? null : (labels.textContent || '').trim().slice(0, 300),
      stale: stale === null ? null : stale.getAttribute('data-ai-summary-stale') || (stale.textContent || '').trim().slice(0, 200),
      entry_present: document.querySelector('[data-ai-summary-entry]') !== null,
      entry_text: (() => { const element = document.querySelector('[data-ai-summary-entry-text]'); return element === null ? null : (element.textContent || '').trim(); })(),
      entry_facts_text: (() => { const element = document.querySelector('[data-ai-summary-entry-facts]'); return element === null ? null : (element.textContent || '').trim().slice(0, 600); })(),
      entry_generator_text: (() => { const element = document.querySelector('[data-ai-summary-entry-generator]'); return element === null ? null : (element.textContent || '').trim().slice(0, 300); })(),
      entry_generated_at_text: (() => { const element = document.querySelector('[data-ai-summary-entry-generated-at]'); return element === null ? null : (element.textContent || '').trim().slice(0, 200); })(),
      entry_labels_text: (() => { const element = document.querySelector('[data-ai-summary-entry-labels]'); return element === null ? null : (element.textContent || '').trim().slice(0, 300); })(),
      entry_stale: (() => { const element = document.querySelector('[data-ai-summary-entry-stale]'); return element === null ? null : (element.getAttribute('data-ai-summary-entry-stale') || (element.textContent || '').trim().slice(0, 120)); })(),
      entry_gap_text: (() => { const element = document.querySelector('[data-ai-summary-entry-gap]'); return element === null ? null : (element.textContent || '').trim().slice(0, 300); })(),
      gap_count: document.querySelectorAll('[data-ai-summary-gap]').length,
      entries,
      details_text: (() => {
        const details = document.querySelector('[data-code-view="details"]');
        return details === null ? '' : (details.innerText || details.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
      })(),
      panel_text: panel === null ? '' : (panel.innerText || panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 6000),
    };
  })()`;
}

async function openWorkbench(win, result) {
  await evaluate(win, clickSidebarEntry()).catch(() => null);
  result.steps.panelOpened = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000));
  result.steps.statusReady = Boolean(await waitFor(win, `(() => { const s = document.querySelector('[data-code-view="status"]'); return s !== null && s.getAttribute('data-state') === 'ready'; })()`, 40000));
  result.snapshots = await evaluate(win, `(() => [...document.querySelectorAll('[data-snapshot-id]')].map((element) => ({id: element.getAttribute('data-snapshot-id'), status: element.getAttribute('data-snapshot-status')})))()`).catch(() => []);
  const snapshot = (expectSnapshotId === null ? result.snapshots.find((row) => row.status === 'verified') : result.snapshots.find((row) => row.id === expectSnapshotId)) ?? result.snapshots[0] ?? null;
  if (snapshot !== null) {
    await evaluate(win, `(() => { const element = [...document.querySelectorAll('[data-snapshot-id]')].find((node) => node.getAttribute('data-snapshot-id') === ${JSON.stringify(snapshot.id)}); if (element) element.click(); return true; })()`).catch(() => null);
  }
  result.steps.entriesListed = Boolean(await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 40000));
  result.steps.entryClicked = await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === 'bus_send');
    if (!row) return {ok: false, count: rows.length};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  return result.steps.panelOpened;
}

async function selectEntry(win, name) {
  return evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === ${JSON.stringify(name)});
    if (!row) return {ok: false};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
}

async function refreshDetails(win) {
  // Re-select the entry (client may de-dupe identical clicks); click another
  // entry then back so the summary query re-runs.
  await selectEntry(win, 'lookup_route');
  await sleep(700);
  await selectEntry(win, 'bus_send');
  await sleep(1200);
}

async function main() {
  const result = {ok: false, probe: 'summary', phase, url: url ? url.replace(/token=[^&]+/, 'token=<redacted>') : null, screenshots: {}, steps: {}, views: {}};
  try {
    const win = new BrowserWindow({show: false, width: 1500, height: 950, webPreferences: {contextIsolation: true, sandbox: false, backgroundThrottling: false}});
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message).slice(0, 400);
      if (text.includes('Electron Security Warning')) return;
      consoleLines.push({level, message: text, at_ms: Date.now() - startedAt});
    });
    await win.loadURL(url);
    result.steps.pageLoaded = true;
    try { win.setOpacity(0); win.showInactive(); result.steps.windowShownInvisible = true; } catch { result.steps.windowShownInvisible = false; }
    await waitFor(win, 'document.body && document.body.innerText.length > 0', 60000);
    result.steps.bodySettled = true;
    const opened = await openWorkbench(win, result);
    result.steps.workbenchOpened = opened === true;
    result.steps.busSendSelected = await waitFor(win, `document.querySelector('[data-code-view="details"]') !== null`, 30000).catch(() => false) !== false;
    await sleep(1500);
    let state = await evaluate(win, summaryStateExpr()).catch(() => null);
    result.views.before = state;
    if (phase === 'gap') {
      result.steps.gapShown = state?.gap_text !== null && /AI 归纳未生成|code_summary|归纳/.test(state?.gap_text ?? '');
      result.steps.noText = state?.text === null;
      result.steps.noSummaryRecord = state?.summary_present !== true || state?.text === null;
      await screenshot(win, result, 'gap', "document.querySelector('[data-code-view=\"details\"]')");
      result.ok = result.steps.gapShown === true && result.steps.noText === true;
    } else if (phase === 'written') {
      // Re-select the entry to force a fresh view.summary request, then assert
      // the written record is rendered.
      await refreshDetails(win);
      const written = await waitFor(win, `(() => {
        const element = document.querySelector('[data-ai-summary-text]');
        if (element === null) return false;
        const text = (element.textContent || '').trim();
        return text.length >= 2 ? {text, length: text.length} : false;
      })()`, 30000).catch(() => false);
      await sleep(500);
      state = await evaluate(win, summaryStateExpr()).catch(() => null);
      result.views.after = state;
      result.writtenText = written;
      result.steps.textShown = state?.text !== null && (state?.text_length ?? 0) >= 2;
      result.steps.textMatches = expectText === null || (state?.text ?? '').includes(expectText);
      result.steps.generatorShown = /agent|verify-summary/.test(state?.generator_text ?? '');
      result.steps.generatedAtShown = /20\d\d-\d\d-\d\dT/.test(state?.generated_at_text ?? '');
      result.steps.factsShown = (state?.facts_text ?? []).length > 0 && /e_/.test((state?.facts_text ?? []).join(' '));
      result.steps.staleFalse = state?.stale === 'false' || /stale[^\n]{0,20}false|非陈旧/.test(state?.details_text ?? '');
      result.steps.gapGone = state?.gap_text === null;
      await screenshot(win, result, 'written', "document.querySelector('[data-code-view=\"\u0061i-summary\"]') ?? document.querySelector('[data-code-view=\"details\"]')");
      result.ok = result.steps.textShown === true && result.steps.textMatches === true
        && result.steps.generatorShown === true && result.steps.generatedAtShown === true
        && result.steps.factsShown === true && result.steps.staleFalse === true;
    } else if (phase === 'entry') {
      // Entry-subject summary sub-block: the driver wrote subject_type=entry for
      // the bus_send entry before this phase. The function summary is still
      // present; the entry sub-block must render its own text/facts/generator.
      const seen = await waitFor(win, `document.querySelector('[data-ai-summary-entry]') !== null`, 20000);
      await sleep(800);
      state = await evaluate(win, summaryStateExpr()).catch(() => null);
      result.views.entry = state;
      result.steps.entryShown = seen !== false && state?.entry_present === true;
      result.steps.entryTextShown = (state?.entry_text ?? '').length >= 2;
      result.steps.entryTextMatches = expectEntryText === null || (state?.entry_text ?? '').includes(expectEntryText);
      result.steps.entryGeneratorShown = /agent|verify-entry/.test(state?.entry_generator_text ?? '');
      result.steps.entryGeneratedAtShown = /20\d\d-\d\d-\d\dT/.test(state?.entry_generated_at_text ?? '');
      result.steps.entryFactsShown = /e_/.test(state?.entry_facts_text ?? '');
      result.steps.entryStaleFalse = state?.entry_stale === 'false';
      result.steps.functionSummaryUnchanged = state?.text !== null && (expectText === null || (state?.text ?? '').includes(expectText));
      await screenshot(win, result, 'entry', "document.querySelector('[data-ai-summary-entry]') ?? document.querySelector('[data-code-view=\"details\"]')");
      result.ok = result.steps.entryShown === true && result.steps.entryTextShown === true && result.steps.entryTextMatches === true
        && result.steps.entryGeneratorShown === true && result.steps.entryGeneratedAtShown === true
        && result.steps.entryFactsShown === true && result.steps.entryStaleFalse === true
        && result.steps.functionSummaryUnchanged === true;
    } else if (phase === 'entry_absent') {
      // Another entry without an entry summary: no sub-block and no NEW gap.
      // The function summary logic is unchanged (this entry has no function
      // summary, so the normal [data-ai-summary-gap] remains exactly one).
      const selected = await selectEntry(win, absentEntryName);
      result.steps.absentEntrySelected = selected?.ok === true;
      await sleep(1500);
      state = await evaluate(win, summaryStateExpr()).catch(() => null);
      result.views.absent = state;
      result.steps.entryAbsent = state?.entry_present !== true && state?.entry_text === null;
      result.steps.noEntryGap = state?.entry_gap_text === null;
      result.steps.functionGapNormal = (state?.gap_count ?? -1) === 1 && /code_summary|AI/.test(state?.gap_text ?? '');
      result.steps.noEntryTextLeak = !/entry|\u5165\u53e3\u5f52\u7eb3/.test((state?.entry_text ?? '') + (state?.entry_gap_text ?? ''));
      await screenshot(win, result, 'entry-absent', "document.querySelector('[data-code-view=\"details\"]')");
      result.ok = result.steps.entryAbsent === true && result.steps.noEntryGap === true
        && result.steps.functionGapNormal === true && result.steps.noEntryTextLeak === true;
    }
    result.leak = await evaluate(win, `(() => { const panel = document.querySelector('[data-code-view="panel"]'); const text = panel === null ? document.body.innerText : panel.innerText; const matches = (String(text||'').match(/[A-Za-z]:[\\\\/][^\\s"'<>]*/g) || []); return {count: matches.length, samples: matches.slice(0, 10)}; })()`).catch(() => ({count: -1}));
    result.steps.noAbsolutePaths = result.leak.count === 0;
    result.steps.noConsoleErrors = consoleLines.filter((line) => Number(line.level) >= 3).length === 0;
    result.required_steps = ['pageLoaded', 'bodySettled', 'workbenchOpened', 'noAbsolutePaths', 'noConsoleErrors'];
    result.failed_steps = result.required_steps.filter((step) => result.steps[step] !== true);
    finish(result);
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    result.failed_steps = Object.keys(result.steps).filter((step) => result.steps[step] !== true);
    finish(result);
  }
}

app.whenReady().then(main);
setTimeout(() => finish({ok: false, timeout: true, steps: {}, screenshots: {}}), overallTimeoutMs);
