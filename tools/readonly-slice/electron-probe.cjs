// Chromium render probe for the 04 read-only workbench slice (independent
// verifier artefact; not a shipped plugin component).
//
// Loads the real isolated rc.5 web URL in an installed Electron Chromium,
// drives the sidebar entry → panel → verified snapshot → entry → source →
// evidence/resources/gaps → return-to-chat → re-open → second entry flow
// against the frozen DOM hooks from docs/readonly-workbench-contract.md §7,
// records console output and captures a PNG. The host's own first-run
// preview/onboarding overlay is dismissed only where it would hide the
// workbench panel (mechanism borrowed from
// 08-workbench-ui/tools/isolated-profile/electron-probe.cjs; host UI, not part
// of the plugin under test). DOM assertions on the workbench itself are never
// skipped.
//
// Environment:
//   RV_URL                 isolated `dsh web` URL with its one-time token
//   RV_OUT                 JSON result path
//   RV_SHOT                PNG screenshot path
//   RV_ENTRY_NAME          first entry row to open (default bus_send)
//   RV_EXPECT_LINE         expected source line of the first entry (default 152)
//   RV_WRITE_ENTRY_NAME    second entry proving the exact write path (default bus_register)
//   RV_WRITE_EXPECT_LINE   expected source line of the second entry (default 50)
//   RV_EXPECT_SNAPSHOT_ID  snapshot candidate id to prefer
//   RV_TIMEOUT_MS          overall probe timeout (default 240000)
const {app, BrowserWindow} = require('electron');
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname} = require('node:path');

const url = process.env.RV_URL;
const out = process.env.RV_OUT;
const shot = process.env.RV_SHOT;
const expectEntry = process.env.RV_ENTRY_NAME || 'bus_send';
const expectEntryLine = Number(process.env.RV_EXPECT_LINE || '152');
const writeEntry = process.env.RV_WRITE_ENTRY_NAME || 'bus_register';
const writeEntryLine = Number(process.env.RV_WRITE_EXPECT_LINE || '50');
const expectSnapshotId = process.env.RV_EXPECT_SNAPSHOT_ID || null;
const overallTimeoutMs = Number(process.env.RV_TIMEOUT_MS || 240000);
const consoleLines = [];
const startedAt = Date.now();

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

function writeResult(payload) {
  try {
    if (out) {
      mkdirSync(dirname(out), {recursive: true});
      writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    }
  } catch (error) {
    console.error('probe result write failed', String(error && error.message ? error.message : error));
  }
}

