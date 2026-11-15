/* 04 code-learning client module for DeepSeek Harness 0.2.1-rc.5.
Native rc.5 bundle: only require('react') is used (React.createElement, no JSX build step).
Read-only slice: verified Atlas snapshot -> entry -> bounded source window + direct calls +
evidence + preserved resource identifiers. Five views stay explicit placeholders. */
window.__ModuleLoader__.load({
id: '@local/dsh-code-reader',
factory: function (require) {
'use strict';

var module = {exports: {}};
var exports = module.exports;

var React = require('react');
var createElement = React.createElement;
var Fragment = React.Fragment;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;
var el = createElement;
var assign = Object.assign;

var PLUGIN_NAME = 'dsh-code-reader';
var PLUGIN_ID = '@local/dsh-code-reader';
var PANEL_KEY = 'dsh-code-reader';
var PANEL_LABEL = '代码工作台';
var CHANNEL = '/code-view';
var STYLE_ATTRIBUTE = 'data-code-view-style';
var MAX_ROWS = 2000;

var CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
var SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:\/-]{0,63}$/;
var EVIDENCE_CLASSES = ['exact', 'may', 'unknown', 'observed', 'source_text'];
var CERTAINTY_CLASSES = ['exact', 'may', 'unknown'];
var ACCESS_VALUES = ['read', 'write', 'rmw', 'init', 'deinit', 'alloc', 'free', 'acquire', 'release'];

var EVIDENCE_LABELS = {
exact: '静态确定',
may: '候选',
unknown: '未知',
observed: '运行观测',
source_text: '源码证据',
};

var ACCESS_LABELS = {
read: '读',
write: '写',
rmw: '读改写',
init: '初始化',
deinit: '去初始化',
alloc: '分配',
free: '释放',
acquire: '加锁',
release: '解锁',
};

var TEXT = {
subtitle: '只读切片：已核验快照 → 入口 → 源码 / 直接调用 / 证据 / 资源标识',
returnChat: '返回聊天',
refresh: '重新读取',
loading: '正在读取代码工作台数据…',
readyState: '工作台已就绪',
emptyState: '没有可用的已导入快照',
errorState: '读取失败',
gapState: '存在能力缺口',
snapshotsTitle: '快照',
snapshotsHint: '选择一个已登记 workspace / 变体下的 Atlas 快照。',
snapshotsLoading: '正在读取已导入快照…',
snapshotsFailed: '快照列表读取失败（见错误区）。',
snapshotsEmpty: '没有已导入的 Atlas 快照。',
snapshotsEmptyHint: '请先在 Host 侧登记 workspace 并导入已核验的 Atlas 快照。',
entriesTitle: '入口（入口优先）',
entriesHint: '先选快照，再点击入口查看定义源码与调用关系。',
entriesLoading: '正在读取入口列表…',
entriesFailed: '入口列表读取失败（见错误区）。',
entriesPrompt: '选择快照后列出入口。',
entriesEmpty: '该快照没有可列出的函数入口。',
entryLoading: '正在读取入口详情…',
entryIncomplete: '入口详情响应缺少 entry 字段。',
entryFailedHint: '入口读取失败（见错误区），可重新选择入口。',
noEntry: '尚未选择入口。',
sourceTitle: '源码',
sourceMissing: '入口响应未包含 source 区块，源码不可用。',
sourceUnavailable: '源码不可用：',
callsTitle: '直接调用（本函数调用的目标）',
callersTitle: '被调用（调用本函数的来源）',
callsEmpty: '没有可显示的直接调用边（或超出本切片范围）。',
callersEmpty: '没有可显示的调用来源边（入口可能无入边）。',
evidenceTitle: '证据',
evidenceEmpty: '没有可显示的 evidence 条目。',
resourcesTitle: '资源标识',
resourcesUnavailable: '资源层不可用：',
resourcesNote: '本切片保留资源标识与字段读写事实，不渲染资源关系图；不用空列表冒充“无资源”。',
resourcesEmpty: '该状态未投影到对象/字段访问；不在此处断言“无资源”。',
gapsTitle: '缺口与限制',
gapsEmpty: '当前没有识别到缺口。',
selectionTitle: '共享选择（Selection）',
viewsTitle: '五视图（本切片未提供）',
viewsHint: '以下五视图在本只读切片中未实现，逐项写清原因；不显示假数据。',
linksHint: '定位：先按 entry_id/symbol_id，其次仓库相对 file:line，再次名称并显式列出多候选。',
};

var FIVE_VIEWS = [
{key: 'coupling', title: '资源关系图', reason: '资源关系图图形化后置：本切片已保留资源标识与字段 write/read 事实（见资源标识区），但不渲染函数—资源三列图，也不画关系线。'},
{key: 'tree', title: '可折叠文字树', reason: '可折叠文字树后置：本切片只提供快照→入口→源码→直接调用/被调用边的线性导航，未实现按分支/数据流展开的树投影。'},
{key: 'end_to_end', title: '单入口端到端图', reason: '端到端图后置：本切片未实现入口流程投影与正交布局；只显示已解析的直接调用/被调用边。'},
{key: 'sequence', title: '时序图', reason: '时序图后置：本切片无运行观测（run_id/event_id/observation_refs），无法生成执行时序，也不伪造事件。'},
{key: 'file', title: '文件视图', reason: '文件视图后置：本切片只展示入口定义对应的有界源码窗口，不提供文件树与完整文件只读浏览。'},
];

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInteger(value) {
return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numberText(value) {
var number = toInteger(value);
return number === null ? '—' : String(number);
}

function copyNullableString(value) {
return typeof value === 'string' && value.length > 0 ? value : null;
}

function copyStringArray(value, limit) {
var max = typeof limit === 'number' ? limit : 256;
var result = [];
if (!Array.isArray(value)) return result;
for (var index = 0; index < value.length && index < max; index += 1) {
if (typeof value[index] === 'string' && value[index].length > 0) result.push(value[index]);
}
return result;
}

function cleanText(value, maxLength) {
if (typeof value !== 'string') return '';
var text = value.replace(CONTROL_CHARS, ' ');
if (text.length > maxLength) text = text.slice(0, maxLength) + '…';
return text;
}

/* Host/engine error text must never surface stacks or absolute paths. */
function safeMessage(value) {
if (typeof value !== 'string' || value.length === 0) return '';
var lines = value.split(/\r?\n/);
var kept = [];
for (var index = 0; index < lines.length && kept.length < 3; index += 1) {
var line = lines[index];
if (/^\s*at\s/.test(line)) break;
if (/^\s*$/.test(line)) continue;
kept.push(line);
}
var text = kept.join(' ');
text = text.replace(/[A-Za-z]:[\\/][^\s"'<>，。；)*]*/g, '[路径已隐藏]');
text = text.replace(/\\\\[^\s"'<>，。；)*]+/g, '[路径已隐藏]');
text = text.replace(/(?:^|\s)(\/(?:home|usr|var|etc|opt|root|tmp|mnt|srv|proc|sys|dev)\/[^\s"'<>，。；)*]*)/g, ' [路径已隐藏]');
text = text.replace(/\s+/g, ' ').trim();
if (text.length > 300) text = text.slice(0, 300) + '…';
return text;
}

function safeCode(value) {
var code = cleanText(typeof value === 'string' ? value : '', 64).trim();
return SAFE_CODE.test(code) ? code : 'UNKNOWN_ERROR';
}

function formatLocation(file, line) {
var name = copyNullableString(file);
var number = toInteger(line);
if (name !== null && number !== null) return name + ':' + number;
if (name !== null) return name;
return '位置未知';
}

function shortDigest(value) {
if (typeof value !== 'string' || value.length === 0) return '—';
return value.length > 12 ? value.slice(0, 12) + '…' : value;
}

function statusLabel(status) {
if (status === 'verified') return '已核验';
if (status === 'invalid') return '无效';
return String(status || '未知');
}

function freshnessLabel(freshness) {
if (freshness === 'fresh') return '最新';
if (freshness === 'stale') return '已过期';
return '未知';
}

function normalizeEvidenceClass(value) {
return EVIDENCE_CLASSES.indexOf(value) >= 0 ? value : 'unknown';
}

function normalizeCertainty(value) {
return CERTAINTY_CLASSES.indexOf(value) >= 0 ? value : 'unknown';
}

function normalizeAccess(value) {
return ACCESS_VALUES.indexOf(value) >= 0 ? value : 'unknown';
}

/* Call/return edges may carry observed trace evidence in addition to the
static exact/may/unknown classes; field-access certainty stays static-only. */
function normalizeEdgeCertainty(value) {
if (value === 'observed') return 'observed';
return normalizeCertainty(value);
}

function accessLabel(value) {
return ACCESS_LABELS[value] || String(value || '未知');
}

function selectionDefaults() {
return {
workspace_id: null,
variant_id: null,
snapshot_id: null,
repo_id: null,
entry_id: null,
symbol_id: null,
callsite_ids: [],
callsite_path: [],
resource_ids: [],
resource_status: 'unavailable',
evidence_ids: [],
run_id: null,
event_id: null,
};
}

function mergeSelectionField(target, source, field) {
if (!isRecord(source)) return;
if (field === 'resource_status') {
var status = copyNullableString(source[field]);
if (status !== null) target[field] = status;
return;
}
if (field === 'run_id' || field === 'event_id') {
var scalar = copyNullableString(source[field]);
if (scalar !== null) target[field] = scalar;
return;
}
if (field === 'callsite_ids' || field === 'callsite_path' || field === 'resource_ids' || field === 'evidence_ids') {
var list = copyStringArray(source[field], 200);
if (list.length > 0) target[field] = list;
return;
}
var value = copyNullableString(source[field]);
if (value !== null) target[field] = value;
}

function buildSelection(view) {
var selection = selectionDefaults();
var strings = ['workspace_id', 'variant_id', 'snapshot_id', 'repo_id', 'entry_id', 'symbol_id'];
var arrays = ['callsite_ids', 'callsite_path', 'resource_ids', 'evidence_ids'];
var sources = [view.entriesSelection, view.entrySelection];
for (var s = 0; s < sources.length; s += 1) {
for (var i = 0; i < strings.length; i += 1) mergeSelectionField(selection, sources[s], strings[i]);
for (var j = 0; j < arrays.length; j += 1) mergeSelectionField(selection, sources[s], arrays[j]);
mergeSelectionField(selection, sources[s], 'resource_status');
mergeSelectionField(selection, sources[s], 'run_id');
mergeSelectionField(selection, sources[s], 'event_id');
}
var snapshot = view.snapshot;
if (snapshot !== null) {
if (selection.workspace_id === null) selection.workspace_id = copyNullableString(snapshot.workspace_id);
if (selection.variant_id === null) selection.variant_id = copyNullableString(snapshot.variant_id);
if (selection.snapshot_id === null) selection.snapshot_id = copyNullableString(snapshot.snapshot_id);
if (selection.repo_id === null) selection.repo_id = copyNullableString(snapshot.repo_id);
}
var detail = view.entryDetail;
if (detail !== null) {
if (selection.entry_id === null) selection.entry_id = copyNullableString(detail.entry_id);
if (selection.symbol_id === null) selection.symbol_id = copyNullableString(detail.symbol_id);
}
if (selection.evidence_ids.length === 0 && isRecord(view.entryData) && Array.isArray(view.entryData.evidence)) {
var evidence = view.entryData.evidence;
for (var e = 0; e < evidence.length; e += 1) {
if (isRecord(evidence[e]) && copyNullableString(evidence[e].evidence_id) !== null) selection.evidence_ids.push(evidence[e].evidence_id);
}
}
return selection;
}

// ---------------------------------------------------------------------------
// read-model normalizers (keep raw strings, never throw on odd rows)
// ---------------------------------------------------------------------------

function flattenSnapshots(payload) {
var workspaces = isRecord(payload) && Array.isArray(payload.workspaces) ? payload.workspaces : [];
var rows = [];
for (var wi = 0; wi < workspaces.length && wi < 200; wi += 1) {
var workspace = workspaces[wi];
if (!isRecord(workspace)) continue;
var snapshots = Array.isArray(workspace.snapshots) ? workspace.snapshots : [];
for (var si = 0; si < snapshots.length && si < 500; si += 1) {
var snap = snapshots[si];
if (!isRecord(snap) || copyNullableString(snap.snapshot_id) === null) continue;
var coverage = isRecord(snap.coverage) ? snap.coverage : {};
rows.push({
workspace_id: copyNullableString(workspace.workspace_id),
variant_id: copyNullableString(snap.variant_id),
snapshot_id: snap.snapshot_id,
repo_id: copyNullableString(snap.repo_id),
status: copyNullableString(snap.status) || 'unknown',
freshness: copyNullableString(snap.freshness) || 'unknown',
entry_count: toInteger(snap.entry_count),
failed_count: toInteger(coverage.failed_count),
pending_count: toInteger(coverage.pending_count),
whole_program_complete: coverage.whole_program_complete === true,
error: isRecord(snap.error) ? {code: safeCode(snap.error.code), message: safeMessage(snap.error.message)} : null,
});
}
}
return rows;
}

function compareEntries(left, right) {
var leftEntry = left.is_entry === true ? 0 : 1;
var rightEntry = right.is_entry === true ? 0 : 1;
if (leftEntry !== rightEntry) return leftEntry - rightEntry;
var leftFile = copyNullableString(left.file) || '\uffff';
var rightFile = copyNullableString(right.file) || '\uffff';
if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1;
var leftLine = toInteger(left.line);
var rightLine = toInteger(right.line);
leftLine = leftLine === null ? Number.MAX_SAFE_INTEGER : leftLine;
rightLine = rightLine === null ? Number.MAX_SAFE_INTEGER : rightLine;
if (leftLine !== rightLine) return leftLine - rightLine;
var leftName = String(left.name || '');
var rightName = String(right.name || '');
if (leftName === rightName) return 0;
return leftName < rightName ? -1 : 1;
}

function normalizeEntries(payload) {
var list = isRecord(payload) && Array.isArray(payload.entries) ? payload.entries : [];
var rows = [];
for (var index = 0; index < list.length && index < MAX_ROWS; index += 1) {
if (isRecord(list[index])) rows.push(list[index]);
}
rows.sort(compareEntries);
return rows;
}

function findSnapshotRow(rows, snapshotId) {
if (typeof snapshotId !== 'string') return null;
for (var index = 0; index < rows.length; index += 1) {
if (rows[index].snapshot_id === snapshotId) return rows[index];
}
return null;
}

function findEntryRow(rows, entryId) {
if (typeof entryId !== 'string') return null;
for (var index = 0; index < rows.length; index += 1) {
if (rows[index].entry_id === entryId) return rows[index];
}
return null;
}

function hasEngineGap(statusData) {
if (!isRecord(statusData)) return false;
var engine = isRecord(statusData.engine) ? statusData.engine : {};
if (engine.python === 'missing') return true;
var bootstrap = isRecord(engine.bootstrap) ? engine.bootstrap : null;
if (bootstrap !== null && bootstrap.exists === false) return true;
var capabilities = isRecord(statusData.capabilities) ? statusData.capabilities : {};
if (capabilities.readonly_workbench === false) return true;
return false;
}

function hasObservedEvidence(view) {
var sources = [view.entriesSelection, view.entrySelection];
for (var s = 0; s < sources.length; s += 1) {
if (!isRecord(sources[s])) continue;
if (copyNullableString(sources[s].run_id) !== null || copyNullableString(sources[s].event_id) !== null) return true;
}
if (!isRecord(view.entryData)) return false;
var lists = [view.entryData.calls, view.entryData.callers, view.entryData.evidence];
for (var listIndex = 0; listIndex < lists.length; listIndex += 1) {
var list = lists[listIndex];
if (!Array.isArray(list)) continue;
for (var index = 0; index < list.length; index += 1) {
var row = list[index];
if (!isRecord(row)) continue;
if (row.certainty === 'observed' || row.origin === 'trace' || row.origin === 'observed' || row.kind === 'observed' || row.kind === 'trace') return true;
if (Array.isArray(row.observation_refs) && row.observation_refs.length > 0) return true;
}
}
return false;
}

function collectGaps(view) {
var gaps = [];
var serverKeys = {};
var codes = {};

function normalizeGap(gap) {
if (!isRecord(gap)) return null;
var code = typeof gap.code === 'string' && gap.code.length > 0 ? cleanText(gap.code, 64) : 'unknown_gap';
return {
code: code,
status: copyNullableString(gap.status) !== null ? cleanText(gap.status, 64) : 'unavailable',
reason: typeof gap.reason === 'string' ? gap.reason : '',
};
}

function push(normalized) {
gaps.push(normalized);
codes[normalized.code] = true;
}

/* Server gaps keep their original code/status/reason. Two server rows with the
same code but different reasons (for example a Host capability gap and a
resource-layer gap) are both kept. */
function addServer(gap) {
var normalized = normalizeGap(gap);
if (normalized === null) return;
var key = normalized.code + '\u0000' + normalized.status + '\u0000' + normalized.reason;
if (serverKeys[key] === true) return;
serverKeys[key] = true;
push(normalized);
}

/* Derived gaps are fallbacks: never repeat a code the server already covers. */
function addDerived(gap) {
var normalized = normalizeGap(gap);
if (normalized === null || codes[normalized.code] === true) return;
push(normalized);
}

/* Resource-layer reasons must stay visible even when the Host already reports
a view-level resource_graph gap; dedupe by code+reason only. */
function addResourceReason(gap) {
var normalized = normalizeGap(gap);
if (normalized === null) return;
for (var index = 0; index < gaps.length; index += 1) {
if (gaps[index].code === normalized.code && gaps[index].reason === normalized.reason) return;
}
push(normalized);
}

var statusData = view.status;
var servers = [
statusData !== null ? statusData.gaps : null,
view.snapshotGaps,
view.entriesGaps,
isRecord(view.entryData) ? view.entryData.gaps : null,
isRecord(view.entryData) && isRecord(view.entryData.resources) ? view.entryData.resources.gaps : null,
];
for (var s = 0; s < servers.length; s += 1) {
if (!Array.isArray(servers[s])) continue;
for (var index = 0; index < servers[s].length && index < 200; index += 1) addServer(servers[s][index]);
}

if (isRecord(statusData)) {
var engine = isRecord(statusData.engine) ? statusData.engine : {};
var capabilities = isRecord(statusData.capabilities) ? statusData.capabilities : {};
if (engine.python === 'missing') {
addDerived({code: 'engine_python_missing', status: 'unavailable', reason: 'view.status 报告 Python 引擎不可用（engine.python=missing），无法读取真实分析结果。'});
}
var bootstrap = isRecord(engine.bootstrap) ? engine.bootstrap : null;
if (bootstrap !== null && bootstrap.exists === false) {
addDerived({code: 'bootstrap_missing', status: 'unavailable', reason: '引导文件缺失（engine.bootstrap.exists=false），请先在 Host 侧配置 bootstrap 后再打开面板。'});
}
if (capabilities.readonly_workbench === false) {
addDerived({code: 'readonly_workbench_unavailable', status: 'unavailable', reason: '宿主未提供只读工作台能力（capabilities.readonly_workbench=false）。'});
}
}

if (view.snapshots !== null) {
var rows = view.snapshots;
var invalidCount = 0;
for (var ri = 0; ri < rows.length; ri += 1) {
var row = rows[ri];
if (row.status === 'invalid') {
invalidCount += 1;
if (invalidCount <= 8) {
addDerived({
code: row.error !== null && row.error.code !== null ? row.error.code : 'invalid_snapshot',
status: 'invalid',
reason: row.error !== null && row.error.message !== '' ? row.error.message : '快照核验未通过（status=invalid），该快照不能作为可信事实来源。',
});
}
} else if (row.freshness === 'stale') {
addDerived({code: 'snapshot_stale', status: 'stale', reason: '快照已过期（freshness=stale），分析结果可能不是最新；请重新导入或核验。'});
}
}
if (view.snapshotWorkspaces === 0) {
if (codes.workspace !== true) addDerived({code: 'no_workspace', status: 'unavailable', reason: '没有已登记的 workspace；请先在 Host 侧登记代码仓库。'});
} else if (rows.length === 0) {
if (codes.snapshot !== true) addDerived({code: 'no_snapshot', status: 'unavailable', reason: '已登记 workspace 但没有已导入的 Atlas 快照；请先在 Host 侧导入并核验快照。'});
}
}

var detail = view.entryDetail;
if (detail !== null && (detail.file === null || detail.file === undefined)) {
addDerived({code: 'entry_location_unresolved', status: 'degraded', reason: '入口位置未知：无法映射到已登记仓库根，不会回退为绝对路径。'});
} else if (detail !== null && toInteger(detail.line) === null) {
addDerived({code: 'entry_line_unknown', status: 'degraded', reason: '入口函数在该快照中没有可用的 evidence 行号。'});
}
if (isRecord(view.entryData)) {
var source = view.entryData.source;
if (isRecord(source) && source.status !== 'ok') {
addResourceReason({code: 'source_unavailable', status: 'unavailable', reason: '源码不可读：' + (copyNullableString(source.reason) || 'source.status=' + String(source.status || 'unknown'))});
}
var resources = view.entryData.resources;
if (isRecord(resources) && resources.status === 'unavailable') {
addResourceReason({
code: 'resource_graph',
status: 'unavailable',
reason: copyNullableString(resources.reason) || '快照未提供 objects/field_accesses 资源层，资源标识不可用。',
});
}
}

if (!hasObservedEvidence(view)) {
addDerived({code: 'run_observation', status: 'unavailable', reason: '本切片未提供运行观测：无 run_id/event_id/observation_refs，运行证据不可用。'});
}
addDerived({code: 'five_views', status: 'unavailable', reason: '五视图投影未实现：资源关系图、可折叠文字树、端到端图、时序图、文件视图均为占位，原因见各占位卡。'});

return gaps;
}

function computeState(view) {
if (view.phase === 'loading') return 'loading';
if (view.phase === 'error') return 'error';
if (hasEngineGap(view.status)) return 'gap';
if (view.snapshots !== null && view.snapshots.length === 0) return 'empty';
return 'ready';
}

function collectErrors(view) {
var errors = [];
var candidates = [view.statusError, view.snapshotsError, view.entriesError, view.entryError, view.actionError];
for (var index = 0; index < candidates.length; index += 1) {
if (candidates[index] !== null && candidates[index] !== undefined) errors.push(candidates[index]);
}
return errors.slice(0, 3);
}

function statusMessage(view, state, gapCount, errors) {
if (state === 'loading') return TEXT.loading;
if (state === 'error') {
var code = errors.length > 0 ? errors[0].code : 'UNKNOWN_ERROR';
return TEXT.errorState + '（' + code + '，详见错误区）';
}
if (state === 'gap') return TEXT.gapState + '（已识别 ' + gapCount + ' 项缺口，见缺口区；面板保留可用部分）';
if (state === 'empty') return TEXT.emptyState;
var parts = [TEXT.readyState];
if (view.snapshot !== null) {
parts.push('快照 ' + view.snapshot.snapshot_id + '（' + String(view.snapshot.workspace_id) + ' / ' + String(view.snapshot.variant_id) + ' / ' + String(view.snapshot.freshness) + '）');
}
if (view.entries !== null) parts.push('入口 ' + String(view.entries.length) + ' 个');
if (view.entryDetail !== null) parts.push('当前入口 ' + String(view.entryDetail.name || view.entryDetail.entry_id));
return parts.join('；');
}

// ---------------------------------------------------------------------------
// scoped stylesheet (theme inherits Host: currentColor / var(--dsh-*, fallback))
// ---------------------------------------------------------------------------

var CSS = [
'.dcr-root{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px;max-width:1200px;margin:0 auto;color:var(--dsh-text-color,currentColor);background:var(--dsh-panel-background,transparent);font:inherit;line-height:1.5;overflow-wrap:anywhere;}',
'.dcr-root *{box-sizing:border-box;}',
'.dcr-header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));}',
'.dcr-brand{display:flex;align-items:flex-start;gap:10px;min-width:0;}',
'.dcr-title{font-size:18px;line-height:1.4;margin:0 0 2px;font-weight:600;color:inherit;}',
'.dcr-meta{margin:2px 0;color:var(--dsh-text-muted,currentColor);opacity:0.9;}',
'.dcr-muted{margin:2px 0;color:var(--dsh-text-muted,currentColor);opacity:0.78;}',
'.dcr-header-actions{display:flex;flex-wrap:wrap;gap:8px;}',
'.dcr-btn{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.45));background:var(--dsh-button-background,transparent);color:inherit;cursor:pointer;min-height:32px;}',
'.dcr-btn-primary{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-btn:disabled{cursor:not-allowed;opacity:0.55;}',
'.dcr-btn:focus-visible,.dcr-snapshot:focus-visible,.dcr-entry:focus-visible{outline:2px solid var(--dsh-focus-color,currentColor);outline-offset:2px;}',
'.dcr-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;border:1px dashed var(--dsh-border-color,rgba(127,127,127,0.5));border-radius:8px;}',
'.dcr-status-label{font-weight:600;}',
'.dcr-notice{margin:4px 0;color:var(--dsh-text-muted,currentColor);}',
'.dcr-errors{display:flex;flex-direction:column;gap:6px;}',
'.dcr-error{border:1px solid var(--dsh-danger-color,currentColor);border-radius:8px;padding:8px 10px;margin:2px 0;color:var(--dsh-danger-color,currentColor);}',
'.dcr-error-code{font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);}',
'.dcr-error-note{color:var(--dsh-danger-color,currentColor);}',
'.dcr-layout{display:grid;grid-template-columns:minmax(220px,320px) minmax(0,1fr);gap:16px;align-items:start;}',
'.dcr-sidebar{display:flex;flex-direction:column;gap:12px;min-width:0;}',
'.dcr-main{display:flex;flex-direction:column;gap:12px;min-width:0;}',
'.dcr-section{margin:6px 0;min-width:0;}',
'.dcr-section-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;}',
'.dcr-heading{font-size:15px;line-height:1.4;margin:0 0 6px;font-weight:600;color:inherit;}',
'.dcr-subheading{font-size:13px;line-height:1.4;margin:8px 0 4px;font-weight:600;color:inherit;}',
'.dcr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}',
'.dcr-snapshot,.dcr-entry{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:8px;padding:8px 10px;cursor:pointer;}',
'.dcr-snapshot.dcr-selected,.dcr-entry.dcr-selected{border-color:var(--dsh-accent-color,currentColor);box-shadow:inset 3px 0 0 var(--dsh-accent-color,currentColor);}',
'.dcr-snapshot-line1,.dcr-entry-name{font-weight:600;}',
'.dcr-chip{display:inline-block;padding:0 6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));border-radius:999px;font-size:12px;line-height:1.7;white-space:nowrap;}',
'.dcr-badge{display:inline-block;padding:0 6px;border-radius:6px;font-size:12px;line-height:1.7;border:1px solid currentColor;white-space:nowrap;}',
'.dcr-badge-exact{border-style:solid;font-weight:600;}',
'.dcr-badge-may{border-style:dashed;}',
'.dcr-badge-unknown{border-style:dotted;opacity:0.85;}',
'.dcr-badge-observed{border-style:double;}',
'.dcr-badge-source_text{border-style:solid;opacity:0.9;}',
'.dcr-code{margin:4px 0;padding:8px 0;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:8px;overflow-x:auto;font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:13px;line-height:1.55;}',
'.dcr-line{display:flex;gap:12px;white-space:pre;min-width:0;}',
'.dcr-line-no{flex:0 0 auto;min-width:4ch;text-align:right;color:var(--dsh-text-muted,currentColor);opacity:0.7;user-select:none;}',
'.dcr-line-text{flex:0 0 auto;}',
'.dcr-line-hit{background:var(--dsh-highlight-background,rgba(127,127,127,0.18));}',
'.dcr-line-hit .dcr-line-no{opacity:1;}',
'.dcr-edges{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}',
'.dcr-edge{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:6px 8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;}',
'.dcr-evidence-row{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;}',
'.dcr-resource,.dcr-field-access{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:6px 8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;}',
'.dcr-resource-name{font-weight:600;}',
'.dcr-gaps{display:flex;flex-direction:column;gap:6px;}',
'.dcr-gap{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:6px 8px;border-left:3px solid var(--dsh-warning-color,currentColor);background:var(--dsh-gap-background,transparent);}',
'.dcr-gap-code{font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-weight:600;}',
'.dcr-views{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
'.dcr-view{border:1px dashed var(--dsh-border-color,rgba(127,127,127,0.5));border-radius:8px;padding:10px;}',
'.dcr-view-title{font-size:13px;line-height:1.4;margin:0 0 4px;font-weight:600;color:inherit;}',
'.dcr-selection{margin:0;padding:10px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:8px;overflow-x:auto;font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.5;color:inherit;background:transparent;}',
'@media (max-width:720px){.dcr-layout{grid-template-columns:minmax(0,1fr);}.dcr-views{grid-template-columns:minmax(0,1fr);}}',
'@media (prefers-reduced-motion:reduce){.dcr-root *{transition:none !important;animation:none !important;}}',
'@media (forced-colors:active){.dcr-snapshot,.dcr-entry,.dcr-chip,.dcr-badge,.dcr-code,.dcr-edge,.dcr-gap{border-color:ButtonText;}.dcr-line-hit{background:Highlight;color:HighlightText;}}',
].join('\n');

var styleElement = null;

function findStyle() {
try {
return document.querySelector('style[data-code-view-style]');
} catch (error) {
return null;
}
}

function ensureStyle() {
if (typeof document === 'undefined' || document === null || !document.head) return null;
if (styleElement !== null && styleElement.parentNode) return styleElement;
var existing = findStyle();
if (existing !== null) {
styleElement = existing;
return existing;
}
var node = document.createElement('style');
node.setAttribute(STYLE_ATTRIBUTE, '');
node.textContent = CSS;
document.head.appendChild(node);
styleElement = node;
return node;
}

function removeStyle(node) {
if (node && node.parentNode) node.parentNode.removeChild(node);
if (styleElement === node) styleElement = null;
}

// ---------------------------------------------------------------------------
// presentational components (no hooks, no context)
// ---------------------------------------------------------------------------

function CodeReaderIcon(props) {
var size = props && typeof props.size === 'number' ? props.size : 18;
return el('svg', {
role: 'img',
'aria-label': PANEL_LABEL,
focusable: 'false',
width: size,
height: size,
viewBox: '0 0 18 18',
},
el('path', {d: 'M6 3 2 9l4 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round'}),
el('path', {d: 'M12 3l4 6-4 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round'}),
el('path', {d: 'M10.5 2.5 7.5 15.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round'})
);
}

function EvidenceBadge(props) {
var value = normalizeEvidenceClass(props.value);
return el('span', {
className: 'dcr-badge dcr-badge-' + value,
'data-evidence-class': value,
}, EVIDENCE_LABELS[value]);
}

function StatusBar(props) {
return el('div', {
className: 'dcr-status',
'data-code-view': 'status',
'data-state': props.state,
role: 'status',
'aria-live': 'polite',
'aria-atomic': 'true',
'aria-busy': props.state === 'loading' ? 'true' : 'false',
},
el('span', {className: 'dcr-status-label'}, props.text),
props.gapCount > 0 ? el('span', {className: 'dcr-chip'}, '缺口 ' + String(props.gapCount)) : null
);
}

function ErrorSection(props) {
if (!props.errors.length) return null;
return el('div', {className: 'dcr-errors'}, props.errors.map(function (error, index) {
return el('div', {
key: index,
className: 'dcr-error',
'data-code-view': 'error',
'data-error-code': error.code,
role: 'alert',
},
el('strong', {className: 'dcr-error-code'}, String(error.code)),
' ',
el('span', {className: 'dcr-error-message'}, String(error.message || ''))
);
}));
}

function SnapshotList(props) {
if (props.loading === true) return el('p', {className: 'dcr-muted', role: 'status'}, TEXT.snapshotsLoading);
if (props.rows === null) {
return el('p', {className: 'dcr-muted'}, props.error !== null ? TEXT.snapshotsFailed : TEXT.snapshotsLoading);
}
if (props.rows.length === 0) {
return el('div', null,
el('p', {className: 'dcr-muted'}, TEXT.snapshotsEmpty),
el('p', {className: 'dcr-muted'}, TEXT.snapshotsEmptyHint)
);
}
return el('ul', {className: 'dcr-list', 'aria-label': TEXT.snapshotsTitle}, props.rows.map(function (row) {
var selected = props.selectedId === row.snapshot_id;
var key = String(row.workspace_id) + '/' + String(row.variant_id) + '/' + row.snapshot_id;
return el('li', {key: key, className: 'dcr-snapshot-item'},
el('button', {
type: 'button',
className: 'dcr-snapshot' + (selected ? ' dcr-selected' : ''),
'data-snapshot-id': row.snapshot_id,
'data-snapshot-status': row.status,
'aria-pressed': selected ? 'true' : 'false',
'aria-label': '快照 ' + row.snapshot_id + '，状态 ' + row.status,
onClick: function () { props.onSelect(row); },
},
el('span', {className: 'dcr-snapshot-line1'}, String(row.workspace_id || '—') + ' → ' + String(row.variant_id || '—') + ' → ' + row.snapshot_id),
el('span', {className: 'dcr-snapshot-line2'},
el('span', {className: 'dcr-chip'}, '状态 ' + statusLabel(row.status) + '（' + row.status + '）'),
' ',
el('span', {className: 'dcr-chip'}, '新鲜度 ' + freshnessLabel(row.freshness) + '（' + row.freshness + '）'),
' ',
el('span', {className: 'dcr-chip'}, '入口 ' + numberText(row.entry_count)),
' ',
el('span', {className: 'dcr-chip'}, 'failed ' + numberText(row.failed_count)),
' ',
el('span', {className: 'dcr-chip'}, 'pending ' + numberText(row.pending_count)),
' ',
el('span', {className: 'dcr-chip'}, 'whole_program_complete ' + (row.whole_program_complete === true ? 'true' : 'false'))
),
row.status === 'invalid' && row.error !== null
? el('span', {className: 'dcr-error-note'}, '核验错误 ' + row.error.code + '：' + row.error.message)
: null
)
);
}));
}

function EntryList(props) {
if (props.loading === true) return el('p', {className: 'dcr-muted', role: 'status'}, TEXT.entriesLoading);
if (props.rows === null) {
return el('p', {className: 'dcr-muted'}, props.error !== null ? TEXT.entriesFailed : TEXT.entriesPrompt);
}
if (props.rows.length === 0) return el('p', {className: 'dcr-muted'}, TEXT.entriesEmpty);
return el('ul', {className: 'dcr-list', 'aria-label': TEXT.entriesTitle}, props.rows.map(function (row) {
var entryId = copyNullableString(row.entry_id);
var entryName = copyNullableString(row.name) || copyNullableString(row.display_name) || entryId || 'unknown';
var selected = props.selectedEntryId !== null && props.selectedEntryId === entryId;
return el('li', {key: entryId || entryName, className: 'dcr-entry-item'},
el('button', {
type: 'button',
className: 'dcr-entry' + (selected ? ' dcr-selected' : ''),
'data-entry-id': entryId || '',
'data-entry-name': entryName,
'data-entry-is-entry': row.is_entry === true ? 'true' : 'false',
'aria-current': selected ? 'true' : undefined,
'aria-label': '入口 ' + entryName + ' ' + formatLocation(row.file, row.line),
onClick: function () { props.onSelect(row); },
},
el('span', {className: 'dcr-entry-name'},
entryName,
row.is_entry === true ? '（入口）' : ''
),
el('span', {className: 'dcr-meta'}, '位置 ' + formatLocation(row.file, row.line) + (row.file_status === 'path_unresolved' ? '（位置未解析）' : '')),
row.signature ? el('span', {className: 'dcr-meta'}, '签名 ' + String(row.signature)) : null,
el('span', {className: 'dcr-meta'}, 'callers ' + numberText(row.callers) + ' · callees ' + numberText(row.callees))
)
);
}));
}

function EntryDetailView(props) {
var view = props.view;
if (view.entryLoading === true) return el('p', {className: 'dcr-muted', role: 'status'}, TEXT.entryLoading);
if (view.entryDetail === null) {
if (view.entryError !== null) return el('p', {className: 'dcr-error'}, TEXT.entryFailedHint);
if (view.entryData !== null) return el('p', {className: 'dcr-muted'}, TEXT.entryIncomplete);
return el('p', {className: 'dcr-muted'}, TEXT.noEntry);
}
var detail = view.entryDetail;
var parameters = Array.isArray(detail.parameters) ? detail.parameters : [];
return el('div', {className: 'dcr-entry-detail'},
el('h2', {className: 'dcr-heading'}, String(detail.display_name || detail.name || detail.entry_id || '入口')),
el('p', {className: 'dcr-meta'}, 'entry_id ' + String(detail.entry_id || '—') + ' · 类型 ' + String(detail.kind || '—') + ' · 存储 ' + String(detail.storage || '—')),
el('p', {className: 'dcr-meta'}, '签名 ' + String(detail.signature || '—') + (detail.return_type ? ' · 返回 ' + String(detail.return_type) : '')),
el('p', {className: 'dcr-meta'}, '位置 ' + formatLocation(detail.file, detail.line) + (detail.file === null || detail.file === undefined ? '（位置未知，已计入缺口）' : '')),
parameters.length > 0 ? el('p', {className: 'dcr-meta'}, '参数 ' + parameters.map(function (parameter) {
return String(parameter && parameter.name ? parameter.name : '?') + ':' + String(parameter && parameter.type ? parameter.type : '?');
}).join(', ')) : null,
detail.summary ? el('p', {className: 'dcr-meta'}, '摘要（' + String(detail.summary_origin || 'unknown') + '）：' + String(detail.summary)) : null
);
}

function SourceView(props) {
var source = props.source;
if (!isRecord(source)) {
return el('section', {className: 'dcr-section', 'data-code-view': 'source'},
el('h3', {className: 'dcr-heading'}, TEXT.sourceTitle),
el('p', {className: 'dcr-muted'}, TEXT.sourceMissing)
);
}
var lines = Array.isArray(source.lines) ? source.lines : [];
var header = el('div', {className: 'dcr-section-head'},
el('h3', {className: 'dcr-heading'}, TEXT.sourceTitle),
source.status === 'ok' ? el(EvidenceBadge, {value: 'source_text'}) : null,
el('span', {className: 'dcr-meta'}, formatLocation(source.path, source.line_start) + (toInteger(source.line_end) !== null ? '–' + String(source.line_end) : '')),
source.truncated === true ? el('span', {className: 'dcr-chip'}, '已截断') : null
);
if (source.status !== 'ok' || lines.length === 0) {
return el('section', {className: 'dcr-section', 'data-code-view': 'source'},
header,
el('p', {className: 'dcr-muted'}, TEXT.sourceUnavailable + (copyNullableString(source.reason) || 'source.status=' + String(source.status || 'unknown')))
);
}
var highlight = isRecord(source.highlight) ? source.highlight : {line_start: source.line_start, line_end: source.line_end};
var highlightStart = toInteger(highlight.line_start);
var highlightEnd = toInteger(highlight.line_end);
return el('section', {className: 'dcr-section', 'data-code-view': 'source'},
header,
el('p', {className: 'dcr-meta'}, '证据区间 字节 ' + numberText(source.byte_start) + '–' + numberText(source.byte_end) + ' · sha256 ' + shortDigest(source.sha256)),
el('div', {className: 'dcr-code', role: 'list', 'aria-label': '源码 ' + String(source.path || '')}, lines.map(function (line, index) {
var lineNumber = isRecord(line) ? toInteger(line.n) : null;
var lineText = isRecord(line) && typeof line.text === 'string' ? line.text : '';
var highlighted = lineNumber !== null && highlightStart !== null && highlightEnd !== null && lineNumber >= highlightStart && lineNumber <= highlightEnd;
var lineProps = {key: index, className: 'dcr-line' + (highlighted ? ' dcr-line-hit' : ''), role: 'listitem'};
if (lineNumber !== null) lineProps['data-line'] = String(lineNumber);
if (highlighted) lineProps['data-highlight'] = 'true';
return el('div', lineProps,
el('span', {className: 'dcr-line-no', 'aria-hidden': 'true'}, lineNumber === null ? '' : String(lineNumber)),
el('span', {className: 'dcr-line-text'}, lineText)
);
}))
);
}

function EdgeList(props) {
var edges = Array.isArray(props.edges) ? props.edges : [];
var heading = String(props.title) + '（' + String(edges.length) + '）' + (props.truncated === true ? ' 已截断' : '');
return el('section', {className: 'dcr-section'},
el('h3', {className: 'dcr-heading'}, heading),
edges.length === 0
? el('p', {className: 'dcr-muted'}, String(props.emptyText || ''))
: el('ul', {className: 'dcr-edges', 'aria-label': props.title}, edges.map(function (edge, index) {
if (!isRecord(edge)) return null;
var certainty = normalizeEdgeCertainty(edge.certainty);
var callsite = isRecord(edge.callsite) ? edge.callsite : {};
var neighbor = isRecord(edge.target) ? edge.target : (isRecord(edge.source) ? edge.source : {});
var evidenceIds = Array.isArray(edge.evidence_ids) ? edge.evidence_ids : [];
var limitations = Array.isArray(edge.limitations) ? edge.limitations : [];
return el('li', {
key: copyNullableString(edge.edge_id) || 'edge-' + String(index),
className: 'dcr-edge',
'data-callsite-id': copyNullableString(edge.callsite_id) || undefined,
},
el(EvidenceBadge, {value: certainty}),
' ',
el('span', {className: 'dcr-chip'}, '确定性 ' + certainty),
' ',
el('span', {className: 'dcr-chip'}, '来源 ' + String(edge.origin || 'unknown')),
' ',
el('span', {className: 'dcr-meta'}, '调用点 ' + formatLocation(callsite.file, callsite.line) + (copyNullableString(callsite.expression) !== null ? ' · ' + String(callsite.expression) : '')),
' ',
el('span', {className: 'dcr-meta'}, '目标 ' + String(neighbor.name || neighbor.display_name || '未知') + (copyNullableString(neighbor.file) !== null ? '（' + formatLocation(neighbor.file, neighbor.line) + '）' : '')),
' ',
el('span', {className: 'dcr-meta'}, '证据 ' + (evidenceIds.length > 0 ? evidenceIds.join('、') : '无')),
limitations.length > 0 ? el('span', {className: 'dcr-muted'}, ' 限制 ' + limitations.join('、')) : null
);
}))
);
}

function ResourceSection(props) {
var resources = props.resources;
if (!isRecord(resources)) return null;
var status = copyNullableString(resources.status) || 'unavailable';
var reason = copyNullableString(resources.reason) || '';
var objects = Array.isArray(resources.objects) ? resources.objects : [];
var accesses = Array.isArray(resources.field_accesses) ? resources.field_accesses : [];
var header = el('div', {className: 'dcr-section-head'},
el('h3', {className: 'dcr-heading'}, TEXT.resourcesTitle),
el('span', {className: 'dcr-chip'}, '状态 ' + status),
resources.truncated === true ? el('span', {className: 'dcr-chip'}, '已截断') : null
);
if (status === 'unavailable') {
return el('section', {className: 'dcr-section', 'data-code-view': 'resources'},
header,
el('p', {className: 'dcr-muted'}, TEXT.resourcesUnavailable + (reason || '快照未提供 objects/field_accesses 资源层。') + '（已写入缺口区）'),
el('p', {className: 'dcr-muted'}, TEXT.resourcesNote)
);
}
return el('section', {className: 'dcr-section', 'data-code-view': 'resources'},
header,
reason !== '' ? el('p', {className: 'dcr-muted'}, '说明：' + reason) : null,
objects.length > 0
? el('div', {className: 'dcr-resource-objects'},
el('h4', {className: 'dcr-subheading'}, '对象（' + String(objects.length) + '）'),
el('ul', {className: 'dcr-list', 'aria-label': '资源对象'}, objects.map(function (object, index) {
if (!isRecord(object)) return null;
var resourceId = copyNullableString(object.resource_id) || 'resource-' + String(index);
return el('li', {key: resourceId, className: 'dcr-resource', 'data-resource-id': resourceId},
el('span', {className: 'dcr-resource-name'}, String(object.name || '（未命名）')),
' ',
el('span', {className: 'dcr-meta'}, '类型 ' + String(object.type || '—') + ' · 存储 ' + String(object.storage || '—')),
' ',
el('span', {className: 'dcr-meta'}, '位置 ' + formatLocation(object.file, object.line))
);
}))
)
: null,
accesses.length > 0
? el('div', {className: 'dcr-resource-accesses'},
el('h4', {className: 'dcr-subheading'}, '字段访问（' + String(accesses.length) + '）'),
el('ul', {className: 'dcr-list', 'aria-label': '字段访问'}, accesses.map(function (access, index) {
if (!isRecord(access)) return null;
var accessValue = normalizeAccess(access.access);
var certainty = normalizeCertainty(access.certainty);
var owner = isRecord(access.owner) ? access.owner : {};
var location = isRecord(access.location) ? access.location : {};
var objectNames = Array.isArray(access.object_names) ? access.object_names : [];
var evidenceIds = Array.isArray(access.evidence_ids) ? access.evidence_ids : [];
var limitations = Array.isArray(access.limitations) ? access.limitations : [];
var accessId = copyNullableString(access.access_id) || 'field-access-' + String(index);
var fieldName = copyNullableString(access.field_name) || '';
var expression = copyNullableString(access.expression) || '';
return el('li', {
key: accessId,
className: 'dcr-field-access',
'data-field-access': accessId,
'data-access': accessValue,
'data-certainty': certainty,
},
el(EvidenceBadge, {value: certainty}),
' ',
el('span', {className: 'dcr-chip'}, '方向 ' + accessLabel(accessValue) + '（' + accessValue + '）'),
' ',
el('span', {className: 'dcr-meta'}, 'owner ' + String(owner.name || '未知') + (copyNullableString(owner.file) !== null ? '（' + formatLocation(owner.file, owner.line) + '）' : '')),
' ',
el('span', {className: 'dcr-meta'}, '位置 ' + formatLocation(location.file, location.line)),
' ',
el('span', {className: 'dcr-meta'}, '字段 ' + (fieldName || '—') + (expression !== '' ? '（' + expression + '）' : '')),
objectNames.length > 0 ? el('span', {className: 'dcr-meta'}, '对象 ' + objectNames.join('、')) : null,
evidenceIds.length > 0 ? el('span', {className: 'dcr-meta'}, '证据 ' + evidenceIds.join('、')) : null,
limitations.length > 0 ? el('span', {className: 'dcr-muted'}, ' 限制 ' + limitations.join('、')) : null
);
}))
)
: null,
objects.length === 0 && accesses.length === 0
? el('p', {className: 'dcr-muted'}, TEXT.resourcesEmpty)
: null
);
}

function EvidenceList(props) {
var evidence = Array.isArray(props.evidence) ? props.evidence : [];
return el('section', {className: 'dcr-section'},
el('h3', {className: 'dcr-heading'}, TEXT.evidenceTitle + '（' + String(evidence.length) + '）'),
evidence.length === 0
? el('p', {className: 'dcr-muted'}, TEXT.evidenceEmpty)
: el('ul', {className: 'dcr-list', 'aria-label': TEXT.evidenceTitle}, evidence.map(function (item, index) {
if (!isRecord(item)) return null;
var evidenceId = copyNullableString(item.evidence_id) || 'evidence-' + String(index);
return el('li', {
key: evidenceId,
className: 'dcr-evidence-row',
'data-evidence-id': evidenceId,
},
el('span', {className: 'dcr-error-code'}, evidenceId),
' ',
el('span', {className: 'dcr-chip'}, String(item.kind || 'unknown')),
' ',
el('span', {className: 'dcr-meta'}, formatLocation(item.file, item.line)),
' ',
el('span', {className: 'dcr-meta'}, typeof item.text === 'string' ? item.text : ''),
item.truncated === true ? el('span', {className: 'dcr-chip'}, '已截断') : null
);
}))
);
}

function GapList(props) {
var gaps = Array.isArray(props.gaps) ? props.gaps : [];
return el('section', {className: 'dcr-section'},
el('h3', {className: 'dcr-heading'}, TEXT.gapsTitle + '（' + String(gaps.length) + '）'),
el('div', {'data-code-view': 'gaps', className: 'dcr-gaps'},
gaps.length === 0
? el('p', {className: 'dcr-muted'}, TEXT.gapsEmpty)
: gaps.map(function (gap, index) {
return el('div', {key: gap.code + '-' + String(index), className: 'dcr-gap', 'data-gap-code': gap.code},
el('span', {className: 'dcr-gap-code'}, gap.code),
' ',
el('span', {className: 'dcr-chip'}, '状态 ' + gap.status),
' ',
el('span', {className: 'dcr-gap-reason'}, gap.reason || '（无原因文本）')
);
})
)
);
}

function SelectionBlock(props) {
return el('section', {className: 'dcr-section'},
el('h3', {className: 'dcr-heading'}, TEXT.selectionTitle),
el('p', {className: 'dcr-muted'}, TEXT.linksHint),
el('pre', {className: 'dcr-selection', 'data-code-view': 'selection', 'aria-label': '共享选择 Selection JSON'}, JSON.stringify(props.selection, null, 2))
);
}

function FiveViewPlaceholders() {
return el('section', {className: 'dcr-section'},
el('h3', {className: 'dcr-heading'}, TEXT.viewsTitle),
el('p', {className: 'dcr-muted'}, TEXT.viewsHint),
el('div', {className: 'dcr-views'}, FIVE_VIEWS.map(function (view) {
return el('div', {
key: view.key,
className: 'dcr-view',
'data-view': view.key,
'data-state': 'not_available_in_readonly_slice',
},
el('h4', {className: 'dcr-view-title'}, view.title + '（not_available_in_readonly_slice）'),
el('p', {className: 'dcr-muted'}, view.reason)
);
}))
);
}

// ---------------------------------------------------------------------------
// module-level remembered selection (survives panel unmount/re-open)
// ---------------------------------------------------------------------------

var remembered = {
snapshot: null,
entry: null,
entryName: null,
};

function rememberSnapshot(row) {
remembered.snapshot = {
workspace_id: copyNullableString(row.workspace_id),
variant_id: copyNullableString(row.variant_id),
snapshot_id: copyNullableString(row.snapshot_id),
repo_id: copyNullableString(row.repo_id),
};
}

function clearRememberedEntry() {
remembered.entry = null;
remembered.entryName = null;
}

// ---------------------------------------------------------------------------
// RPC adapter: rc.5 connection.rpc.call(channel, endpoint, payload, signal)
// -> {ok:true,value} | {ok:false,error:{code,message}} | transport rejection
// ---------------------------------------------------------------------------

function normalizeRpcResult(result) {
if (!isRecord(result)) {
return {kind: 'error', code: 'PROTOCOL_ERROR', message: '代码工作台返回了无法识别的响应。'};
}
if (result.ok === true) {
if (!isRecord(result.value)) {
return {kind: 'error', code: 'PROTOCOL_ERROR', message: '代码工作台返回的数据格式无效。'};
}
var value = result.value;
/* The Host passes engine CLI JSON through verbatim. Engine failures are a
success envelope whose value is {schema_version, error:{code,message}, ...}. */
var engineFailure = isRecord(value.error) && typeof value.error.code === 'string' && value.error.code.length > 0;
if (value.ok === false || (value.ok === undefined && engineFailure)) {
var engineError = isRecord(value.error) ? value.error : {};
return {
kind: 'error',
code: safeCode(engineError.code),
message: safeMessage(engineError.message) || '引擎未能完成该请求。',
};
}
return {kind: 'ok', value: value};
}
if (result.ok === false) {
var error = isRecord(result.error) ? result.error : {};
return {
kind: 'error',
code: safeCode(error.code),
message: safeMessage(error.message) || '请求失败。',
};
}
return {kind: 'error', code: 'PROTOCOL_ERROR', message: '代码工作台返回了无法识别的响应。'};
}

function callCodeView(connection, endpoint, payload, signal) {
if (!isRecord(connection) || !isRecord(connection.rpc) || typeof connection.rpc.call !== 'function') {
return Promise.resolve({kind: 'error', code: 'BRIDGE_UNAVAILABLE', message: '客户端连接服务不可用，无法访问代码工作台。'});
}
var pending;
try {
pending = connection.rpc.call(CHANNEL, endpoint, payload, signal);
} catch (error) {
return Promise.resolve({kind: 'error', code: 'TRANSPORT_FAILURE', message: safeMessage(error && error.message) || '无法连接代码工作台服务。'});
}
return Promise.resolve(pending).then(function (result) {
if (signal && signal.aborted) return {kind: 'aborted'};
return normalizeRpcResult(result);
}, function (error) {
if (signal && signal.aborted) return {kind: 'aborted'};
if (error && error.name === 'AbortError') return {kind: 'aborted'};
return {kind: 'error', code: 'TRANSPORT_FAILURE', message: safeMessage(error && error.message) || '无法连接代码工作台服务。'};
});
}

// ---------------------------------------------------------------------------
// the only hook-bearing component
// ---------------------------------------------------------------------------

function createInitialView() {
return {
phase: 'loading',
status: null,
statusError: null,
snapshots: null,
snapshotGaps: [],
snapshotWorkspaces: 0,
snapshotsError: null,
snapshot: null,
entries: null,
entriesData: null,
entriesSelection: null,
entriesGaps: [],
entriesLoading: false,
entriesError: null,
selectedEntryId: null,
entryData: null,
entryDetail: null,
entrySelection: null,
entryLoading: false,
entryError: null,
actionError: null,
notice: '',
};
}

function CodeReaderPanel(props) {
var ctx = props.ctx;
var statePair = useState(createInitialView);
var view = statePair[0];
var setView = statePair[1];
var viewRef = useRef(view);
viewRef.current = view;
var flowRef = useRef({seq: 0, controller: null});

function apply(patch) {
setView(function (previous) {
return assign({}, previous, typeof patch === 'function' ? patch(previous) : patch);
});
}

function startRequest() {
var flow = flowRef.current;
flow.seq += 1;
if (flow.controller !== null) {
try {
flow.controller.abort();
} catch (error) {
}
}
var controller = typeof AbortController === 'function' ? new AbortController() : null;
flow.controller = controller;
return {
seq: flow.seq,
controller: controller,
signal: controller !== null ? controller.signal : undefined,
};
}

function isCurrent(token) {
var flow = flowRef.current;
if (flow.seq !== token.seq) return false;
if (token.controller !== null && token.controller.signal.aborted) return false;
return true;
}

function request(endpoint, payload, signal) {
return callCodeView(ctx ? ctx.connection : null, endpoint, payload, signal);
}

function handleSnapshots(statusData, statusError, result) {
var engineGap = hasEngineGap(statusData);
if (result.kind === 'error') {
apply({
snapshots: null,
snapshotGaps: [],
snapshotWorkspaces: 0,
snapshotsError: result,
phase: engineGap ? 'ready' : 'error',
notice: engineGap ? '引擎或引导文件不可用：面板保留并显示缺口，快照列表无法读取。' : '',
});
return;
}
var payload = result.value;
var rows = flattenSnapshots(payload);
var gaps = Array.isArray(payload.gaps) ? payload.gaps : [];
var workspaceCount = Array.isArray(payload.workspaces) ? payload.workspaces.length : 0;
apply({
snapshots: rows,
snapshotGaps: gaps,
snapshotWorkspaces: workspaceCount,
snapshotsError: null,
phase: statusError !== null && !engineGap ? 'error' : 'ready',
});
if (remembered.snapshot !== null) {
var restored = findSnapshotRow(rows, remembered.snapshot.snapshot_id);
if (restored === null || restored.status !== 'verified') {
clearRememberedEntry();
apply({notice: restored === null ? '上次选择的快照已不可用，已回到快照列表。' : '上次选择的快照当前未核验通过，未自动恢复；请选择可用快照。'});
} else {
chooseSnapshot(restored, {remember: false, restoreEntry: true});
}
}
}

function openPanel() {
var token = startRequest();
apply({
phase: 'loading',
status: null,
statusError: null,
snapshots: null,
snapshotGaps: [],
snapshotWorkspaces: 0,
snapshotsError: null,
snapshot: null,
entries: null,
entriesData: null,
entriesSelection: null,
entriesGaps: [],
entriesLoading: false,
entriesError: null,
selectedEntryId: null,
entryData: null,
entryDetail: null,
entrySelection: null,
entryLoading: false,
entryError: null,
actionError: null,
notice: '',
});
request('view.status', {}, token.signal).then(function (statusResult) {
if (!isCurrent(token)) return;
var status = statusResult.kind === 'ok' ? statusResult.value : null;
var statusError = statusResult.kind === 'error' ? statusResult : null;
apply({status: status, statusError: statusError});
request('view.listSnapshots', {}, token.signal).then(function (snapshotsResult) {
if (!isCurrent(token)) return;
handleSnapshots(status, statusError, snapshotsResult);
});
});
}

function chooseSnapshot(row, options) {
if (!isRecord(row) || copyNullableString(row.snapshot_id) === null) return;
var opts = options || {};
if (opts.remember !== false) clearRememberedEntry();
rememberSnapshot(row);
var token = startRequest();
apply({
snapshot: row,
entries: null,
entriesData: null,
entriesSelection: null,
entriesGaps: [],
entriesLoading: true,
entriesError: null,
selectedEntryId: null,
entryData: null,
entryDetail: null,
entrySelection: null,
entryLoading: false,
entryError: null,
notice: '',
phase: 'ready',
});
request('view.listEntries', {workspace: row.workspace_id, snapshot: row.snapshot_id}, token.signal).then(function (result) {
if (!isCurrent(token)) return;
if (result.kind === 'error') {
apply({entriesLoading: false, entriesError: result});
return;
}
var payload = result.value;
var entries = normalizeEntries(payload);
apply({
entriesLoading: false,
entries: entries,
entriesData: payload,
entriesSelection: isRecord(payload.selection) ? payload.selection : null,
entriesGaps: Array.isArray(payload.gaps) ? payload.gaps : [],
entriesError: null,
});
if (opts.restoreEntry === true && remembered.entry !== null) {
var restored = findEntryRow(entries, remembered.entry);
if (restored === null) {
clearRememberedEntry();
apply({notice: '上次选择的入口不在当前入口列表中，已清除。'});
} else {
chooseEntry(restored, {remember: false});
}
}
});
}

function chooseEntry(row, options) {
var current = viewRef.current;
var snapshot = current.snapshot;
if (snapshot === null || !isRecord(row)) return;
var entryId = copyNullableString(row.entry_id);
if (entryId === null) return;
var opts = options || {};
if (opts.remember !== false) {
remembered.entry = entryId;
remembered.entryName = copyNullableString(row.name) || copyNullableString(row.display_name);
}
var token = startRequest();
apply({
selectedEntryId: entryId,
entryData: null,
entryDetail: null,
entrySelection: null,
entryLoading: true,
entryError: null,
notice: '',
});
request('view.getEntry', {workspace: snapshot.workspace_id, snapshot: snapshot.snapshot_id, entry: entryId}, token.signal).then(function (result) {
if (!isCurrent(token)) return;
if (result.kind === 'error') {
apply({entryLoading: false, entryError: result});
return;
}
var payload = result.value;
var detail = isRecord(payload.entry) ? payload.entry : null;
if (detail === null) {
apply({
entryLoading: false,
entryData: payload,
entryError: {kind: 'error', code: 'PROTOCOL_ERROR', message: 'view.getEntry 响应缺少 entry 字段。'},
});
return;
}
var name = copyNullableString(detail.name);
if (name !== null) remembered.entryName = name;
apply({
entryLoading: false,
entryData: payload,
entryDetail: detail,
entrySelection: isRecord(payload.selection) ? payload.selection : null,
entryError: null,
});
});
}

function handleSelectSnapshot(row) {
chooseSnapshot(row, {remember: true, restoreEntry: false});
}

function handleSelectEntry(row) {
chooseEntry(row, {remember: true});
}

function handleReturnToChat() {
try {
ctx.layout.selectPanel(null);
apply({notice: '已返回聊天。'});
} catch (error) {
apply({actionError: {kind: 'error', code: 'LAYOUT_UNAVAILABLE', message: safeMessage(error && error.message) || '无法返回聊天。'}});
}
}

function handleRefresh() {
openPanel();
}

useEffect(function () {
openPanel();
return function () {
var flow = flowRef.current;
flow.seq += 1;
if (flow.controller !== null) {
try {
flow.controller.abort();
} catch (error) {
}
flow.controller = null;
}
};
}, []);

var gaps = collectGaps(view);
var selection = buildSelection(view);
var errors = collectErrors(view);
var state = computeState(view);
var resources = isRecord(view.entryData) && isRecord(view.entryData.resources) ? view.entryData.resources : null;
var source = isRecord(view.entryData) && isRecord(view.entryData.source) ? view.entryData.source : null;
var calls = isRecord(view.entryData) && Array.isArray(view.entryData.calls) ? view.entryData.calls : [];
var callers = isRecord(view.entryData) && Array.isArray(view.entryData.callers) ? view.entryData.callers : [];
var evidence = isRecord(view.entryData) && Array.isArray(view.entryData.evidence) ? view.entryData.evidence : [];
var entryTruncated = isRecord(view.entryData) && view.entryData.truncated === true;

return el('div', {
className: 'dcr-root',
'data-code-view': 'panel',
lang: 'zh-CN',
role: 'region',
'aria-label': PANEL_LABEL,
},
el('header', {className: 'dcr-header'},
el('div', {className: 'dcr-brand'},
el(CodeReaderIcon, {size: 22}),
el('div', {className: 'dcr-brand-text'},
el('h1', {className: 'dcr-title'}, PANEL_LABEL),
el('p', {className: 'dcr-meta'}, TEXT.subtitle)
)
),
el('div', {className: 'dcr-header-actions'},
el('button', {type: 'button', className: 'dcr-btn dcr-btn-primary', onClick: handleReturnToChat}, TEXT.returnChat),
el('button', {type: 'button', className: 'dcr-btn', onClick: handleRefresh, disabled: state === 'loading'}, TEXT.refresh)
)
),
el(StatusBar, {state: state, text: statusMessage(view, state, gaps.length, errors), gapCount: gaps.length}),
view.notice !== '' ? el('p', {className: 'dcr-notice', role: 'note'}, view.notice) : null,
el(ErrorSection, {errors: errors}),
el('div', {className: 'dcr-layout'},
el('aside', {className: 'dcr-sidebar', 'aria-label': '快照与入口'},
el('section', {className: 'dcr-section'},
el('h2', {className: 'dcr-heading'}, TEXT.snapshotsTitle),
el('p', {className: 'dcr-muted'}, TEXT.snapshotsHint),
el(SnapshotList, {
rows: view.snapshots,
loading: view.snapshots === null && view.snapshotsError === null && view.phase === 'loading',
error: view.snapshotsError,
selectedId: view.snapshot !== null ? view.snapshot.snapshot_id : null,
onSelect: handleSelectSnapshot,
})
),
el('section', {className: 'dcr-section'},
el('h2', {className: 'dcr-heading'}, TEXT.entriesTitle),
el('p', {className: 'dcr-muted'}, TEXT.entriesHint),
el(EntryList, {
rows: view.entries,
loading: view.entriesLoading,
error: view.entriesError,
selectedEntryId: view.selectedEntryId,
onSelect: handleSelectEntry,
})
)
),
el('div', {className: 'dcr-main'},
el(EntryDetailView, {view: view}),
view.entryDetail !== null ? el(SourceView, {source: source}) : null,
view.entryDetail !== null ? el(EdgeList, {title: TEXT.callsTitle, edges: calls, emptyText: TEXT.callsEmpty, truncated: entryTruncated}) : null,
view.entryDetail !== null ? el(EdgeList, {title: TEXT.callersTitle, edges: callers, emptyText: TEXT.callersEmpty, truncated: entryTruncated}) : null,
view.entryDetail !== null ? el(ResourceSection, {resources: resources}) : null,
view.entryDetail !== null ? el(EvidenceList, {evidence: evidence}) : null,
el(GapList, {gaps: gaps}),
el(SelectionBlock, {selection: selection}),
el(FiveViewPlaceholders, {})
)
)
);
}

// ---------------------------------------------------------------------------
// plugin body
// ---------------------------------------------------------------------------

function apply(ctx) {
var styleNode = ensureStyle();
ctx.effect(function () {
return function () {
removeStyle(styleNode);
};
}, 'dsh-code-reader: scoped styles');

ctx.effect(function () {
return ctx.slots.inject('main', function () {
return ctx.slots.register({name: 'main', key: PANEL_KEY}, function CodeReaderMainSlot() {
return el(CodeReaderPanel, {ctx: ctx});
});
});
}, 'dsh-code-reader: main panel');

ctx.effect(function () {
return ctx.slots.inject('sidebar.panellist', function () {
return ctx.slots.register({
name: 'sidebar.panellist',
id: PANEL_KEY,
order: 30,
label: function () { return PANEL_LABEL; },
}, CodeReaderIcon);
});
}, 'dsh-code-reader: sidebar entry');
}

ensureStyle();

module.exports = {
name: PLUGIN_NAME,
inject: ['slots', 'layout', 'connection'],
apply: apply,
};
return module.exports;
},
});