function finish(payload) {
  payload.duration_ms = Date.now() - startedAt;
  payload.console_lines = consoleLines.slice(0, 200);
  writeResult(payload);
  app.exit(payload.ok === true ? 0 : 1);
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

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

/** Screenshot of the current page. The window is shown with opacity 0 right
 * after load so a real compositor frame is produced (a hidden Window can
 * return a stale frame for a heavy app); it stays invisible to the user. */
async function captureScreenshot(win) {
  try {
    const image = await win.webContents.capturePage();
    return {ok: true, method: 'capturePage', bytes: image.toPNG()};
  } catch (error) {
    return {ok: false, error: String(error && error.message ? error.message : error)};
  }
}

// The product's own host-level first-run overlay (preview notice / onboarding
// dialog) can cover the workbench panel. This is a best-effort dismissal of
// host dialogs only; it never touches the workbench DOM assertions and its
// outcome is recorded but is not a pass/fail gate (it is host UI, not the
// plugin under test).
async function dismissHostOverlays(win) {
  const attempts = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await evaluate(win, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      const preview = dialogs.some((element) => String(element.innerText || '').includes('预览版说明'));
      const onboarding = dialogs.some((element) => String(element.innerText || '').includes('开始使用'));
      if (dialogs.length === 0) return {done: true, dialogs: [], clicked: false};
      for (const dialog of dialogs) {
        const buttons = [...dialog.querySelectorAll('button')].filter(visible);
        const byText = (pattern) => buttons.find((node) => pattern.test((node.textContent || '').trim()));
        const byLabel = (pattern) => buttons.find((node) => pattern.test(node.getAttribute('aria-label') || ''));
        const candidate = byText(/稍后|跳过|继续/) ?? byLabel(/关闭|close|skip/i) ?? null;
        if (candidate) {
          candidate.click();
          return {done: false, dialogs: dialogs.map((el) => (el.innerText || '').slice(0, 80)), clicked: true, button: (candidate.textContent || candidate.getAttribute('aria-label') || '').slice(0, 40)};
        }
      }
      const closer = [...document.querySelectorAll('button')].filter(visible).find((node) =>
        /关闭|close/i.test(node.getAttribute('aria-label') || '') || ['×', '✕'].includes((node.textContent || '').trim()));
      if (closer) {
        closer.click();
        return {done: false, dialogs: dialogs.map((el) => (el.innerText || '').slice(0, 80)), clicked: true, button: 'generic-close'};
      }
      return {done: false, dialogs: dialogs.map((el) => (el.innerText || '').slice(0, 80)), clicked: false};
    })()`).catch((error) => ({done: false, clicked: false, error: String(error?.message ?? error)}));
    attempts.push({done: state.done === true, clicked: state.clicked === true, dialogs: state.dialogs ?? [], button: state.button ?? null});
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
      if (!leaf) return {ok: false, candidate_count: matching.length, body_has_label: document.body.innerText.includes('代码工作台')};
      const clickable = leaf.closest('button, a, [role="button"], [role="menuitem"]') ?? leaf;
      clickable.click();
      return {ok: true, tag: clickable.tagName, text: (clickable.textContent || '').trim().slice(0, 40), fallback: true};
    }
    button.click();
    return {ok: true, tag: button.tagName, text: (button.textContent || '').trim().slice(0, 40)};
  })()`;
}

function clickEntry(name) {
  return `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === ${JSON.stringify(name)});
    if (!row) return {ok: false, names: rows.map((element) => element.getAttribute('data-entry-name')).slice(0, 40)};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true, entry_id: row.getAttribute('data-entry-id'), entry_name: row.getAttribute('data-entry-name')};
  })()`;
}

function readSource(entryName, line) {
  return `(() => {
    const source = document.querySelector('[data-code-view="source"]');
    if (!source) return false;
    const rows = [...source.querySelectorAll('[data-line]')];
    if (rows.length === 0) return false;
    const lines = rows.map((row) => ({
      line: Number(row.getAttribute('data-line')),
      text: (row.innerText || '').replace(/\\s+/g, ' ').trim(),
      highlight: row.getAttribute('data-highlight') === 'true',
    }));
    const exact = lines.find((row) => row.line === ${line});
    const byText = lines.find((row) => row.text.includes(${JSON.stringify(entryName)}));
    const target = exact ?? byText;
    if (!target) return false;
    return {
      ok: true,
      target,
      target_contains_entry: target.text.includes(${JSON.stringify(entryName)}),
      line_count: lines.length,
      lines: lines.slice(0, 40),
      line_164: lines.find((row) => row.line === 164) ?? null,
      line_165: lines.find((row) => row.line === 165) ?? null,
      source_path_text: (() => {
        const header = source.querySelector('.dcr-section-head');
        return header === null ? '' : (header.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
      })(),
    };
  })()`;
}

function readResources() {
  return `(() => {
    const section = document.querySelector('[data-code-view="resources"]');
    if (!section) return {present: false, objects: [], accesses: [], text: ''};
    const objects = [...section.querySelectorAll('[data-resource-id]')].map((element) => ({
      resource_id: element.getAttribute('data-resource-id'),
      text: (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
    })).slice(0, 20);
    const accesses = [...section.querySelectorAll('[data-field-access]')].map((element) => ({
      access_id: element.getAttribute('data-field-access'),
      access: element.getAttribute('data-access'),
      certainty: element.getAttribute('data-certainty'),
      text: (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    })).slice(0, 30);
    return {
      present: true,
      status_text: (() => {
        const head = section.querySelector('.dcr-section-head');
        return head === null ? '' : (head.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
      })(),
      objects,
      accesses,
      text: (section.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1800),
    };
  })()`;
}

function readSelection() {
  return `(() => {
    const element = document.querySelector('[data-code-view="selection"]');
    if (!element) return null;
    try { return JSON.parse(element.textContent); } catch { return {raw: element.textContent.slice(0, 2000)}; }
  })()`;
}

async function main() {
  const result = {
    ok: false,
    url: url ? url.replace(/token=[^&]+/, 'token=<redacted>') : null,
    entry_name: expectEntry,
    expected_line: expectEntryLine,
    write_entry_name: writeEntry,
    write_expected_line: writeEntryLine,
    expected_snapshot_id: expectSnapshotId,
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
    // Force a real compositor frame without showing anything to the user; a
    // fully hidden window may keep returning a stale frame for this heavy app.
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

    result.sidebarProbe = await waitFor(win, `(() => {
      const byAria = [...document.querySelectorAll('[aria-label]')].filter((element) => (element.getAttribute('aria-label') || '').includes('代码工作台'));
      const textContentHas = document.body.textContent.includes('代码工作台');
      if (byAria.length === 0 && !textContentHas) return false;
      return {
        aria_count: byAria.length,
        aria_samples: byAria.slice(0, 4).map((element) => ({tag: element.tagName, aria: element.getAttribute('aria-label'), visible: element.getBoundingClientRect().width > 0})),
        text_content_has: textContentHas,
        inner_text_has: document.body.innerText.includes('代码工作台'),
      };
    })()`, 60000);
    result.steps.sidebarEntry = result.sidebarProbe !== false && result.sidebarProbe !== null;
    result.hostOverlaysBeforeOpen = await dismissHostOverlays(win);
    result.steps.hostOverlaysDismissedBeforeOpen = result.hostOverlaysBeforeOpen.dismissed === true;
    await sleep(400);
    result.clickOpen = await evaluate(win, clickSidebarEntry());
    result.steps.panelOpened = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000));
    if (!result.steps.panelOpened) {
      result.debug = await evaluate(win, `(() => ({
        body_text: document.body.innerText.slice(0, 3000),
        panel_keys: [...document.querySelectorAll('[data-code-view]')].map((el) => el.getAttribute('data-code-view')),
        buttons: [...document.querySelectorAll('button')].map((el) => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(0, 40),
      }))()`).catch(() => null);
      finish(result);
      return;
    }

    // Wait for the panel's own load cycle to settle (status hook from §7).
    result.steps.statusState = await waitFor(win, `(() => {
      const status = document.querySelector('[data-code-view="status"]');
      if (!status) return false;
      const state = status.getAttribute('data-state');
      return state !== null && state !== 'loading' ? state : false;
    })()`, 40000);
    result.steps.statusState = result.steps.statusState || null;

    // Record + click a verified snapshot candidate.
    result.snapshotCandidates = await evaluate(win, `(() => [...document.querySelectorAll('[data-snapshot-id]')].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        snapshot_id: element.getAttribute('data-snapshot-id'),
        status: element.getAttribute('data-snapshot-status'),
        text: (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        visible: rect.width > 0 && rect.height > 0,
      };
    }))()`).catch(() => []);
    const chosen = (() => {
      const candidates = result.snapshotCandidates;
      if (expectSnapshotId !== null) {
        const exact = candidates.find((candidate) => candidate.snapshot_id === expectSnapshotId);
        if (exact) return exact;
      }
      const verified = candidates.find((candidate) => /verified|已核验|fresh|freshness/i.test(candidate.text)
        || candidate.status === 'verified');
      return verified ?? candidates[0] ?? null;
    })();
    result.chosenSnapshot = chosen;
    result.steps.snapshotCandidatesFound = result.snapshotCandidates.length > 0;
    if (chosen !== null) {
      result.clickSnapshot = await evaluate(win, `(() => {
        const candidates = [...document.querySelectorAll('[data-snapshot-id]')];
        const element = candidates.find((node) => node.getAttribute('data-snapshot-id') === ${JSON.stringify(chosen.snapshot_id)});
        if (!element) return {ok: false};
        element.click();
        return {ok: true, snapshot_id: element.getAttribute('data-snapshot-id')};
      })()`).catch(() => ({ok: false}));
      result.steps.snapshotClicked = result.clickSnapshot.ok === true;
    }

    // Wait for entry rows, then open the expected entry.
    result.steps.entryListed = Boolean(await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 40000));
    result.entryCandidates = await evaluate(win, `(() => [...document.querySelectorAll('[data-entry-id][data-entry-name]')].map((element) => ({
      entry_id: element.getAttribute('data-entry-id'),
      entry_name: element.getAttribute('data-entry-name'),
      is_entry: element.getAttribute('data-entry-is-entry'),
      text: (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    })).slice(0, 40))()`).catch(() => []);
    result.clickEntry = await evaluate(win, clickEntry(expectEntry)).catch(() => ({ok: false}));
    result.steps.entryClicked = result.clickEntry.ok === true;

    // Source window: the expected definition line must exist with its text.
    result.sourceView = await waitFor(win, readSource(expectEntry, expectEntryLine), 40000).catch(() => false);
    result.steps.sourceLineOk = Boolean(result.sourceView && result.sourceView.ok === true && result.sourceView.target_contains_entry === true);
    result.steps.sourceBoundsOk = Boolean(result.sourceView
      && result.sourceView.line_164 !== null && result.sourceView.line_165 !== null
      && result.sourceView.line_164.text.includes('check_length')
      && result.sourceView.line_165.text.includes('-90'));
    if (!result.steps.sourceLineOk) {
      result.debug = await evaluate(win, `(() => ({
        panel_text: (document.querySelector('[data-code-view="panel"]')?.innerText || '').slice(0, 5000),
        source_text: (document.querySelector('[data-code-view="source"]')?.innerText || '').slice(0, 2000),
        error: document.querySelector('[data-code-view="error"]')?.getAttribute('data-error-code') ?? null,
      }))()`).catch(() => null);
    }

    // Evidence grading badges: exact must be present, plus may or source_text.
    result.evidenceClasses = await evaluate(win, `(() => [...new Set([...document.querySelectorAll('[data-evidence-class]')]
      .map((element) => element.getAttribute('data-evidence-class')))])()`).catch(() => []);
    result.steps.evidenceClassesPresent = Array.isArray(result.evidenceClasses)
      && result.evidenceClasses.includes('exact')
      && (result.evidenceClasses.includes('may') || result.evidenceClasses.includes('source_text'));

    // Resource identifiers: bus_send reads routes.max_len as `may`.
    result.resources = await evaluate(win, readResources()).catch(() => ({present: false, objects: [], accesses: []}));
    result.steps.resourcesReadPresent = result.resources.present === true
      && result.resources.objects.some((object) => object.text.includes('routes'))
      && result.resources.accesses.some((access) => access.access === 'read' && access.text.includes('max_len'));

    // Gap area: must be present, non-empty, and use data-gap-code rows.
    result.gaps = await evaluate(win, `(() => {
      const container = document.querySelector('[data-code-view="gaps"]');
      if (!container) return {present: false, non_empty: false, codes: [], text: ''};
      const codes = [...container.querySelectorAll('[data-gap-code]')].map((element) => element.getAttribute('data-gap-code'));
      return {
        present: true,
        non_empty: (container.innerText || '').trim().length > 0 || container.children.length > 0,
        codes,
        text: (container.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800),
      };
    })()`).catch(() => ({present: false, non_empty: false, codes: [], text: ''}));
    result.steps.gapsPresent = result.gaps.present === true && result.gaps.non_empty === true && result.gaps.codes.length > 0;

    // Five-view placeholders (§7) + shared selection JSON (§2/§7).
    result.fiveViews = await evaluate(win, `(() => [...document.querySelectorAll('[data-view]')].map((element) => ({
      view: element.getAttribute('data-view'),
      state: element.getAttribute('data-state'),
    })))()`).catch(() => []);
    result.steps.fiveViewPlaceholders = ['coupling', 'tree', 'end_to_end', 'sequence', 'file'].every((view) =>
      Array.isArray(result.fiveViews) && result.fiveViews.some((row) => row.view === view && row.state === 'not_available_in_readonly_slice'));
    result.selection = await evaluate(win, readSelection()).catch(() => null);
    result.steps.selectionEntrySelected = result.selection !== null
      && typeof result.selection === 'object'
      && typeof result.selection.entry_id === 'string'
      && result.selection.entry_id.length > 0;
    result.steps.selectionMatchesClickedEntry = result.steps.selectionEntrySelected
      && result.selection.entry_id === result.clickEntry.entry_id;

    result.panelDom = await evaluate(win, `(() => ({
      panel_present: document.querySelector('[data-code-view="panel"]') !== null,
      panel_title: (document.querySelector('[data-code-view="panel"] h1, [data-code-view="panel"] h2, [data-code-view="panel"] h3')?.textContent || '').trim().slice(0, 120),
      status_state: document.querySelector('[data-code-view="status"]')?.getAttribute('data-state') ?? null,
      snapshot_count: document.querySelectorAll('[data-snapshot-id]').length,
      entry_count: document.querySelectorAll('[data-entry-id][data-entry-name]').length,
      source_line_count: document.querySelectorAll('[data-code-view="source"] [data-line]').length,
      evidence_classes: [...new Set([...document.querySelectorAll('[data-evidence-class]')].map((element) => element.getAttribute('data-evidence-class')))],
      field_access_count: document.querySelectorAll('[data-field-access]').length,
      resource_id_count: document.querySelectorAll('[data-resource-id]').length,
      gap_codes: [...document.querySelectorAll('[data-gap-code]')].map((element) => element.getAttribute('data-gap-code')),
      error_code: document.querySelector('[data-code-view="error"]')?.getAttribute('data-error-code') ?? null,
      return_button: [...document.querySelectorAll('button')].some((node) => (node.textContent || '').includes('返回聊天')),
    }))()`).catch(() => null);

    // Return to chat, then re-open and prove the selection survived.
    result.clickReturn = await evaluate(win, `(() => {
      const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').includes('返回聊天'));
      if (!button) return {ok: false};
      button.click();
      return {ok: true};
    })()`).catch(() => ({ok: false}));
    result.steps.returnToChat = result.clickReturn.ok === true;
    result.steps.chatRestored = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') === null`, 20000));
    await sleep(500);
    result.reopenClick = await evaluate(win, clickSidebarEntry());
    result.steps.panelReopened = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000));
    if (result.steps.panelReopened) {
      result.steps.reopenedSourceLine = await waitFor(win, readSource(expectEntry, expectEntryLine), 30000).catch(() => false);
      result.steps.reopenedSourceKept = Boolean(result.steps.reopenedSourceLine && result.steps.reopenedSourceLine.ok === true);
      result.reopenSelection = await evaluate(win, readSelection()).catch(() => null);
      result.steps.reopenSelectionKept = result.reopenSelection !== null
        && typeof result.reopenSelection === 'object'
        && typeof result.reopenSelection.entry_id === 'string'
        && result.reopenSelection.entry_id.length > 0
        && result.reopenSelection.entry_id === result.clickEntry.entry_id;
    }

    // Second entry: the exact write path (routes.max_len at bus.c:46) must be
    // visible as a resource field-access, with an exact evidence badge.
    result.writeClick = await evaluate(win, clickEntry(writeEntry)).catch(() => ({ok: false}));
    result.steps.writeEntryClicked = result.writeClick.ok === true;
    if (result.steps.writeEntryClicked) {
      result.writeView = await waitFor(win, readSource(writeEntry, writeEntryLine), 30000).catch(() => false);
      result.steps.writeSourceLineOk = Boolean(result.writeView && result.writeView.ok === true);
      result.writeResources = await evaluate(win, readResources()).catch(() => ({present: false, objects: [], accesses: []}));
      const writeAccess = (result.writeResources.accesses ?? []).find((access) => access.access === 'write'
        && access.certainty === 'exact'
        && access.text.includes('max_len')
        && access.text.includes('bus.c:46'));
      result.writeAccess = writeAccess ?? null;
      result.steps.writeExactResource = Boolean(writeAccess);
      result.writeSelection = await evaluate(win, readSelection()).catch(() => null);
      result.steps.writeSelectionEntry = result.writeSelection !== null
        && typeof result.writeSelection === 'object'
        && typeof result.writeSelection.entry_id === 'string'
        && result.writeSelection.entry_id === result.writeClick.entry_id;
    }

    // Evidence screenshot (best-effort host-overlay dismissal; recorded, not gated).
    result.hostOverlaysBeforeCapture = await dismissHostOverlays(win);
    result.steps.hostOverlaysDismissedBeforeCapture = result.hostOverlaysBeforeCapture.dismissed === true;
    await sleep(800);
    result.finalOverlay = await evaluate(win, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      return {
        dialog_count: dialogs.length,
        dialog_texts: dialogs.map((element) => (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160)),
        onboardingVisible: dialogs.some((element) => String(element.innerText || '').includes('开始使用')),
        previewVisible: dialogs.some((element) => String(element.innerText || '').includes('预览版说明')),
        url: location.href.replace(/token=[^&]+/, 'token=<redacted>'),
        title: document.title,
      };
    })()`).catch(() => null);
    try {
      if (shot) {
        mkdirSync(dirname(shot), {recursive: true});
        const capture = await captureScreenshot(win);
        if (capture.ok === true) {
          writeFileSync(shot, capture.bytes);
          result.screenshot = shot;
          result.screenshot_method = capture.method;
          result.screenshot_bytes = capture.bytes.length;
          result.steps.screenshotCaptured = true;
        } else {
          result.screenshotError = capture.error;
        }
      }
      if (process.env.RV_SHOT2) {
        // Second frame: scroll to the exact write field-access so the
        // routes.max_len write at bus.c:46 is visible in evidence.
        const scrolled = await evaluate(win, `(() => {
          const writeAccess = document.querySelector('[data-field-access][data-access="write"]');
          const section = document.querySelector('[data-code-view="resources"]');
          const target = writeAccess ?? section;
          if (!target) return false;
          target.scrollIntoView({block: 'center'});
          return true;
        })()`).catch(() => false);
        await sleep(500);
        const capture2 = await captureScreenshot(win);
        if (capture2.ok === true) {
          mkdirSync(dirname(process.env.RV_SHOT2), {recursive: true});
          writeFileSync(process.env.RV_SHOT2, capture2.bytes);
          result.screenshot_resources = process.env.RV_SHOT2;
          result.screenshot_resources_bytes = capture2.bytes.length;
          result.steps.screenshotResourcesCaptured = scrolled === true;
        } else {
          result.screenshotResourcesError = capture2.error;
        }
      }
    } catch (error) {
      result.screenshotError = String(error && error.message ? error.message : error);
    }

    const consoleErrors = consoleLines.filter((line) => Number(line.level) >= 3);
    result.console_error_count = consoleErrors.length;
    result.steps.noConsoleErrors = consoleErrors.length === 0;
    result.ok = result.steps.pageLoaded === true
      && result.steps.sidebarEntry === true
      && result.steps.panelOpened === true
      && result.steps.snapshotCandidatesFound === true
      && result.steps.snapshotClicked === true
      && result.steps.entryListed === true
      && result.steps.entryClicked === true
      && result.steps.sourceLineOk === true
      && result.steps.sourceBoundsOk === true
      && result.steps.evidenceClassesPresent === true
      && result.steps.resourcesReadPresent === true
      && result.steps.gapsPresent === true
      && result.steps.fiveViewPlaceholders === true
      && result.steps.selectionEntrySelected === true
      && result.steps.selectionMatchesClickedEntry === true
      && result.steps.returnToChat === true
      && result.steps.chatRestored === true
      && result.steps.panelReopened === true
      && result.steps.reopenedSourceKept === true
      && result.steps.reopenSelectionKept === true
      && result.steps.writeEntryClicked === true
      && result.steps.writeSourceLineOk === true
      && result.steps.writeExactResource === true
      && result.steps.writeSelectionEntry === true
      && result.steps.noConsoleErrors === true
      && result.steps.screenshotCaptured === true;
    finish(result);
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    result.console_error_count = consoleLines.filter((line) => Number(line.level) >= 3).length;
    finish(result);
  }
}

app.whenReady().then(main);

setTimeout(() => {
  finish({ok: false, timeout: true, steps: {}, console_error_count: consoleLines.filter((line) => Number(line.level) >= 3).length});
}, overallTimeoutMs);
