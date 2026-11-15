
window.__ModuleLoader__.load({
id:'@local/dsh-code-reader',
factory:function(require){
'use strict';
var module={exports:{}};
var exports=module.exports;
var React=require('react');
var createElement=React.createElement;
var Fragment=React.Fragment;
var useState=React.useState;
var useEffect=React.useEffect;
var useRef=React.useRef;
var el=createElement;
var assign=Object.assign;
var PLUGIN_NAME='dsh-code-reader';
var PLUGIN_ID='@local/dsh-code-reader';
var PANEL_KEY='dsh-code-reader';
var PANEL_LABEL='代码工作台';
var CHANNEL='/code-view';
var STYLE_ATTRIBUTE='data-code-view-style';
var MAX_ROWS=2000;
var MAX_TREE_NODES=500;
var MAX_GRAPH_NODES=240;
var MAX_MESSAGES=200;
var MAX_FILE_LINES=2000;
var VIEW_KEYS=['coupling','tree','end_to_end','sequence','file'];
var VIEW_LABELS={
coupling:'资源关系图',
tree:'文字树',
end_to_end:'端到端图',
sequence:'时序图',
file:'文件视图',
};
var VIEW_ENDPOINTS={
coupling:'view.coupling',
tree:'view.tree',
end_to_end:'view.endToEnd',
sequence:'view.sequence',
};
var NEEDS_ENTRY={coupling:false,tree:true,end_to_end:true,sequence:true,file:false};
var CONTROL_CHARS=/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
var SAFE_CODE=/^[A-Za-z][A-Za-z0-9_.:\/-]{0,63}$/;
var EVIDENCE_CLASSES=['exact','may','unknown','observed','source_text'];
var CERTAINTY_CLASSES=['exact','may','unknown'];
var ACCESS_VALUES=['read','write','rmw','init','deinit','alloc','free','acquire','release'];
var SHAPE_VALUES=['ellipse','rect','diamond','rectangle','parallelogram'];
var NODE_KIND_VALUES=['entry','process','decision','exit','external','io'];
var SEQUENCE_KINDS=['call','return','access','external','error'];
var SEQUENCE_MODES=['static','observed'];
var SIM_ROLES=['entry','stub_control','util'];
var MAX_STUB_STEPS=20;
var MAX_STUB_ARGS=8;
var EDGE_KINDS=['call','guard','return','exception','external'];
var EVIDENCE_LABELS={
exact:'静态确定',
may:'候选',
unknown:'未知',
observed:'运行观测',
source_text:'源码证据',
};
var ACCESS_LABELS={
read:'读取',
write:'写入 / 修改',
rmw:'读改写',
init:'初始化',
deinit:'去初始化',
alloc:'分配',
free:'释放',
acquire:'加锁',
release:'解锁',
};
var SHAPE_LABELS={
ellipse:'椭圆端点',
rect:'矩形处理',
diamond:'菱形判断',
rectangle:'矩形',
parallelogram:'平行四边形输入 / 输出',
};
var KIND_LABELS={
call:'调用',
guard:'判断',
return:'返回',
exception:'异常返回',
external:'分析域边界',
access:'资源访问',
};
var INTERFACE_DECOUPLING_LABELS={
independent:'独立接口（可黑盒）',
mixed:'混合职责（有副作用）',
unknown:'解耦度未知',
};
var MAX_GROUPS=50;
var MAX_INTERFACE_CANDIDATES=100;
var TEXT={
subtitle:'只读五视图：快照 → 入口 → 源码 / 资源 / 文件',
returnChat:'返回聊天',
refresh:'重新读取',
loading:'正在读取代码工作台数据…',
readyState:'工作台已就绪',
emptyState:'没有可用的已导入快照',
errorState:'读取失败',
gapState:'存在能力缺口',
scopeTitle:'快照与入口',
snapshotsTitle:'快照',
snapshotsLoading:'正在读取已导入快照…',
snapshotsFailed:'快照列表读取失败（见错误区）。',
snapshotsEmpty:'没有已导入的 Atlas 快照。',
snapshotsEmptyHint:'请先登记 workspace 并导入已核验快照。',
entriesTitle:'入口（入口优先）',
entriesLoading:'正在读取入口列表…',
entriesFailed:'入口列表读取失败（见错误区）。',
entriesPrompt:'选择快照后列出入口。',
entriesEmpty:'该快照没有可列出的函数入口。',
tabsLabel:'工作台视图',
viewLoading:'正在计算该视图…',
viewFailed:'视图读取失败（见错误区）。',
viewEmptyNoEntry:'该视图需要先选择一个入口。',
viewEmptyNoData:'该视图没有可显示的数据。',
viewEmptyNoResources:'该作用域内没有可投影资源。',
viewEmptyNoFiles:'该快照没有可列出的文件。',
entryLoading:'正在读取入口详情…',
entryIncomplete:'入口详情缺少 entry 字段。',
entryFailedHint:'入口读取失败（见错误区）。',
sourceTitle:'源码',
sourceMissing:'入口响应未包含 source 区块。',
sourceUnavailable:'源码不可用：',
callsTitle:'直接调用（本函数调用的目标）',
callersTitle:'被调用（调用本函数的来源）',
callsEmpty:'没有可显示的直接调用边。',
callersEmpty:'没有可显示的调用来源边。',
evidenceTitle:'证据',
evidenceEmpty:'没有可显示的 evidence 条目。',
resourcesTitle:'资源标识',
resourcesUnavailable:'资源层不可用：',
resourcesNote:'保留资源标识与读写事实；不用空列表冒充“无资源”。',
resourcesEmpty:'该状态未投影对象/访问；不断言“无资源”。',
gapsTitle:'缺口与限制',
gapsEmpty:'当前没有识别到缺口。',
selectionTitle:'共享选择（Selection）',
linksHint:'定位：entry_id/symbol_id → file:line → 名称多候选。',
legendTrigger:'颜色图例',
legendTitle:'图例与标记',
legendHint:'颜色/形状/证据分级；继承宿主配色。',
legendEvidence:'证据分级',
legendAccess:'资源访问方向',
legendShapes:'图形形状',
legendBoundary:'边界与异常',
legendAi:'AI 归纳（Agent 写入，只读展示）',
detailsTitle:'详情',
detailsClose:'关闭详情',
detailsHint:'点空白关闭；拖动/平移保留选择。',
aiSummaryGap:'归纳正文由 Agent 经 code_summary 写入；插件不调用模型。',
aiSummaryTitle:'AI 归纳（只读）',
aiSummaryLoading:'正在读取 AI 归纳…',
aiSummaryNotGenerated:'AI 归纳未生成（Agent 可通过 code_summary 写入）',
aiSummaryStale:'基于旧快照，待复核',
aiSummaryGenerator:'generator',
aiSummaryGeneratedAt:'生成于',
aiSummaryFacts:'事实引用',
aiSummaryLabels:'推断标签',
aiSummaryFailed:'AI 归纳读取失败：',
aiSummarySubjectFunction:'函数',
aiSummarySubjectGroup:'组',
aiSummaryEntryTitle:'入口归纳',
aiSummaryEntrySubject:'入口',
groupDetailTitle:'组详情',
summaryTabLabel:'AI 归纳',
railResources:'全局资源',
railStub:'打桩模拟',
railLabel:'工作台左栏',
stubTitle:'打桩模拟（S2a 未提供）',
stubReason:'场景执行/打桩/回退在 CW-T3 后置；S2a 只读。',
stubAction:'选择接口并执行（后置）',
resourceRelated:'与当前入口/选择相关',
resourceOther:'其他全局资源',
viewsHint:'只读投影；组折叠/接口库/AI 归纳/运行观测后置。',
couplingScopeEntry:'作用域：入口邻域',
couplingScopeSnapshot:'作用域：整快照（无入口）',
columnWriters:'左：函数（写者）',
columnResources:'中：全局资源',
columnReaders:'右：函数（读者）',
externalTitle:'外部边界（未解析 callee）',
treeTitle:'入口调用与分支',
treeToggle:'展开 / 折叠',
treeGuard:'条件',
treeReturn:'返回',
treeLimits:'局限',
treeCycle:'递归回引用',
treeExternal:'外部边界',
e2eFit:'适应',
e2eReset:'一键规整',
e2eZoomIn:'放大',
e2eZoomOut:'缩小',
e2eSearch:'搜索节点 / 函数',
e2eLocate:'定位',
e2eHint:'竖排 · 正交折线 · 拖节点/平移/缩放',
e2eCanvasLabel:'端到端图画布，方向键平移',
sequenceHint:'生命线 · 消息分色；点击消息定位源码。',
sequenceWarning:'静态预测：无运行观测，不表示实际执行顺序',
sequenceObserved:'observed=false（静态预测，无运行观测）',
fileTreeTitle:'文件',
fileReadLoading:'正在读取文件…',
fileReadFailed:'文件读取失败（见错误区）。',
fileReadHint:'只列快照涉及文件；只读不写回。',
fileRefOnly:'只返回引用证据（二进制/秘密），无文本。',
fileLineHint:'点击行查看；与函数/资源联动高亮。',
openInFile:'定位源码',
resourceDetailTitle:'资源详情',
functionDetailTitle:'函数详情',
groupSectionTitle:'组折叠（结构归纳）',
groupToggle:'折叠 / 展开组',
groupCollapseAll:'折叠全部组',
groupExpandAll:'展开全部组',
groupEdit:'编辑组名 / 描述',
groupEditSave:'保存修订',
groupEditCancel:'取消修订',
groupRevised:'已修订（结构归纳）',
groupCollapsed:'已折叠',
groupExpanded:'已展开',
groupMembers:'成员',
groupCrossEdges:'跨组边保留原 edge_id / 证据',
groupHint:'组框来自引擎结构归纳（可修订，仅当前会话）；折叠只影响显示，不改调用事实。',
interfaceLibrary:'基础接口库',
interfaceLibraryToggle:'展开 / 收起基础接口库',
interfaceLoading:'正在读取接口候选…',
interfaceFailed:'接口候选读取失败（见错误区）。',
interfaceEmpty:'当前作用域没有接口候选。',
interfaceAdd:'加入接口库',
interfaceRemove:'移出接口库',
interfaceAddHint:'加入后在图与文字树中折叠为黑盒（客户端展示状态，不写快照）。',
interfaceSignature:'签名',
interfaceParameters:'入参',
interfaceReturn:'返回',
interfaceReasons:'候选理由',
interfaceEffects:'副作用',
interfaceGuards:'入参 guard',
interfaceExternal:'外部边界（只读）',
interfaceCallCount:'调用次数',
externalBoundary:'外部边界',
blackboxTitle:'黑盒接口',
blackboxExpand:'展开原有步骤',
blackboxCollapse:'折叠为黑盒',
blackboxHidden:'下游已折叠',
detailsTabsLabel:'详情视图',
detailsTabSource:'源码',
detailsTabSubflow:'子流程图',
detailsTabResources:'资源分析',
subflowTitle:'子流程图',
subflowLoading:'正在计算子流程图…',
subflowFailed:'子流程图读取失败（见错误区）。',
subflowEmpty:'该函数没有可投影的子流程。',
subflowHint:'子流程小图；根 crumb 回主图，中间 crumb 以其为 root。',
subflowRootBadge:'根入口',
breadcrumbLabel:'调用路径',
breadcrumbUnavailable:'没有从根入口到当前函数的已解析调用路径（breadcrumb_unavailable）。',
legendGroups:'组与黑盒',
legendGroupRow:'矩形组框：折叠后成员/内部边隐藏，跨组边接组端口并保留原 edge_id',
legendBlackboxRow:'黑盒接口：显示接口摘要并隐藏下游步骤，可展开恢复',
stubPanelTitle:'打桩模拟（Wasm 隔离执行）',
stubHint:'可信 profile → 有序接口调用 → 隔离 worker 执行 → 只追加运行台账；仅在点击「运行」时执行。',
stubProfileTitle:'模拟 profile',
stubProfilesLoading:'正在读取模拟 profile…',
stubProfilesFailed:'模拟 profile 读取失败（见错误区）。',
stubProfilesEmpty:'未导入模拟 profile：请把 sim-profile.json 与对应 .wasm 放入 bootstrap import_inbox_dir，由 Host 校验/签名后再使用。',
stubNoProfile:'先选择模拟 profile。',
stubStubControl:'边界打桩（stub_control）',
stubRoleEntry:'入口调用',
stubRoleStub:'边界打桩',
stubRoleUtil:'工具接口',
stubBoundaryHint:'该步只设置平台/设备模拟返回值，运行记录 stubbed=true；不触发真实设备。',
stubStepsTitle:'场景步骤',
stubStepInterface:'接口',
stubStepArg:'实参',
stubStepAdd:'新增步骤',
stubStepUp:'上移',
stubStepDown:'下移',
stubStepRemove:'移除',
stubStepLimit:'步骤已达上限（最多 20 步）。',
stubStopOnError:'失败即停止（stop_on_error）',
stubRun:'运行场景',
stubRunBusy:'正在隔离执行…',
stubRunHint:'运行会真实调用隔离 Wasm worker；超时/取消返回 OUTCOME_UNKNOWN 且不落台账。',
stubPreviewHint:'先 scenario.preview 校验并签发 plan，再执行。',
stubRunFailed:'场景执行失败：',
stubRecordsTitle:'运行记录（只追加台账）',
stubRecordsEmpty:'尚未运行；运行成功后在这里显示每步结果、事件与受影响资源。',
stubRecordStatus:'status',
stubRecordResult:'结果',
stubRecordSkipped:'已跳过（stop_on_error）',
stubStubbed:'边界打桩步',
stubEvents:'事件',
stubAffects:'受影响资源',
stubMemoryDigest:'memory',
stubUndo:'回退末尾 N 次（S3b 提供）',
stubUndoGap:'回退末尾 N 次在 S3b 提供；当前保留只读历史。',
stubGeneration:'台账当前代',
stubScenarioId:'scenario',
stubPlan:'plan',
stubGapProfileMissing:'sim_profile_missing',
stubGapRealDevice:'real_device_not_authorized',
stubGapCompiler:'compiler_build_disabled',
stubGapUnknown:'scenario_outcome_unknown',
stubGapRealDeviceReason:'真实设备/内核下发未授权；S3a 只在隔离 Wasm worker 中模拟。',
stubGapCompilerReason:'编译器/构建未启用：不在插件内编译/链接源码。',
stubGapUnknownReason:'运行超时/取消，结果未知且未落台账；可重新运行。',
stubGapUndo:'scenario_undo_deferred',
stubInvalidArg:'实参必须是范围内的整数（min/max）。',
stubSelectInterfaceFirst:'请先为每一步选择接口。',
sequenceModeStatic:'静态预测',
sequenceModeObserved:'运行观测',
sequenceModeLabel:'时序模式',
sequenceObservedGap:'尚未读取运行台账：先在「打桩模拟」运行一次场景，或切到打桩模拟刷新台账。',
sequenceObservedLoading:'正在读取运行台账时序…',
sequenceObservedFailed:'运行观测时序读取失败（见错误区）。',
sequenceObservedEmpty:'没有可用的运行台账记录。',
sequenceObservedTitle:'运行观测（observed）',
sequenceObservedHint:'消息来自模拟运行台账，observed=true；只代表隔离 Wasm 模拟，不等同真实设备/内核行为。',
sequenceScenario:'scenario',
sequenceGeneration:'代次',
sequenceObservedTrue:'observed=true（运行台账）',
legendObserved:'运行观测',
legendObservedRow:'运行观测记录（observed）：来自隔离 Wasm 模拟台账，不代表真实设备行为',
stubUndoTitle:'回退末尾 N 步（前缀重放）',
stubUndoCount:'回退步数 N',
stubUndo:'回退末尾 N 步',
stubUndoBusy:'正在重放前缀…',
stubUndoNoLedger:'暂无可回退台账：先运行一次场景。',
stubUndoImported:'当前台账来自导入轨迹，无法重放，因此不可回退。',
stubUndoFailed:'回退失败：',
stubUndoSuccess:'回退',
stubUndoHint:'回退会重放前缀并逐条核验 memory digest；导入台账不可回退。',
traceTitle:'导入轨迹（inbox 只读台账）',
traceHint:'输入可信 inbox 内的轨迹文件名（仅 A-Za-z0-9._-，不做路径选择/文件上传）。',
traceInputPlaceholder:'trace-bus-send.json',
traceImport:'导入轨迹',
traceImportBusy:'正在导入…',
traceImportFailed:'轨迹导入失败：',
traceImportSuccess:'已导入轨迹台账：',
traceImportInvalid:'文件名只能是 inbox 内的普通文件名（A-Za-z0-9._-，≤256）。',
sequenceScenarioLabel:'台账场景',
sequenceImportedBadge:'imported · ',
sequenceAsyncChip:'异步',
sequenceAsyncNote:'异步：由中断/完成事件触发，仍来自已执行或导入的台账',
sequenceScenarioNoLedger:'暂无运行台账可切换。',
};
function isRecord(value){
return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
function toInteger(value){
return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
}
function toSignedInteger(value){
return typeof value==='number'&&Number.isSafeInteger(value)?value:null;
}
function toBoundedInteger(value){
return typeof value==='number'&&Number.isSafeInteger(value)&&Math.abs(value)<=2147483647?value:null;
}
function numberText(value){
var number=toInteger(value);
return number===null?'—':String(number);
}
function copyNullableString(value){
return typeof value==='string'&&value.length>0?value:null;
}
function copyStringArray(value,limit){
var max=typeof limit==='number'?limit:256;
var result=[];
if(!Array.isArray(value))return result;
for(var index=0;index<value.length&&index<max;index+=1){
if(typeof value[index]==='string'&&value[index].length>0)result.push(value[index]);
}
return result;
}
function cleanText(value,maxLength){
if(typeof value!=='string')return '';
var text=value.replace(CONTROL_CHARS,' ');
if(text.length>maxLength)text=text.slice(0,maxLength)+'…';
return text;
}

function safeMessage(value){
if(typeof value!=='string'||value.length===0)return '';
var lines=value.split(/\r?\n/);
var kept=[];
for(var index=0;index<lines.length&&kept.length<3;index+=1){
var line=lines[index];
if(/^\s*at\s/.test(line))break;
if(/^\s*$/.test(line))continue;
kept.push(line);
}
var text=kept.join(' ');
text=text.replace(/[A-Za-z]:[\\/][^\s"'<>，。；)*]*/g, '[路径已隐藏]');
text = text.replace(/\\\\[^\s"'<>，。；)*]+/g, '[路径已隐藏]');
text = text.replace(/(?:^|\s)(\/(?:home|usr|var|etc|opt|root|tmp|mnt|srv|proc|sys|dev)\/[^\s"'<>，。；)*]*)/g,' [路径已隐藏]');
text=text.replace(/\s+/g,' ').trim();
if(text.length>300)text=text.slice(0,300)+'…';
return text;
}
function safeCode(value){
var code=cleanText(typeof value==='string'?value:'',64).trim();
return SAFE_CODE.test(code)?code:'UNKNOWN_ERROR';
}
function formatLocation(file,line){
var name=copyNullableString(file);
var number=toInteger(line);
if(name!==null&&number!==null)return name+':'+number;
if(name!==null)return name;
return '位置未知';
}
function shortDigest(value){
if(typeof value!=='string'||value.length===0)return '—';
return value.length>12?value.slice(0,12)+'…':value;
}
function statusLabel(status){
if(status==='verified')return '已核验';
if(status==='invalid')return '无效';
return String(status||'未知');
}
function freshnessLabel(freshness){
if(freshness==='fresh')return '最新';
if(freshness==='stale')return '已过期';
return '未知';
}
function normalizeEvidenceClass(value){
return EVIDENCE_CLASSES.indexOf(value)>=0?value:'unknown';
}
function normalizeCertainty(value){
return CERTAINTY_CLASSES.indexOf(value)>=0?value:'unknown';
}
function normalizeEdgeCertainty(value){
if(value==='observed')return 'observed';
return normalizeCertainty(value);
}
function normalizeAccess(value){
return ACCESS_VALUES.indexOf(value)>=0?value:'unknown';
}
function accessLabel(value){
return ACCESS_LABELS[value]||String(value||'未知');
}
function normalizeShape(value){
return SHAPE_VALUES.indexOf(value)>=0?value:'rect';
}
function normalizeNodeKind(value){
return NODE_KIND_VALUES.indexOf(value)>=0?value:'process';
}
function truncateLabel(value,limit){
var text=typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
if(text.length>limit)return text.slice(0,limit)+'…';
return text;
}
function compareByString(left,right){
var a=typeof left==='string'?left:'';
var b=typeof right==='string'?right:'';
if(a===b)return 0;
return a<b?-1:1;
}
function selectionDefaults(){
return{
workspace_id:null,
variant_id:null,
snapshot_id:null,
repo_id:null,
entry_id:null,
symbol_id:null,
callsite_ids:[],
callsite_path:[],
resource_ids:[],
resource_status:'unavailable',
evidence_ids:[],
run_id:null,
event_id:null,
focus_resource_id:null,
focus_callsite_id:null,
group_id:null,
interface_id:null,
subflow_root_id:null,
scenario_id:null,
run_generation:null,
call_id:null,
};
}
function mergeSelectionField(target,source,field){
if(!isRecord(source))return;
if(field==='resource_status'){
var status=copyNullableString(source[field]);
if(status!==null)target[field]=status;
return;
}
if(field==='run_generation'){
var generation=toSignedInteger(source[field]);
if(generation!==null)target[field]=generation;
return;
}
if(field==='run_id'||field==='event_id'||field==='focus_resource_id'||field==='focus_callsite_id'||field==='group_id'||field==='interface_id'||field==='subflow_root_id'||field==='scenario_id'||field==='call_id'){
var scalar=copyNullableString(source[field]);
if(scalar!==null)target[field]=scalar;
return;
}
if(field==='callsite_ids'||field==='callsite_path'||field==='resource_ids'||field==='evidence_ids'){
var list=copyStringArray(source[field],200);
if(list.length>0)target[field]=list;
return;
}
var value=copyNullableString(source[field]);
if(value!==null)target[field]=value;
}
function buildSelection(view,focusResourceId,focusCallsiteId,groupId,interfaceId,subflowRootId,scenarioId,runGeneration,callId){
var selection=selectionDefaults();
var strings=['workspace_id','variant_id','snapshot_id','repo_id','entry_id','symbol_id'];
var arrays=['callsite_ids','callsite_path','resource_ids','evidence_ids'];

var viewData=view.data||{};
var dataNames=['coupling','tree','end_to_end','sequence'];
for(var d=0;d<dataNames.length;d+=1){
var payloadEntry=viewData[dataNames[d]];
if(payloadEntry&&isRecord(payloadEntry.payload)&&isRecord(payloadEntry.payload.selection)){
mergeSelectionField(selection,payloadEntry.payload.selection,'entry_id');
mergeSelectionField(selection,payloadEntry.payload.selection,'symbol_id');
mergeSelectionField(selection,payloadEntry.payload.selection,'workspace_id');
mergeSelectionField(selection,payloadEntry.payload.selection,'variant_id');
mergeSelectionField(selection,payloadEntry.payload.selection,'snapshot_id');
mergeSelectionField(selection,payloadEntry.payload.selection,'repo_id');
mergeSelectionField(selection,payloadEntry.payload.selection,'resource_ids');
mergeSelectionField(selection,payloadEntry.payload.selection,'resource_status');
mergeSelectionField(selection,payloadEntry.payload.selection,'evidence_ids');
}
}
var sources=[view.entriesSelection,view.entrySelection];
for(var s=0;s<sources.length;s+=1){
if(!isRecord(sources[s]))continue;
for(var i=0;i<strings.length;i+=1)mergeSelectionField(selection,sources[s],strings[i]);
for(var j=0;j<arrays.length;j+=1)mergeSelectionField(selection,sources[s],arrays[j]);
mergeSelectionField(selection,sources[s],'resource_status');
mergeSelectionField(selection,sources[s],'run_id');
mergeSelectionField(selection,sources[s],'event_id');
mergeSelectionField(selection,sources[s],'focus_resource_id');
mergeSelectionField(selection,sources[s],'focus_callsite_id');
}
var snapshot=view.snapshot;
if(snapshot!==null){
if(selection.workspace_id===null)selection.workspace_id=copyNullableString(snapshot.workspace_id);
if(selection.variant_id===null)selection.variant_id=copyNullableString(snapshot.variant_id);
if(selection.snapshot_id===null)selection.snapshot_id=copyNullableString(snapshot.snapshot_id);
if(selection.repo_id===null)selection.repo_id=copyNullableString(snapshot.repo_id);
}
var detail=view.entryDetail;
if(detail!==null){
if(selection.entry_id===null)selection.entry_id=copyNullableString(detail.entry_id);
if(selection.symbol_id===null)selection.symbol_id=copyNullableString(detail.symbol_id);
}
if(selection.evidence_ids.length===0&&isRecord(view.entryData)&&Array.isArray(view.entryData.evidence)){
var evidence=view.entryData.evidence;
for(var e=0;e<evidence.length;e+=1){
if(isRecord(evidence[e])&&copyNullableString(evidence[e].evidence_id)!==null)selection.evidence_ids.push(evidence[e].evidence_id);
}
}
if(copyNullableString(focusResourceId)!==null)selection.focus_resource_id=focusResourceId;
if(copyNullableString(focusCallsiteId)!==null)selection.focus_callsite_id=focusCallsiteId;
if(copyNullableString(groupId)!==null)selection.group_id=groupId;
if(copyNullableString(interfaceId)!==null)selection.interface_id=interfaceId;
if(copyNullableString(subflowRootId)!==null)selection.subflow_root_id=subflowRootId;
if(copyNullableString(scenarioId)!==null)selection.scenario_id=scenarioId;
var generation=toSignedInteger(runGeneration);
if(generation!==null)selection.run_generation=generation;
if(copyNullableString(callId)!==null)selection.call_id=callId;
return selection;
}
function flattenSnapshots(payload){
var workspaces=isRecord(payload)&&Array.isArray(payload.workspaces)?payload.workspaces:[];
var rows=[];
for(var wi=0;wi<workspaces.length&&wi<200;wi+=1){
var workspace=workspaces[wi];
if(!isRecord(workspace))continue;
var snapshots=Array.isArray(workspace.snapshots)?workspace.snapshots:[];
for(var si=0;si<snapshots.length&&si<500;si+=1){
var snap=snapshots[si];
if(!isRecord(snap)||copyNullableString(snap.snapshot_id)===null)continue;
var coverage=isRecord(snap.coverage)?snap.coverage:{};
rows.push({
workspace_id:copyNullableString(workspace.workspace_id),
workspace_revision:toInteger(workspace.revision),
variant_id:copyNullableString(snap.variant_id),
snapshot_id:snap.snapshot_id,
repo_id:copyNullableString(snap.repo_id),
status:copyNullableString(snap.status)||'unknown',
freshness:copyNullableString(snap.freshness)||'unknown',
entry_count:toInteger(snap.entry_count),
failed_count:toInteger(coverage.failed_count),
pending_count:toInteger(coverage.pending_count),
whole_program_complete:coverage.whole_program_complete===true,
error:isRecord(snap.error)?{code:safeCode(snap.error.code),message:safeMessage(snap.error.message)}:null,
});
}
}
return rows;
}
function compareEntries(left,right){
var leftEntry=left.is_entry===true?0:1;
var rightEntry=right.is_entry===true?0:1;
if(leftEntry!==rightEntry)return leftEntry-rightEntry;
var leftFile=copyNullableString(left.file)||'\uffff';
var rightFile=copyNullableString(right.file)||'\uffff';
if(leftFile!==rightFile)return leftFile<rightFile?-1:1;
var leftLine=toInteger(left.line);
var rightLine=toInteger(right.line);
leftLine=leftLine===null?Number.MAX_SAFE_INTEGER:leftLine;
rightLine=rightLine===null?Number.MAX_SAFE_INTEGER:rightLine;
if(leftLine!==rightLine)return leftLine-rightLine;
return compareByString(left.name,right.name);
}
function normalizeEntries(payload){
var list=isRecord(payload)&&Array.isArray(payload.entries)?payload.entries:[];
var rows=[];
for(var index=0;index<list.length&&index<MAX_ROWS;index+=1){
if(isRecord(list[index]))rows.push(list[index]);
}
rows.sort(compareEntries);
return rows;
}
function findSnapshotRow(rows,snapshotId){
if(!Array.isArray(rows)||typeof snapshotId!=='string')return null;
for(var index=0;index<rows.length;index+=1){
if(rows[index].snapshot_id===snapshotId)return rows[index];
}
return null;
}
function findEntryRow(rows,entryId){
if(!Array.isArray(rows)||typeof entryId!=='string')return null;
for(var index=0;index<rows.length;index+=1){
if(rows[index].entry_id===entryId)return rows[index];
}
return null;
}
function hasEngineGap(statusData){
if(!isRecord(statusData))return false;
var engine=isRecord(statusData.engine)?statusData.engine:{};
if(engine.python==='missing')return true;
var bootstrap=isRecord(engine.bootstrap)?engine.bootstrap:null;
if(bootstrap!==null&&bootstrap.exists===false)return true;
var capabilities=isRecord(statusData.capabilities)?statusData.capabilities:{};
if(capabilities.readonly_workbench===false)return true;
return false;
}
function hasObservedEvidence(view){
var sources=[view.entriesSelection,view.entrySelection];
for(var s=0;s<sources.length;s+=1){
if(!isRecord(sources[s]))continue;
if(copyNullableString(sources[s].run_id)!==null||copyNullableString(sources[s].event_id)!==null)return true;
}
var sequence=view.data&&view.data.sequence&&view.data.sequence.payload;
if(isRecord(sequence)&&sequence.observed===true)return true;
if(!isRecord(view.entryData))return false;
var lists=[view.entryData.calls,view.entryData.callers,view.entryData.evidence];
for(var listIndex=0;listIndex<lists.length;listIndex+=1){
var list=lists[listIndex];
if(!Array.isArray(list))continue;
for(var index=0;index<list.length;index+=1){
var row=list[index];
if(!isRecord(row))continue;
if(row.certainty==='observed'||row.origin==='trace'||row.origin==='observed'||row.kind==='observed'||row.kind==='trace')return true;
if(Array.isArray(row.observation_refs)&&row.observation_refs.length>0)return true;
}
}
return false;
}
function collectGaps(view){
var gaps=[];
var serverKeys={};
var codes={};
function normalizeGap(gap){
if(!isRecord(gap))return null;
var code=typeof gap.code==='string'&&gap.code.length>0?cleanText(gap.code,64):'unknown_gap';
return{
code:code,
status:copyNullableString(gap.status)!==null?cleanText(gap.status,64):'unavailable',
reason:typeof gap.reason==='string'?gap.reason:'',
};
}
function push(normalized){
gaps.push(normalized);
codes[normalized.code]=true;
}
function addServer(gap){
var normalized=normalizeGap(gap);
if(normalized===null)return;
var key=normalized.code+'\u0000'+normalized.status+'\u0000'+normalized.reason;
if(serverKeys[key]===true)return;
serverKeys[key]=true;
push(normalized);
}
function addDerived(gap){
var normalized=normalizeGap(gap);
if(normalized===null||codes[normalized.code]===true)return;
push(normalized);
}
function addSpecific(gap){
var normalized=normalizeGap(gap);
if(normalized===null)return;
for(var index=0;index<gaps.length;index+=1){
if(gaps[index].code===normalized.code&&gaps[index].reason===normalized.reason)return;
}
push(normalized);
}
var statusData=view.status;
var servers=[
statusData!==null?statusData.gaps:null,
view.snapshotGaps,
view.entriesGaps,
isRecord(view.entryData)?view.entryData.gaps:null,
isRecord(view.entryData)&&isRecord(view.entryData.resources)?view.entryData.resources.gaps:null,
];
var dataNames=['coupling','tree','end_to_end','sequence'];
for(var d=0;d<dataNames.length;d+=1){
var entry=view.data?view.data[dataNames[d]]:null;
if(entry&&isRecord(entry.payload)&&Array.isArray(entry.payload.gaps))servers.push(entry.payload.gaps);
}
var mainEndToEnd=view.data?view.data.end_to_end:null;
if(mainEndToEnd&&isRecord(mainEndToEnd.payload)&&isRecord(mainEndToEnd.payload.grouping)&&Array.isArray(mainEndToEnd.payload.grouping.gaps)){
servers.push(mainEndToEnd.payload.grouping.gaps);
}
if(view.interfaces&&isRecord(view.interfaces.payload)&&Array.isArray(view.interfaces.payload.gaps))servers.push(view.interfaces.payload.gaps);
if(view.stub&&view.stub.latest&&isRecord(view.stub.latest)&&Array.isArray(view.stub.latest.gaps))servers.push(view.stub.latest.gaps);
var observedSequenceEntry=view.data?view.data.sequence_observed:null;
if(observedSequenceEntry&&isRecord(observedSequenceEntry.payload)&&Array.isArray(observedSequenceEntry.payload.gaps))servers.push(observedSequenceEntry.payload.gaps);
if(view.file){
if(view.file.tree&&isRecord(view.file.tree.payload)&&Array.isArray(view.file.tree.payload.gaps))servers.push(view.file.tree.payload.gaps);
if(view.file.read&&isRecord(view.file.read.payload)&&Array.isArray(view.file.read.payload.gaps))servers.push(view.file.read.payload.gaps);
}
for(var s=0;s<servers.length;s+=1){
if(!Array.isArray(servers[s]))continue;
for(var index=0;index<servers[s].length&&index<200;index+=1)addServer(servers[s][index]);
}
if(isRecord(statusData)){
var engine=isRecord(statusData.engine)?statusData.engine:{};
var capabilities=isRecord(statusData.capabilities)?statusData.capabilities:{};
if(engine.python==='missing'){
addDerived({code:'engine_python_missing',status:'unavailable',reason:'view.status 报告 Python 引擎不可用（engine.python=missing），无法读取真实分析结果。'});
}
var bootstrap=isRecord(engine.bootstrap)?engine.bootstrap:null;
if(bootstrap!==null&&bootstrap.exists===false){
addDerived({code:'bootstrap_missing',status:'unavailable',reason:'引导文件缺失（engine.bootstrap.exists=false），请先在 Host 侧配置 bootstrap 后再打开面板。'});
}
if(capabilities.readonly_workbench===false){
addDerived({code:'readonly_workbench_unavailable',status:'unavailable',reason:'宿主未提供只读工作台能力（capabilities.readonly_workbench=false）。'});
}
}
if(view.snapshots!==null){
var rows=view.snapshots;
var invalidCount=0;
for(var ri=0;ri<rows.length;ri+=1){
var row=rows[ri];
if(row.status==='invalid'){
invalidCount+=1;
if(invalidCount<=8){
addDerived({
code:row.error!==null&&row.error.code!==null?row.error.code:'invalid_snapshot',
status:'invalid',
reason:row.error!==null&&row.error.message!==''?row.error.message:'快照核验未通过（status=invalid），该快照不能作为可信事实来源。',
});
}
}else if(row.freshness==='stale'){
addDerived({code:'snapshot_stale',status:'stale',reason:'快照已过期（freshness=stale），分析结果可能不是最新；请重新导入或核验。'});
}
}
if(view.snapshotWorkspaces===0){
if(codes.workspace!==true)addDerived({code:'no_workspace',status:'unavailable',reason:'没有已登记的 workspace；请先在 Host 侧登记代码仓库。'});
}else if(rows.length===0){
if(codes.snapshot!==true)addDerived({code:'no_snapshot',status:'unavailable',reason:'已登记 workspace 但没有已导入的 Atlas 快照；请先在 Host 侧导入并核验快照。'});
}
}
var detail=view.entryDetail;
if(detail!==null&&(detail.file===null||detail.file===undefined)){
addDerived({code:'entry_location_unresolved',status:'degraded',reason:'入口位置未知：无法映射到已登记仓库根，不会回退为绝对路径。'});
}else if(detail!==null&&toInteger(detail.line)===null){
addDerived({code:'entry_line_unknown',status:'degraded',reason:'入口函数在该快照中没有可用的 evidence 行号。'});
}
if(isRecord(view.entryData)){
var source=view.entryData.source;
if(isRecord(source)&&source.status!=='ok'){
addSpecific({code:'source_unavailable',status:'unavailable',reason:'源码不可读：'+(copyNullableString(source.reason)||'source.status='+String(source.status||'unknown'))});
}
var resources=view.entryData.resources;
if(isRecord(resources)&&resources.status==='unavailable'){
addSpecific({
code:'resource_graph',
status:'unavailable',
reason:copyNullableString(resources.reason)||'快照未提供 objects/field_accesses 资源层，资源标识不可用。',
});
}
}
var observedLedger=observedSequenceEntry!==null&&observedSequenceEntry!==undefined&&observedSequenceEntry.state==='ready';
var stubRecords=view.stub&&view.stub.latest&&isRecord(view.stub.latest)&&Array.isArray(view.stub.latest.records)&&view.stub.latest.records.length>0;
var statusCapabilities=isRecord(statusData)&&isRecord(statusData.capabilities)?statusData.capabilities:{};
if(!hasObservedEvidence(view)&&observedLedger!==true&&stubRecords!==true&&statusCapabilities.run_observation!==true){
addDerived({code:'run_observation',status:'unavailable',reason:'运行观测尚未开启：需先由「打桩模拟」运行场景并写入台账。'});
}
addDerived({code:'ai_summary',status:'unavailable',reason:'归纳正文由 Agent 经 code_summary 写入；插件不调用模型、不伪造正文。'});
return gaps;
}
function computeState(view){
if(view.phase==='loading')return 'loading';
if(view.phase==='error')return 'error';
if(hasEngineGap(view.status))return 'gap';
if(view.snapshots!==null&&view.snapshots.length===0)return 'empty';
return 'ready';
}
function collectErrors(view){
var errors=[];
var candidates=[view.statusError,view.snapshotsError,view.entriesError,view.entryError,view.actionError];
for(var index=0;index<candidates.length;index+=1){
if(candidates[index]!==null&&candidates[index]!==undefined)errors.push(candidates[index]);
}
return errors.slice(0,3);
}
function statusMessage(view,state,gapCount,errors){
if(state==='loading')return TEXT.loading;
if(state==='error'){
var code=errors.length>0?errors[0].code:'UNKNOWN_ERROR';
return TEXT.errorState+'（'+code+'，详见错误区）';
}
if(state==='gap')return TEXT.gapState+'（已识别 '+gapCount+' 项缺口，见缺口区；面板保留可用部分）';
if(state==='empty')return TEXT.emptyState;
var parts=[TEXT.readyState];
if(view.snapshot!==null){
parts.push('快照 '+view.snapshot.snapshot_id+'（'+String(view.snapshot.workspace_id)+' / '+String(view.snapshot.variant_id)+' / '+String(view.snapshot.freshness)+'）');
}
if(view.entries!==null)parts.push('入口 '+String(view.entries.length)+' 个');
if(view.entry!==null)parts.push('当前入口 '+String(view.entry.name||view.entry.entry_id));
return parts.join('；');
}
function normalizeCoupling(payload){
var source=isRecord(payload)?payload:{};
var scope=isRecord(source.scope)?source.scope:{};
var resources=[];
var rawResources=Array.isArray(source.resources)?source.resources:[];
for(var ri=0;ri<rawResources.length&&ri<100;ri+=1){
var resource=rawResources[ri];
if(!isRecord(resource)||copyNullableString(resource.resource_id)===null)continue;
var accesses=[];
var rawAccesses=Array.isArray(resource.accesses)?resource.accesses:[];
for(var ai=0;ai<rawAccesses.length&&ai<400;ai+=1){
var access=rawAccesses[ai];
if(!isRecord(access))continue;
accesses.push({
access_id:copyNullableString(access.access_id),
access:normalizeAccess(access.access),
certainty:normalizeCertainty(access.certainty),
function_id:copyNullableString(access.function_id),
function_name:copyNullableString(access.function_name)||'未知函数',
function_file:copyNullableString(access.function_file),
function_line:toInteger(access.function_line),
location:isRecord(access.location)?{file:copyNullableString(access.location.file),line:toInteger(access.location.line)}:{file:null,line:null},
field_name:copyNullableString(access.field_name)||'',
expression:copyNullableString(access.expression)||'',
evidence_ids:copyStringArray(access.evidence_ids,32),
limitations:copyStringArray(access.limitations,32),
});
}
var fields=[];
if(Array.isArray(resource.fields)){
for(var fi=0;fi<resource.fields.length&&fi<64;fi+=1){
var field=resource.fields[fi];
if(isRecord(field))fields.push({field_id:copyNullableString(field.field_id),field_name:copyNullableString(field.field_name)||'',field_path:copyStringArray(field.field_path,16)});
}
}
resources.push({
resource_id:resource.resource_id,
name:copyNullableString(resource.name)||resource.resource_id,
type:copyNullableString(resource.type)||null,
storage:copyNullableString(resource.storage)||null,
lifetime:copyNullableString(resource.lifetime)||null,
file:copyNullableString(resource.file),
line:toInteger(resource.line),
evidence_ids:copyStringArray(resource.evidence_ids,32),
fields:fields,
write_count:toInteger(resource.write_count),
read_count:toInteger(resource.read_count),
related_function_ids:copyStringArray(resource.related_function_ids,64),
accesses:accesses,
});
}
var functions=[];
var rawFunctions=Array.isArray(source.functions)?source.functions:[];
for(var fni=0;fni<rawFunctions.length&&fni<300;fni+=1){
var fn=rawFunctions[fni];
if(!isRecord(fn)||copyNullableString(fn.function_id)===null)continue;
functions.push({
function_id:fn.function_id,
name:copyNullableString(fn.name)||fn.function_id,
file:copyNullableString(fn.file),
line:toInteger(fn.line),
role:fn.role==='writer'||fn.role==='reader'||fn.role==='both'?fn.role:'reader',
is_entry:fn.is_entry===true,
access_summary:isRecord(fn.access_summary)?fn.access_summary:{},
});
}
var edges=[];
var rawEdges=Array.isArray(source.edges)?source.edges:[];
for(var ei=0;ei<rawEdges.length&&ei<800;ei+=1){
var edge=rawEdges[ei];
if(!isRecord(edge))continue;
edges.push({
edge_id:copyNullableString(edge.edge_id),
from_function:copyNullableString(edge.from_function),
to_resource:copyNullableString(edge.to_resource),
access:normalizeAccess(edge.access),
certainty:normalizeCertainty(edge.certainty),
field_name:copyNullableString(edge.field_name)||'',
location:isRecord(edge.location)?{file:copyNullableString(edge.location.file),line:toInteger(edge.location.line)}:{file:null,line:null},
evidence_ids:copyStringArray(edge.evidence_ids,32),
limitations:copyStringArray(edge.limitations,32),
});
}
var externalNodes=[];
var rawExternal=Array.isArray(source.external_nodes)?source.external_nodes:[];
for(var xi=0;xi<rawExternal.length&&xi<100;xi+=1){
var external=rawExternal[xi];
if(!isRecord(external))continue;
externalNodes.push({
function_id:copyNullableString(external.function_id),
name:copyNullableString(external.name)||'外部边界',
kind:external.kind==='candidate'?'candidate':'external',
callsite_id:copyNullableString(external.callsite_id),
file:copyNullableString(external.file),
line:toInteger(external.line),
certainty:normalizeCertainty(external.certainty),
reason:copyNullableString(external.reason)||'',
});
}
return{
scope:{
mode:scope.mode==='entry_neighborhood'?'entry_neighborhood':'snapshot',
entry_id:copyNullableString(scope.entry_id),
},
resources:resources,
functions:functions,
edges:edges,
external_nodes:externalNodes,
gaps:Array.isArray(source.gaps)?source.gaps:[],
truncated:source.truncated===true,
};
}
function normalizeTree(payload){
var source=isRecord(payload)?payload:{};
var nodes=[];
var rawNodes=Array.isArray(source.nodes)?source.nodes:[];
for(var index=0;index<rawNodes.length&&index<MAX_TREE_NODES;index+=1){
var node=rawNodes[index];
if(!isRecord(node)||copyNullableString(node.node_id)===null)continue;
var symbol=isRecord(node.symbol)?node.symbol:{};
var callsite=isRecord(node.callsite)?node.callsite:null;
var guards=[];
if(Array.isArray(node.guards)){
for(var gi=0;gi<node.guards.length&&gi<16;gi+=1){
var guard=node.guards[gi];
if(isRecord(guard))guards.push({kind:copyNullableString(guard.kind)||'guard',expression:copyNullableString(guard.expression)||''});
}
}
var returns=[];
if(Array.isArray(node.returns)){
for(var rti=0;rti<node.returns.length&&rti<16;rti+=1){
var ret=node.returns[rti];
if(isRecord(ret))returns.push({expression:copyNullableString(ret.expression)||'',certainty:normalizeCertainty(ret.certainty),limitations:copyStringArray(ret.limitations,16)});
}
}
nodes.push({
node_id:node.node_id,
parent_node_id:copyNullableString(node.parent_node_id),
depth:toInteger(node.depth)===null?0:node.depth,
kind:copyNullableString(node.kind)||'call',
symbol:{
function_id:copyNullableString(symbol.function_id),
name:copyNullableString(symbol.name)||'未知符号',
file:copyNullableString(symbol.file),
line:toInteger(symbol.line),
signature:copyNullableString(symbol.signature),
storage:copyNullableString(symbol.storage),
},
callsite:callsite===null?null:{
callsite_id:copyNullableString(callsite.callsite_id),
file:copyNullableString(callsite.file),
line:toInteger(callsite.line),
expression:copyNullableString(callsite.expression),
},
guards:guards,
returns:returns,
children_count:toInteger(node.children_count),
expandable:node.expandable!==false,
cycle:node.cycle===true,
limitations:copyStringArray(node.limitations,32),
});
}
return{
entry:isRecord(source.entry)?{
entry_id:copyNullableString(source.entry.entry_id),
name:copyNullableString(source.entry.name),
file:copyNullableString(source.entry.file),
line:toInteger(source.entry.line),
signature:copyNullableString(source.entry.signature),
}:null,
nodes:nodes,
max_depth:toInteger(source.max_depth),
gaps:Array.isArray(source.gaps)?source.gaps:[],
truncated:source.truncated===true,
};
}
function normalizeEndToEnd(payload){
var source=isRecord(payload)?payload:{};
var nodes=[];
var rawNodes=Array.isArray(source.nodes)?source.nodes:[];
for(var index=0;index<rawNodes.length&&index<MAX_GRAPH_NODES;index+=1){
var node=rawNodes[index];
if(!isRecord(node)||copyNullableString(node.node_id)===null)continue;
nodes.push({
node_id:node.node_id,
kind:normalizeNodeKind(node.kind),
label:copyNullableString(node.label)||node.node_id,
sublabel:copyNullableString(node.sublabel)||'',
file:copyNullableString(node.file),
line:toInteger(node.line),
function_id:copyNullableString(node.function_id),
callsite_id:copyNullableString(node.callsite_id),
shape:normalizeShape(node.shape),
role:node.role==='error'||node.role==='boundary'?node.role:'normal',
certainty:normalizeCertainty(node.certainty),
evidence_ids:copyStringArray(node.evidence_ids,32),
});
}
var edges=[];
var rawEdges=Array.isArray(source.edges)?source.edges:[];
for(var ei=0;ei<rawEdges.length&&ei<480;ei+=1){
var edge=rawEdges[ei];
if(!isRecord(edge))continue;
var style=isRecord(edge.style)?edge.style:{};
var kind=EDGE_KINDS.indexOf(edge.kind)>=0?edge.kind:'call';
var color=style.color==='exception'||kind==='exception'?'exception':'normal';
edges.push({
edge_id:copyNullableString(edge.edge_id)||'edge-'+String(ei),
from:copyNullableString(edge.from),
to:copyNullableString(edge.to),
kind:kind,
label:copyNullableString(edge.label)||'',
certainty:normalizeCertainty(edge.certainty),
origin:copyNullableString(edge.origin)||'unknown',
callsite_id:copyNullableString(edge.callsite_id),
evidence_ids:copyStringArray(edge.evidence_ids,32),
limitations:copyStringArray(edge.limitations,32),
style_line:copyNullableString(style.line)==='dashed'?'dashed':'solid',
style_color:color,
});
}
var exits=[];
if(Array.isArray(source.exits)){
for(var xi=0;xi<source.exits.length&&xi<100;xi+=1){
var exit=source.exits[xi];
if(!isRecord(exit))continue;
exits.push({
node_id:copyNullableString(exit.node_id),
label:copyNullableString(exit.label)||'出口',
expression:copyNullableString(exit.expression)||'',
role:exit.role==='error'?'error':'normal',
certainty:normalizeCertainty(exit.certainty),
});
}
}
var groups=[];
var rawGroups=Array.isArray(source.groups)?source.groups:[];
for(var gni=0;gni<rawGroups.length&&gni<MAX_GROUPS;gni+=1){
var group=rawGroups[gni];
if(!isRecord(group)||copyNullableString(group.group_id)===null)continue;
groups.push({
group_id:group.group_id,
parent_group_id:copyNullableString(group.parent_group_id),
label:copyNullableString(group.label)||group.group_id,
description:copyNullableString(group.description)||'',
member_node_ids:copyStringArray(group.member_node_ids,512),
member_function_ids:copyStringArray(group.member_function_ids,512),
entry_node_ids:copyStringArray(group.entry_node_ids,64),
exit_node_ids:copyStringArray(group.exit_node_ids,64),
collapsed_default:group.collapsed_default===true,
origin:copyNullableString(group.origin)||'structural_heuristic',
evidence_ids:copyStringArray(group.evidence_ids,32),
limitations:copyStringArray(group.limitations,32),
});
}
var grouping=null;
if(isRecord(source.grouping)){
grouping={
algorithm:copyNullableString(source.grouping.algorithm)||'private_callee_subflow',
groups:toInteger(source.grouping.groups),
members:toInteger(source.grouping.members),
gaps:Array.isArray(source.grouping.gaps)?source.grouping.gaps:[],
};
}
var breadcrumb=[];
if(Array.isArray(source.breadcrumb)){
for(var bci=0;bci<source.breadcrumb.length&&bci<20;bci+=1){
var crumb=source.breadcrumb[bci];
if(!isRecord(crumb)||copyNullableString(crumb.function_id)===null)continue;
breadcrumb.push({
function_id:crumb.function_id,
name:copyNullableString(crumb.name)||crumb.function_id,
file:copyNullableString(crumb.file),
line:toInteger(crumb.line),
callsite_id:copyNullableString(crumb.callsite_id),
});
}
}
return{
entry:isRecord(source.entry)?source.entry:null,
root:copyNullableString(source.root),
nodes:nodes,
edges:edges,
exits:exits,
groups:groups,
grouping:grouping,
breadcrumb:breadcrumb,
legend:Array.isArray(source.legend)?source.legend:[],
layout:isRecord(source.layout)?source.layout:{direction:'DOWN',edge_routing:'ORTHOGONAL'},
gaps:Array.isArray(source.gaps)?source.gaps:[],
truncated:source.truncated===true,
};
}
function normalizeInterfaces(payload){
var source=isRecord(payload)?payload:{};
var candidates=[];
var rawCandidates=Array.isArray(source.candidates)?source.candidates:[];
for(var ci=0;ci<rawCandidates.length&&ci<MAX_INTERFACE_CANDIDATES;ci+=1){
var candidate=rawCandidates[ci];
if(!isRecord(candidate)||copyNullableString(candidate.interface_id)===null)continue;
var parameters=[];
if(Array.isArray(candidate.parameters)){
for(var pi=0;pi<candidate.parameters.length&&pi<16;pi+=1){
var parameter=candidate.parameters[pi];
if(isRecord(parameter))parameters.push({name:copyNullableString(parameter.name)||'',type:copyNullableString(parameter.type)||''});
}
}
var callers=[];
if(Array.isArray(candidate.callers)){
for(var cli=0;cli<candidate.callers.length&&cli<32;cli+=1){
var caller=candidate.callers[cli];
if(!isRecord(caller))continue;
callers.push({
function_id:copyNullableString(caller.function_id),
name:copyNullableString(caller.name)||'',
file:copyNullableString(caller.file),
line:toInteger(caller.line),
callsite_id:copyNullableString(caller.callsite_id),
location:isRecord(caller.location)?{file:copyNullableString(caller.location.file),line:toInteger(caller.location.line)}:{file:null,line:null},
});
}
}
var fieldAccesses=[];
if(Array.isArray(candidate.field_accesses)){
for(var fai=0;fai<candidate.field_accesses.length&&fai<64;fai+=1){
var fieldAccess=candidate.field_accesses[fai];
if(!isRecord(fieldAccess))continue;
fieldAccesses.push({
access:normalizeAccess(fieldAccess.access),
field_name:copyNullableString(fieldAccess.field_name)||'',
certainty:normalizeCertainty(fieldAccess.certainty),
location:isRecord(fieldAccess.location)?{file:copyNullableString(fieldAccess.location.file),line:toInteger(fieldAccess.location.line)}:{file:null,line:null},
limitations:copyStringArray(fieldAccess.limitations,16),
});
}
}
var inputGuards=[];
if(Array.isArray(candidate.input_guards)){
for(var ige=0;ige<candidate.input_guards.length&&ige<16;ige+=1){
var guard=candidate.input_guards[ige];
if(!isRecord(guard))continue;
inputGuards.push({
callsite_id:copyNullableString(guard.callsite_id),
file:copyNullableString(guard.file),
line:toInteger(guard.line),
expression:copyNullableString(guard.expression)||'',
});
}
}
var reasons=[];
if(Array.isArray(candidate.reasons)){
for(var rei=0;rei<candidate.reasons.length&&rei<16;rei+=1){
var reason=candidate.reasons[rei];
if(!isRecord(reason))continue;
reasons.push({code:copyNullableString(reason.code)||'reason',label:copyNullableString(reason.label)||''});
}
}
candidates.push({
interface_id:candidate.interface_id,
function_id:copyNullableString(candidate.function_id),
name:copyNullableString(candidate.name)||candidate.interface_id,
file:copyNullableString(candidate.file),
line:toInteger(candidate.line),
signature:copyNullableString(candidate.signature),
parameters:parameters,
return_type:copyNullableString(candidate.return_type),
call_count:toInteger(candidate.call_count),
callers:callers,
leaf:candidate.leaf===true,
cross_file:candidate.cross_file===true,
field_accesses:fieldAccesses,
input_guards:inputGuards,
decoupling:candidate.decoupling==='independent'||candidate.decoupling==='mixed'?candidate.decoupling:'unknown',
reasons:reasons,
score:toInteger(candidate.score),
certainty:normalizeCertainty(candidate.certainty),
evidence_ids:copyStringArray(candidate.evidence_ids,32),
limitations:copyStringArray(candidate.limitations,32),
});
}
var boundaries=[];
if(Array.isArray(source.external_boundaries)){
for(var bi=0;bi<source.external_boundaries.length&&bi<200;bi+=1){
var boundary=source.external_boundaries[bi];
if(!isRecord(boundary))continue;
boundaries.push({
callee:copyNullableString(boundary.callee)||'unknown',
call_count:toInteger(boundary.call_count),
callsite_ids:copyStringArray(boundary.callsite_ids,64),
});
}
}
return{
selection:isRecord(source.selection)?source.selection:null,
candidates:candidates,
external_boundaries:boundaries,
gaps:Array.isArray(source.gaps)?source.gaps:[],
truncated:source.truncated===true,
};
}
function normalizeFileTree(payload){
var source=isRecord(payload)?payload:{};
var repos=[];
var rawRepos=Array.isArray(source.repos)?source.repos:[];
for(var ri=0;ri<rawRepos.length&&ri<64;ri+=1){
var repo=rawRepos[ri];
if(!isRecord(repo))continue;
var files=[];
var rawFiles=Array.isArray(repo.files)?repo.files:[];
for(var fi=0;fi<rawFiles.length&&fi<MAX_ROWS;fi+=1){
var file=rawFiles[fi];
if(!isRecord(file)||copyNullableString(file.path)===null)continue;
files.push({
path:file.path,
bytes:toInteger(file.bytes),
sha256:copyNullableString(file.sha256),
has_evidence:file.has_evidence===true,
});
}
files.sort(function(left,right){return compareByString(left.path,right.path);});
repos.push({
repo_id:copyNullableString(repo.repo_id),
role:copyNullableString(repo.role),
files:files,
truncated:repo.truncated===true,
});
}
return{repos:repos,gaps:Array.isArray(source.gaps)?source.gaps:[]};
}
function normalizeFileRead(payload){
var source=isRecord(payload)?payload:{};
var lines=[];
var rawLines=Array.isArray(source.lines)?source.lines:[];
for(var index=0;index<rawLines.length&&index<MAX_FILE_LINES;index+=1){
var line=rawLines[index];
if(!isRecord(line))continue;
lines.push({n:toInteger(line.n),text:typeof line.text==='string'?line.text:''});
}
return{
repo_id:copyNullableString(source.repo_id),
path:copyNullableString(source.path),
sha256:copyNullableString(source.sha256),
bytes:toInteger(source.bytes),
total_lines:toInteger(source.total_lines),
line_start:toInteger(source.line_start),
line_end:toInteger(source.line_end),
truncated:source.truncated===true,
lines:lines,
evidence_ref:copyNullableString(source.evidence_ref),
gaps:Array.isArray(source.gaps)?source.gaps:[],
reason:copyNullableString(source.reason),
};
}
function normalizeSequence(payload){
var source=isRecord(payload)?payload:{};
var participants=[];
if(Array.isArray(source.participants)){
for(var pi=0;pi<source.participants.length&&pi<32;pi+=1){
var participant=source.participants[pi];
if(!isRecord(participant)||copyNullableString(participant.participant_id)===null)continue;
participants.push({
participant_id:participant.participant_id,
label:copyNullableString(participant.label)||participant.participant_id,
});
}
}
var fallbackFrom=participants.length>0?participants[0].participant_id:'driver';
var fallbackTo=participants.length>0?participants[participants.length-1].participant_id:'driver';
var messages=[];
var rawMessages=Array.isArray(source.messages)?source.messages:[];
for(var mi=0;mi<rawMessages.length&&mi<MAX_MESSAGES;mi+=1){
var message=rawMessages[mi];
if(!isRecord(message))continue;
var kind=SEQUENCE_KINDS.indexOf(message.kind)>=0?message.kind:'call';
var sourceRef=isRecord(message.source_ref)?message.source_ref:null;
messages.push({
message_id:copyNullableString(message.message_id)||'m-'+String(mi),
index:toInteger(message.index)===null?mi+1:message.index,
kind:kind,
from:copyNullableString(message.from)||fallbackFrom,
to:copyNullableString(message.to)||fallbackTo,
label:copyNullableString(message.label)||'',
function_id:copyNullableString(message.function_id),
callsite_id:copyNullableString(message.callsite_id),
entry_id:copyNullableString(message.entry_id),
depth:toInteger(message.depth),
certainty:normalizeCertainty(message.certainty),
evidence_ids:copyStringArray(message.evidence_ids,32),
limitations:copyStringArray(message.limitations,32),
observed:message.observed===true,
imported:message.imported===true,
async:message.async===true,
call_id:copyNullableString(message.call_id),
step_index:toInteger(message.step_index),
stubbed:message.stubbed===true,
status:message.status==='error'?'error':(message.status==='ok'?'ok':null),
result:toSignedInteger(message.result),
event:copyNullableString(message.event),
code:toSignedInteger(message.code),
affected_resources:normalizeAffectedResources(message.affected_resources),
source_ref:sourceRef===null?null:{function_id:copyNullableString(sourceRef.function_id),file:copyNullableString(sourceRef.file),line:toInteger(sourceRef.line)},
});
}
return{
mode:copyNullableString(source.mode)||'static',
observed:source.observed===true,
warning:source.warning===null||source.warning===undefined?(source.observed===true?null:TEXT.sequenceWarning):copyNullableString(source.warning),
scenario:normalizeObservedScenario(source.scenario),
participants:participants,
messages:messages,
gaps:Array.isArray(source.gaps)?source.gaps:[],
async_events:copyStringArray(source.async_events,16),
truncated:source.truncated===true,
limitations:copyStringArray(source.limitations,32),
};
}
function normalizeAffectedResources(value){
var list=[];
if(!Array.isArray(value))return list;
for(var index=0;index<value.length&&index<64;index+=1){
var item=value[index];
if(!isRecord(item)||copyNullableString(item.resource_id)===null)continue;
list.push({resource_id:item.resource_id,name:copyNullableString(item.name)||item.resource_id,access:normalizeAccess(item.access)});
}
return list;
}
function normalizeObservedScenario(value){
if(!isRecord(value))return null;
return{
scenario_id:copyNullableString(value.scenario_id),
generation:toSignedInteger(value.generation),
profile_id:copyNullableString(value.profile_id),
workspace_id:copyNullableString(value.workspace_id),
snapshot_id:copyNullableString(value.snapshot_id),
records_digest:copyNullableString(value.records_digest),
created_at:copyNullableString(value.created_at),
imported:value.imported===true,
label:copyNullableString(value.label),
};
}
function normalizeStubParam(value){
if(!isRecord(value))return null;
var name=copyNullableString(value.name)||'arg';
var type=value.type==='i32'||value.type==='u32'?value.type:'i32';
var min=toSignedInteger(value.min);
var max=toSignedInteger(value.max);
return{name:name,type:type,min:min,max:max};
}
function normalizeStubInterface(value){
if(!isRecord(value))return null;
var name=copyNullableString(value.name);
if(name===null)return null;
var params=[];
if(Array.isArray(value.params)){
for(var index=0;index<value.params.length&&index<MAX_STUB_ARGS;index+=1){
var param=normalizeStubParam(value.params[index]);
if(param!==null)params.push(param);
}
}
return{
name:name,
params:params,
returns:value.returns==='void'?'void':'i32',
role:SIM_ROLES.indexOf(value.role)>=0?value.role:'util',
entry_id:copyNullableString(value.entry_id),
};
}
function normalizeStubProfile(value){
if(!isRecord(value))return null;
var profileId=copyNullableString(value.profile_id);
if(profileId===null)return null;
var binding=isRecord(value.binding)?value.binding:{};
var module=isRecord(value.module)?value.module:{};
var limits=isRecord(value.limits)?value.limits:{};
var interfaces=[];
if(Array.isArray(value.interfaces)){
for(var index=0;index<value.interfaces.length&&index<32;index+=1){
var iface=normalizeStubInterface(value.interfaces[index]);
if(iface!==null)interfaces.push(iface);
}
}
return{
profile_id:profileId,
label:copyNullableString(value.label)||profileId,
kind:copyNullableString(value.kind)||'wasm32',
binding:{workspace_id:copyNullableString(binding.workspace_id),variant_id:copyNullableString(binding.variant_id),repo_id:copyNullableString(binding.repo_id),snapshot_id:copyNullableString(binding.snapshot_id)},
module:{sha256:copyNullableString(module.sha256)||copyNullableString(value.module_sha256),bytes:toInteger(module.bytes)!==null?toInteger(module.bytes):toInteger(value.module_bytes),file:copyNullableString(module.file)},
interfaces:interfaces,
interface_count:toInteger(value.interface_count),
limited:value.limited===true,
status:copyNullableString(value.status),
limits:{timeout_ms:toInteger(limits.timeout_ms),steps:toInteger(limits.steps),events_per_step:toInteger(limits.events_per_step)},
limitations:copyStringArray(value.limitations,32),
truncated:value.truncated===true,
};
}
function normalizeStubProfiles(payload){
var source=isRecord(payload)?payload:{};
var raw=Array.isArray(source.profiles)?source.profiles:(Array.isArray(source.items)?source.items:(Array.isArray(payload)?payload:[]));
var profiles=[];
for(var index=0;index<raw.length&&index<32;index+=1){
var profile=normalizeStubProfile(raw[index]);
if(profile!==null)profiles.push(profile);
}
return{profiles:profiles,gaps:Array.isArray(source.gaps)?source.gaps:[],truncated:source.truncated===true};
}
function normalizeScenarioLedger(payload){
var source=isRecord(payload)?payload:{};
var raw=Array.isArray(source.scenarios)?source.scenarios:(Array.isArray(source.items)?source.items:[]);
var scenarios=[];
for(var index=0;index<raw.length&&index<64;index+=1){
var item=raw[index];
if(!isRecord(item))continue;
var scenarioId=copyNullableString(item.scenario_id);
if(scenarioId===null)continue;
scenarios.push({
scenario_id:scenarioId,
profile_id:copyNullableString(item.profile_id),
generation:toSignedInteger(item.generation),
steps:toInteger(item.steps)!==null?toInteger(item.steps):toInteger(item.step_count),
created_at:copyNullableString(item.created_at),
updated_at:copyNullableString(item.updated_at),
records_digest:copyNullableString(item.records_digest),
workspace_id:copyNullableString(item.workspace_id),
snapshot_id:copyNullableString(item.snapshot_id),
imported:item.imported===true,
label:copyNullableString(item.label),
source:copyNullableString(item.source),
limitations:copyStringArray(item.limitations,32),
});
}
scenarios.sort(function(left,right){
var leftTime=Date.parse(String(left.updated_at||left.created_at||''));
var rightTime=Date.parse(String(right.updated_at||right.created_at||''));
if(Number.isFinite(leftTime)&&Number.isFinite(rightTime)&&leftTime!==rightTime)return rightTime-leftTime;
return (right.generation||0)-(left.generation||0);
});
return{scenarios:scenarios,gaps:Array.isArray(source.gaps)?source.gaps:[],truncated:source.truncated===true};
}
function normalizeScenarioPlan(payload){
var source=isRecord(payload)?payload:{};
var steps=[];
if(Array.isArray(source.steps)){
for(var index=0;index<source.steps.length&&index<MAX_STUB_STEPS;index+=1){
var step=source.steps[index];
if(!isRecord(step))continue;
steps.push({
index:toInteger(step.index)===null?index:step.index,
interface:copyNullableString(step.interface)||'',
role:SIM_ROLES.indexOf(step.role)>=0?step.role:'util',
args:normalizeStubArgs(step.args),
});
}
}
var limits=isRecord(source.limits)?source.limits:{};
return{
plan_id:copyNullableString(source.plan_id),
profile_id:copyNullableString(source.profile_id),
module_sha256:copyNullableString(source.module_sha256),
scenario_id:copyNullableString(source.scenario_id),
scenario_digest:copyNullableString(source.scenario_digest),
generation:toSignedInteger(source.generation),
steps:steps,
trace:isRecord(source.trace)?source.trace:null,
limits:{timeout_ms:toInteger(limits.timeout_ms),steps:toInteger(limits.steps),events_per_step:toInteger(limits.events_per_step)},
expires_at:copyNullableString(source.expires_at),
limitations:copyStringArray(source.limitations,32),
};
}
function normalizeStubArgs(value){
var args=[];
if(!Array.isArray(value))return args;
for(var index=0;index<value.length&&index<MAX_STUB_ARGS;index+=1){
var number=toSignedInteger(value[index]);
if(number!==null)args.push(number);
}
return args;
}
function normalizeStubEvent(value){
if(!isRecord(value))return null;
var event=copyNullableString(value.event);
if(event===null)return null;
return{
event_id:copyNullableString(value.event_id)||'',
event:event,
code:toSignedInteger(value.code),
a:toSignedInteger(value.a),
b:toSignedInteger(value.b),
c:toSignedInteger(value.c),
line:toInteger(value.line),
};
}
function normalizeStubRecord(value){
if(!isRecord(value))return null;
var status=value.status==='error'?'error':(value.status==='ok'?'ok':'unknown');
var events=[];
var rawEvents=Array.isArray(value.execution_events)?value.execution_events:(Array.isArray(value.events)?value.events:[]);
for(var index=0;index<rawEvents.length&&index<256;index+=1){
var event=normalizeStubEvent(rawEvents[index]);
if(event!==null)events.push(event);
}
var errorMessage=copyNullableString(value.error_message)||copyNullableString(isRecord(value.error)?value.error.message:null)||'';
return{
call_id:copyNullableString(value.call_id),
step_index:toInteger(value.step_index)===null?null:value.step_index,
interface:copyNullableString(value.interface)||'',
args:normalizeStubArgs(value.args),
status:status,
result:toSignedInteger(value.result),
memory_digest:copyNullableString(value.memory_digest),
affected_resources:normalizeAffectedResources(value.affected_resources),
stubbed:value.stubbed===true,
events:events,
error_message:cleanText(errorMessage,200),
};
}
function normalizeScenarioRun(payload){
var source=isRecord(payload)?payload:{};
var scenario=isRecord(source.scenario)?source.scenario:source;
var rawRecords=Array.isArray(source.records)?source.records:(Array.isArray(scenario.records)?scenario.records:[]);
var records=[];
for(var index=0;index<rawRecords.length&&index<MAX_STUB_STEPS;index+=1){
var record=normalizeStubRecord(rawRecords[index]);
if(record!==null)records.push(record);
}
return{
scenario_id:copyNullableString(scenario.scenario_id)||copyNullableString(source.scenario_id),
generation:toSignedInteger(scenario.generation)!==null?scenario.generation:toSignedInteger(source.generation),
profile_id:copyNullableString(scenario.profile_id)||copyNullableString(source.profile_id),
workspace_id:copyNullableString(scenario.workspace_id)||copyNullableString(source.workspace_id),
snapshot_id:copyNullableString(scenario.snapshot_id)||copyNullableString(source.snapshot_id),
records_digest:copyNullableString(scenario.records_digest)||copyNullableString(source.records_digest),
created_at:copyNullableString(scenario.created_at)||copyNullableString(source.created_at),
imported:scenario.imported===true||source.imported===true,
label:copyNullableString(scenario.label)||copyNullableString(source.label),
source:copyNullableString(scenario.source)||copyNullableString(source.source),
undo:normalizeUndoMeta(source.undo),
records:records,
limitations:copyStringArray(source.limitations,32),
gaps:Array.isArray(source.gaps)?source.gaps:[],
truncated:source.truncated===true,
};
}
function normalizeUndoMeta(value){
if(!isRecord(value))return null;
return{
of_scenario_id:copyNullableString(value.of_scenario_id),
of_generation:toSignedInteger(value.of_generation),
count:toInteger(value.count),
state_digest_verified:value.state_digest_verified===true,
};
}
function normalizeSummaryFacts(value){
var facts=[];
if(!Array.isArray(value))return facts;
for(var index=0;index<value.length&&index<32;index+=1){
var item=value[index];
if(!isRecord(item))continue;
var kind=copyNullableString(item.kind);
var ref=copyNullableString(item.ref);
if(kind===null||ref===null)continue;
facts.push({kind:kind.slice(0,32),ref:ref.slice(0,512)});
}
return facts;
}
function normalizeSummaryRecord(value){
if(!isRecord(value))return null;
var subject=isRecord(value.subject)?value.subject:{};
var subjectType=copyNullableString(subject.type);
var subjectId=copyNullableString(subject.id);
if(subjectType===null||subjectId===null)return null;
if(subjectType!=='function'&&subjectType!=='group'&&subjectType!=='entry')subjectType='unknown';
var generator=isRecord(value.generator)?value.generator:{};
var text=typeof value.text==='string'?value.text:'';
if(text.length>2000)text=text.slice(0,2000);
return{
subject_type:subjectType,
subject_id:subjectId,
text:text,
facts:normalizeSummaryFacts(value.facts),
generator:{kind:copyNullableString(generator.kind),ref:copyNullableString(generator.ref),model_ref:copyNullableString(generator.model_ref)},
inference_labels:copyStringArray(value.inference_labels,8),
generated_at:copyNullableString(value.generated_at),
snapshot_graph_sha256:copyNullableString(value.snapshot_graph_sha256),
stale:value.stale===true,
limitations:copyStringArray(value.limitations,32),
};
}
function normalizeSummaryPayload(payload){
var source=isRecord(payload)?payload:{};
var raw=Array.isArray(source.summaries)?source.summaries:(Array.isArray(source.items)?source.items:(normalizeSummaryRecord(payload)===null?[]:[payload]));
var summaries=[];
for(var index=0;index<raw.length&&index<32;index+=1){
var record=normalizeSummaryRecord(raw[index]);
if(record!==null)summaries.push(record);
}
return{
summaries:summaries,
gaps:Array.isArray(source.gaps)?source.gaps:[],
stale_count:toInteger(source.stale_count),
};
}
function createInitialSummaryState(){
return{key:null,state:'idle',payload:null,error:null};
}
function findSummaryForSubject(payload,subjectType,subjectId){
var normalized=normalizeSummaryPayload(payload);
for(var index=0;index<normalized.summaries.length;index+=1){
var record=normalized.summaries[index];
if(record.subject_type===subjectType&&record.subject_id===subjectId)return record;
}
if(subjectType===null||subjectType===undefined)return normalized.summaries.length>0?normalized.summaries[0]:null;
return null;
}
function entrySummarySubjectFor(view,ui){
if(ui.details===null||ui.details===undefined)return null;
if(ui.details.kind!=='function'&&ui.details.kind!=='group')return null;
var entry=view.entry;
if(entry===null||entry===undefined)return null;
var entryId=copyNullableString(entry.entry_id);
if(entryId===null)return null;
return{type:'entry',id:entryId,label:copyNullableString(entry.name)||entryId};
}
function groupInfoForId(view,groupId){
var entry=view.data?view.data.end_to_end:null;
if(!entry||!isRecord(entry.payload))return null;
var normalized=normalizeEndToEnd(entry.payload);
var model=buildGroupModel(normalized.groups);
if(model.byId[groupId]===undefined)return null;
var group=model.byId[groupId];
return{group_id:groupId,label:groupLabelOf(group,view.groupOverrides),description:groupDescriptionOf(group,view.groupOverrides),member_count:collectGroupNodeIds(model,groupId).length};
}
function summarySubjectFor(view,ui){
if(ui.details!==null&&ui.details!==undefined&&ui.details.kind==='function'&&copyNullableString(ui.details.function_id)!==null){
return{type:'function',id:ui.details.function_id,label:copyNullableString(view.selectedFunctionName)||ui.details.function_id};
}
if(ui.details!==null&&ui.details!==undefined&&ui.details.kind==='group'&&copyNullableString(ui.details.group_id)!==null){
var info=groupInfoForId(view,ui.details.group_id);
return{type:'group',id:ui.details.group_id,label:info!==null?info.label:ui.details.group_id,info:info};
}
return null;
}
function viewPayloadState(name,payload){
if(name==='coupling'){
var coupling=normalizeCoupling(payload);
return coupling.resources.length>0||coupling.functions.length>0?'ready':'empty';
}
if(name==='tree'){
var tree=normalizeTree(payload);
return tree.nodes.length>0?'ready':'empty';
}
if(name==='end_to_end'){
var graph=normalizeEndToEnd(payload);
return graph.nodes.length>0?'ready':'empty';
}
if(name==='sequence'){
var sequence=normalizeSequence(payload);
return sequence.messages.length>0||sequence.participants.length>0?'ready':'empty';
}
return 'ready';
}
var CSS=[
'.dcr-root{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px;max-width:1440px;margin:0 auto;color:var(--dsh-text-color,currentColor);background:var(--dsh-panel-background,transparent);font:inherit;line-height:1.5;overflow-wrap:anywhere;}',
'.dcr-root *{box-sizing:border-box;}',
'.dcr-header{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));}',
'.dcr-brand{display:flex;align-items:flex-start;gap:10px;min-width:0;}',
'.dcr-title{font-size:18px;line-height:1.4;margin:0 0 2px;font-weight:600;color:inherit;}',
'.dcr-meta{margin:1px 0;color:var(--dsh-text-muted,currentColor);opacity:0.9;}',
'.dcr-muted{margin:2px 0;color:var(--dsh-text-muted,currentColor);opacity:0.78;}',
'.dcr-header-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
'.dcr-btn{font:inherit;padding:5px 10px;border-radius:8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.45));background:var(--dsh-button-background,transparent);color:inherit;cursor:pointer;min-height:30px;}',
'.dcr-btn-primary{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-btn:disabled{cursor:not-allowed;opacity:0.55;}',
'.dcr-btn-selected{border-color:var(--dsh-accent-color,currentColor);box-shadow:inset 0 -2px 0 var(--dsh-accent-color,currentColor);}',
'.dcr-btn:focus-visible,.dcr-tab:focus-visible,.dcr-snapshot:focus-visible,.dcr-entry:focus-visible,.dcr-node:focus-visible,.dcr-tree-node:focus-visible,.dcr-tree-name:focus-visible,.dcr-file-button:focus-visible,.dcr-line:focus-visible,.dcr-resource-row:focus-visible{outline:2px solid var(--dsh-focus-color,currentColor);outline-offset:2px;}',
'.dcr-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:7px 10px;border:1px dashed var(--dsh-border-color,rgba(127,127,127,0.5));border-radius:8px;}',
'.dcr-status-label{font-weight:600;}',
'.dcr-notice{margin:3px 0;color:var(--dsh-text-muted,currentColor);}',
'.dcr-errors{display:flex;flex-direction:column;gap:6px;}',
'.dcr-error{border:1px solid var(--dsh-danger-color,currentColor);border-radius:8px;padding:7px 10px;margin:2px 0;color:var(--dsh-danger-color,currentColor);}',
'.dcr-error-code{font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);}',
'.dcr-error-note{color:var(--dsh-danger-color,currentColor);}',
'.dcr-scope{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;}',
'.dcr-scope-line{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
'.dcr-scope-label{font-size:12px;font-weight:600;min-width:84px;color:var(--dsh-text-muted,currentColor);}',
'.dcr-chip{display:inline-block;padding:0 6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));border-radius:999px;font-size:12px;line-height:1.7;white-space:nowrap;}',
'.dcr-badge{display:inline-block;padding:0 6px;border-radius:6px;font-size:12px;line-height:1.7;border:1px solid currentColor;white-space:nowrap;}',
'.dcr-badge-exact{border-style:solid;font-weight:600;}',
'.dcr-badge-may{border-style:dashed;}',
'.dcr-badge-unknown{border-style:dotted;opacity:0.85;}',
'.dcr-badge-observed{border-style:double;}',
'.dcr-badge-source_text{border-style:solid;opacity:0.9;}',
'.dcr-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;}',
'.dcr-tab{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;}',
'.dcr-tab[aria-pressed="true"]{border-color:var(--dsh-accent-color,currentColor);font-weight:600;}',
'.dcr-tabs-spacer{flex:1 1 auto;}',
'.dcr-legend-wrap{position:relative;}',
'.dcr-legend-trigger{font:inherit;width:30px;height:30px;border-radius:50%;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.5));background:transparent;color:inherit;cursor:pointer;}',
'.dcr-legend{position:absolute;right:0;top:34px;z-index:8;width:min(360px,86vw);max-height:60vh;overflow:auto;padding:10px 12px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.5));border-radius:10px;background:var(--dsh-popover-background,var(--dsh-panel-background,transparent));color:inherit;box-shadow:0 8px 22px rgba(0,0,0,0.18);}',
'.dcr-legend h3{font-size:14px;margin:0 0 6px;}',
'.dcr-legend-section{margin:8px 0;}',
'.dcr-legend-section h4{font-size:12px;margin:0 0 4px;color:var(--dsh-text-muted,currentColor);}',
'.dcr-legend-row{display:flex;gap:8px;align-items:center;margin:2px 0;font-size:12px;}',
'.dcr-swatch{display:inline-block;width:22px;height:10px;border-radius:2px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.5));background:transparent;}',
'.dcr-layout{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:12px;align-items:start;}',
'.dcr-rail{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;padding:8px;}',
'.dcr-rail-tabs{display:flex;flex-wrap:wrap;gap:6px;}',
'.dcr-rail-pane{display:flex;flex-direction:column;gap:6px;min-width:0;}',
'.dcr-resource-row{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-left-width:4px;border-radius:6px;padding:6px 8px;cursor:pointer;}',
'.dcr-resource-row.dcr-related{border-left-color:var(--dsh-accent-color,currentColor);}',
'.dcr-resource-row.dcr-selected{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-resource-tags{display:flex;flex-wrap:wrap;gap:4px;}',
'.dcr-stub{border:1px dashed var(--dsh-border-color,rgba(127,127,127,0.5));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;}',
'.dcr-main{display:flex;flex-direction:column;gap:10px;min-width:0;}',
'.dcr-section{margin:4px 0;min-width:0;}',
'.dcr-section-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;}',
'.dcr-heading{font-size:15px;line-height:1.4;margin:0 0 6px;font-weight:600;color:inherit;}',
'.dcr-subheading{font-size:13px;line-height:1.4;margin:8px 0 4px;font-weight:600;color:inherit;}',
'.dcr-view{min-width:0;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;padding:8px;}',
'.dcr-view-empty{padding:14px;color:var(--dsh-text-muted,currentColor);}',
'.dcr-canvas{position:relative;overflow:hidden;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;min-height:360px;height:62vh;background:var(--dsh-canvas-background,transparent);touch-action:none;}',
'.dcr-canvas-viewport{position:absolute;inset:0;overflow:hidden;cursor:grab;}',
'.dcr-canvas-viewport.dcr-dragging{cursor:grabbing;}',
'.dcr-canvas-world{position:absolute;left:0;top:0;transform-origin:0 0;}',
'.dcr-canvas-svg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible;}',
'.dcr-graph-node{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;text-align:center;padding:6px;border:1.5px solid var(--dsh-text-color,currentColor);border-radius:8px;background:var(--dsh-node-background,var(--dsh-panel-background,transparent));color:inherit;cursor:grab;overflow:hidden;}',
'.dcr-graph-node.dcr-selected{outline:2px solid var(--dsh-accent-color,currentColor);outline-offset:2px;}',
'.dcr-graph-node.dcr-kind-entry{border-radius:50%;}',
'.dcr-graph-node.dcr-role-error{border-color:var(--dsh-danger-color,currentColor);color:var(--dsh-danger-color,currentColor);}',
'.dcr-graph-node.dcr-kind-external{border-style:dashed;border-radius:2px;}',
'.dcr-shape-diamond{transform:rotate(45deg);}',
'.dcr-shape-diamond>*{transform:rotate(-45deg);}',
'.dcr-shape-parallelogram{transform:skewX(-12deg);}',
'.dcr-shape-parallelogram>*{transform:skewX(12deg);}',
'.dcr-graph-node-label{font-weight:600;font-size:12px;line-height:1.25;max-width:100%;}',
'.dcr-graph-node-sub{font-size:11px;line-height:1.2;color:var(--dsh-text-muted,currentColor);max-width:100%;}',
'.dcr-graph-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;}',
'.dcr-graph-search{font:inherit;padding:3px 8px;border-radius:6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.45));background:transparent;color:inherit;min-width:160px;}',
'.dcr-graph-zoom{font-size:12px;min-width:46px;text-align:right;color:var(--dsh-text-muted,currentColor);}',
'.dcr-coupling-columns{position:relative;overflow-x:auto;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.25));border-radius:8px;padding:6px 0;min-height:240px;}',
'.dcr-coupling-canvas{position:relative;margin:0 auto;}',
'.dcr-column{position:absolute;top:0;}',
'.dcr-column-title{position:absolute;top:0;left:0;right:0;text-align:center;font-size:12px;font-weight:600;color:var(--dsh-text-muted,currentColor);}',
'.dcr-coupling-node{position:absolute;display:flex;flex-direction:column;gap:1px;text-align:left;padding:6px 8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.5));border-radius:8px;background:var(--dsh-node-background,var(--dsh-panel-background,transparent));color:inherit;font:inherit;cursor:pointer;overflow:hidden;}',
'.dcr-coupling-node.dcr-resource-node{border-left-width:4px;}',
'.dcr-coupling-node.dcr-selected{outline:2px solid var(--dsh-accent-color,currentColor);outline-offset:2px;}',
'.dcr-coupling-node.dcr-highlight{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-coupling-node.dcr-dim{opacity:0.45;}',
'.dcr-coupling-svg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible;}',
'.dcr-access-edge{fill:none;stroke-width:1.6;}',
'.dcr-access-read{stroke:var(--dsh-access-read,currentColor);}',
'.dcr-access-write{stroke:var(--dsh-access-write,currentColor);stroke-width:2.2;}',
'.dcr-access-rmw{stroke:var(--dsh-access-rmw,currentColor);stroke-dasharray:6 3;}',
'.dcr-access-init{stroke:var(--dsh-access-init,currentColor);stroke-dasharray:3 3;}',
'.dcr-access-deinit{stroke:var(--dsh-access-deinit,currentColor);stroke-dasharray:3 3;}',
'.dcr-access-alloc{stroke:var(--dsh-access-alloc,currentColor);stroke-dasharray:2 3;}',
'.dcr-access-free{stroke:var(--dsh-access-free,currentColor);stroke-dasharray:2 3;}',
'.dcr-access-acquire{stroke:var(--dsh-access-acquire,currentColor);stroke-dasharray:8 3 2 3;}',
'.dcr-access-release{stroke:var(--dsh-access-release,currentColor);stroke-dasharray:8 3 2 3;}',
'.dcr-certainty-may{stroke-dasharray:5 4;}',
'.dcr-certainty-unknown{stroke-dasharray:2 4;opacity:0.8;}',
'.dcr-arrow{fill:currentColor;}',
'.dcr-arrow-exception{fill:var(--dsh-danger-color,currentColor);}',
'.dcr-edge-label{font-size:11px;fill:var(--dsh-text-muted,currentColor);}',
'.dcr-edge-label-exception{fill:var(--dsh-danger-color,currentColor);}',
'.dcr-graph-edge{fill:none;stroke:currentColor;stroke-width:1.6;}',
'.dcr-graph-edge-exception{stroke:var(--dsh-danger-color,currentColor);}',
'.dcr-graph-edge-dashed{stroke-dasharray:5 4;}',
'.dcr-tree{display:flex;flex-direction:column;gap:2px;max-height:62vh;overflow:auto;padding:4px;}',
'.dcr-tree-node{display:flex;flex-direction:column;gap:2px;}',
'.dcr-tree-row{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:3px 6px;border-radius:6px;border:1px solid transparent;}',
'.dcr-tree-row.dcr-selected{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-tree-toggle{font:inherit;width:22px;min-width:22px;height:22px;line-height:1;border-radius:4px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));background:transparent;color:inherit;cursor:pointer;}',
'.dcr-tree-name{font-weight:600;cursor:pointer;border:0;background:transparent;color:inherit;font:inherit;padding:0;text-align:left;}',
'.dcr-tree-indent{display:inline-block;width:14px;}',
'.dcr-tree-guard{color:var(--dsh-text-muted,currentColor);}',
'.dcr-seq{display:flex;flex-direction:column;gap:4px;overflow-x:auto;min-width:620px;}',
'.dcr-seq-head{display:flex;gap:0;position:relative;min-height:30px;}',
'.dcr-seq-participant{flex:1 1 0;text-align:center;font-size:12px;font-weight:600;padding:4px 2px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));border-radius:6px;margin:0 2px;background:var(--dsh-node-background,transparent);}',
'.dcr-seq-body{position:relative;display:flex;flex-direction:column;gap:0;}',
'.dcr-seq-lane{position:absolute;top:0;bottom:0;width:1px;border-left:1px dashed var(--dsh-border-color,rgba(127,127,127,0.5));}',
'.dcr-seq-row{position:relative;display:flex;flex-direction:column;justify-content:center;min-height:46px;padding:2px 0;cursor:pointer;}',
'.dcr-seq-row.dcr-selected{outline:1px solid var(--dsh-accent-color,currentColor);outline-offset:-1px;border-radius:6px;}',
'.dcr-seq-row-text{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;justify-content:center;font-size:12px;}',
'.dcr-seq-arrow-svg{position:absolute;left:0;top:16px;width:100%;height:20px;pointer-events:none;}',
'.dcr-seq-call{color:inherit;}',
'.dcr-seq-return{color:var(--dsh-text-muted,currentColor);}',
'.dcr-seq-access{color:var(--dsh-accent-color,currentColor);}',
'.dcr-seq-external{color:var(--dsh-warning-color,currentColor);}',
'.dcr-seq-error{color:var(--dsh-danger-color,currentColor);}',
'.dcr-seq-msg{stroke:currentColor;fill:none;stroke-width:1.4;}',
'.dcr-seq-msg-dashed{stroke-dasharray:5 4;}',
'.dcr-seq-msg-error{stroke:var(--dsh-danger-color,currentColor);fill:var(--dsh-danger-color,currentColor);}',
'.dcr-details{border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;}',
'.dcr-details-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;}',
'.dcr-file-layout{display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr);gap:10px;align-items:start;}',
'.dcr-file-tree{display:flex;flex-direction:column;gap:4px;max-height:62vh;overflow:auto;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;padding:6px;}',
'.dcr-file-repo{font-size:12px;font-weight:600;margin:4px 0 0;color:var(--dsh-text-muted,currentColor);}',
'.dcr-file-button{font:inherit;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:6px;padding:3px 6px;cursor:pointer;}',
'.dcr-file-button.dcr-selected{border-color:var(--dsh-accent-color,currentColor);font-weight:600;}',
'.dcr-file-viewer{min-width:0;display:flex;flex-direction:column;gap:4px;}',
'.dcr-code{margin:2px 0;padding:6px 0;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:8px;overflow:auto;max-height:62vh;font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:13px;line-height:1.55;}',
'.dcr-line{display:flex;gap:12px;white-space:pre;min-width:0;padding:0 8px;}',
'.dcr-line-no{flex:0 0 auto;min-width:4ch;text-align:right;color:var(--dsh-text-muted,currentColor);opacity:0.7;user-select:none;}',
'.dcr-line-text{flex:0 0 auto;}',
'.dcr-line-hit{background:var(--dsh-highlight-background,rgba(127,127,127,0.18));}',
'.dcr-line-hit .dcr-line-no{opacity:1;}',
'.dcr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',
'.dcr-snapshot,.dcr-entry{display:flex;flex-direction:column;gap:1px;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:7px;padding:4px 8px;cursor:pointer;}',
'.dcr-snapshot.dcr-selected,.dcr-entry.dcr-selected{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-snapshot-line1,.dcr-entry-name{font-weight:600;}',
'.dcr-edge{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:4px 6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:7px;}',
'.dcr-edges{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;}',
'.dcr-evidence-row{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;}',
'.dcr-resource,.dcr-field-access{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:4px 6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:7px;}',
'.dcr-resource-name{font-weight:600;}',
'.dcr-gaps{display:flex;flex-direction:column;gap:4px;}',
'.dcr-gap{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:4px 8px;border-left:3px solid var(--dsh-warning-color,currentColor);background:var(--dsh-gap-background,transparent);}',
'.dcr-gap-code{font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-weight:600;}',
'.dcr-selection{margin:0;padding:8px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:8px;overflow-x:auto;font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.5;color:inherit;background:transparent;}',
'@media (max-width:900px){.dcr-layout{grid-template-columns:minmax(0,1fr);}.dcr-file-layout{grid-template-columns:minmax(0,1fr);}.dcr-canvas{height:52vh;}}',
'@media (max-width:720px){.dcr-tabs{flex-wrap:wrap;}.dcr-legend{position:fixed;right:8px;bottom:8px;top:auto;max-height:70vh;}.dcr-scope-label{min-width:0;}.dcr-canvas{height:46vh;}}',
'@media (prefers-reduced-motion:reduce){.dcr-root *{transition:none !important;animation:none !important;}}',
].join('\n');
var styleElement=null;
function findStyle(){
try{
return document.querySelector('style[data-code-view-style]');
}catch(error){
return null;
}
}
function ensureStyle(){
if(typeof document==='undefined'||document===null||!document.head)return null;
if(styleElement!==null&&styleElement.parentNode)return styleElement;
var existing=findStyle();
if(existing!==null){
styleElement=existing;
return existing;
}
var node=document.createElement('style');
node.setAttribute(STYLE_ATTRIBUTE,'');
node.textContent=CSS;
document.head.appendChild(node);
styleElement=node;
return node;
}
function removeStyle(node){
if(node&&node.parentNode)node.parentNode.removeChild(node);
if(styleElement===node)styleElement=null;
}
function sortFunctions(list){
var copy=list.slice();
copy.sort(function(left,right){
var byName=compareByString(left.name,right.name);
if(byName!==0)return byName;
return compareByString(left.function_id,right.function_id);
});
return copy;
}
function couplingLayout(payload){
var data=normalizeCoupling(payload);
var padding=26;
var titleHeight=30;
var functionWidth=196;
var functionHeight=58;
var resourceWidth=236;
var resourceHeight=86;
var gapX=104;
var gapY=26;
var writers=[];
var readers=[];
var bothIds={};
var index;
for(index=0;index<data.functions.length;index+=1){
var fn=data.functions[index];
if(fn.role==='reader')readers.push(fn);
else{
writers.push(fn);
if(fn.role==='both')bothIds[fn.function_id]=true;
}
}
writers=sortFunctions(writers);
readers=sortFunctions(readers);
var resources=data.resources.slice();
resources.sort(function(left,right){
return compareByString(left.name,right.name)||compareByString(left.resource_id,right.resource_id);
});
var writerX=padding;
var resourceX=writerX+functionWidth+gapX;
var readerX=resourceX+resourceWidth+gapX;
var width=readerX+functionWidth+padding;
var rows=Math.max(writers.length,resources.length,readers.length,1);
var height=titleHeight+padding*2+rows*(Math.max(functionHeight,resourceHeight)+gapY);
function place(list,x,itemWidth,itemHeight){
var placed=[];
for(var i=0;i<list.length;i+=1){
placed.push({item:list[i],x:x,y:titleHeight+padding+i*(itemHeight+gapY),w:itemWidth,h:itemHeight});
}
return placed;
}
var writerNodes=place(writers,writerX,functionWidth,functionHeight);
var resourceNodes=place(resources,resourceX,resourceWidth,resourceHeight);
var readerNodes=place(readers,readerX,functionWidth,functionHeight);
var positionByFunction={};
var positionByResource={};
for(index=0;index<writerNodes.length;index+=1)positionByFunction[writerNodes[index].item.function_id]=writerNodes[index];
for(index=0;index<readerNodes.length;index+=1)positionByFunction[readerNodes[index].item.function_id]=readerNodes[index];
for(index=0;index<resourceNodes.length;index+=1)positionByResource[resourceNodes[index].item.resource_id]=resourceNodes[index];
var laidEdges=[];
for(index=0;index<data.edges.length;index+=1){
var edge=data.edges[index];
var from=positionByFunction[edge.from_function];
var to=positionByResource[edge.to_resource];
if(!from||!to)continue;
var leftColumn=writers.some(function(fn){return fn.function_id===edge.from_function;});
var sx;
var sy=from.y+from.h/2;
var ex;
var ey=to.y+to.h/2;
if(leftColumn){
sx=from.x+from.w;
ex=to.x;
}else{
sx=to.x+to.w;
ex=from.x;
}
var midX=(sx+ex)/2;
laidEdges.push({
edge:edge,
d:'M'+sx+' '+sy+' H'+midX+' V'+ey+' H'+ex,
labelX:midX,
labelY:(sy+ey)/2-5,
arrowPoints:ex+','+ey+' '+(ex-8)+','+(ey-4)+' '+(ex-8)+','+(ey+4),
});
}
return{
data:data,
width:width,
height:height,
writers:writers,
readers:readers,
resources:resources,
writerNodes:writerNodes,
resourceNodes:resourceNodes,
readerNodes:readerNodes,
edges:laidEdges,
bothIds:bothIds,
functionWidth:functionWidth,
functionHeight:functionHeight,
resourceWidth:resourceWidth,
resourceHeight:resourceHeight,
titleHeight:titleHeight,
padding:padding,
writerX:writerX,
resourceX:resourceX,
readerX:readerX,
};
}
function endToEndLayout(payload){
var data=normalizeEndToEnd(payload);
var nodes=data.nodes;
var edges=data.edges;
var nodeById={};
var index;
for(index=0;index<nodes.length;index+=1)nodeById[nodes[index].node_id]=nodes[index];
var layers={};
var layerOf={};
var entryNode=null;
for(index=0;index<nodes.length;index+=1){
if(nodes[index].kind==='entry'&&entryNode===null)entryNode=nodes[index];
layerOf[nodes[index].node_id]=0;
}
if(entryNode===null&&nodes.length>0)entryNode=nodes[0];
var guard=0;
var changed=true;
while(changed&&guard<nodes.length+4){
changed=false;
guard+=1;
for(index=0;index<edges.length;index+=1){
var edge=edges[index];
if(!nodeById[edge.from]||!nodeById[edge.to]||edge.from===edge.to)continue;
var candidate=layerOf[edge.from]+1;
if(candidate>layerOf[edge.to]&&candidate<=12){
layerOf[edge.to]=candidate;
changed=true;
}
}
}
for(index=0;index<nodes.length;index+=1){
var layerKey=layerOf[nodes[index].node_id];
if(!Array.isArray(layers[layerKey]))layers[layerKey]=[];
layers[layerKey].push(nodes[index]);
}
var kindOrder={entry:0,decision:1,process:2,io:3,external:4,exit:5};
var layerKeys=Object.keys(layers).map(function(value){return Number(value);}).sort(function(a,b){return a-b;});
var nodeWidth=180;
var nodeHeight=76;
var gapX=46;
var gapY=94;
var padding=30;
var titleHeight=20;
var maxRowWidth=0;
var rowInfo=[];
for(index=0;index<layerKeys.length;index+=1){
var rowNodes=layers[layerKeys[index]].slice();
rowNodes.sort(function(left,right){
var leftOrder=kindOrder[left.kind]===undefined?9:kindOrder[left.kind];
var rightOrder=kindOrder[right.kind]===undefined?9:kindOrder[right.kind];
if(leftOrder!==rightOrder)return leftOrder-rightOrder;
return compareByString(left.label,right.label)||compareByString(left.node_id,right.node_id);
});
var rowWidth=rowNodes.length*nodeWidth+(rowNodes.length-1)*gapX;
if(rowWidth>maxRowWidth)maxRowWidth=rowWidth;
rowInfo.push({layer:layerKeys[index],nodes:rowNodes,width:rowWidth});
}
var errorExits=[];
for(index=0;index<nodes.length;index+=1){
if(nodes[index].role==='error')errorExits.push(nodes[index]);
}
var errorColumnWidth=errorExits.length>0?nodeWidth+90:0;
var width=padding*2+maxRowWidth+errorColumnWidth;
var height=titleHeight+padding*2+rowInfo.length*(nodeHeight+gapY);
var placed=[];
var positionById={};
for(index=0;index<rowInfo.length;index+=1){
var row=rowInfo[index];
var rowX=padding+Math.max(0,(maxRowWidth-row.width)/2);
var rowY=titleHeight+padding+index*(nodeHeight+gapY);
for(var ni=0;ni<row.nodes.length;ni+=1){
var node=row.nodes[ni];
var item={node:node,x:rowX+ni*(nodeWidth+gapX),y:rowY,w:nodeWidth,h:nodeHeight};
placed.push(item);
positionById[node.node_id]=item;
}
}
if(errorExits.length>0){
var errorX=padding+maxRowWidth+70;
for(index=0;index<errorExits.length;index+=1){
var existing=positionById[errorExits[index].node_id];
if(!existing)continue;
existing.x=errorX+Math.floor(index/3)*(nodeWidth+40);
existing.y=titleHeight+padding+(layerOf[errorExits[index].node_id]||0)*(nodeHeight+gapY);
}
}
function bottomCenter(item){return{x:item.x+item.w/2,y:item.y+item.h};}
function topCenter(item){return{x:item.x+item.w/2,y:item.y};}
var laidEdges=[];
for(index=0;index<edges.length;index+=1){
var current=edges[index];
var fromItem=positionById[current.from];
var toItem=positionById[current.to];
if(!fromItem||!toItem)continue;
var start=bottomCenter(fromItem);
var end=topCenter(toItem);
var d;
var labelX;
var labelY;
if(end.y>=start.y+20){
var midY=Math.round((start.y+end.y)/2);
d='M'+start.x+' '+start.y+' V'+midY+' H'+end.x+' V'+end.y;
labelX=(start.x+end.x)/2;
labelY=midY-4;
}else{
var sideX=end.x>=start.x?fromItem.x+fromItem.w+34:fromItem.x-34;
var lowerY=start.y+26;
var upperY=end.y-26;
d='M'+start.x+' '+start.y+' V'+lowerY+' H'+sideX+' V'+upperY+' H'+end.x+' V'+end.y;
labelX=sideX;
labelY=(lowerY+upperY)/2;
}
laidEdges.push({
edge:current,
d:d,
labelX:labelX,
labelY:labelY,
arrowPoints:end.x+','+end.y+' '+(end.x-6)+','+(end.y-10)+' '+(end.x+6)+','+(end.y-10),
exception:current.style_color==='exception',
dashed:current.kind==='external'||current.style_line==='dashed',
});
}
return{
data:data,
nodes:placed,
edges:laidEdges,
entryNode:entryNode,
width:width,
height:height,
nodeById:nodeById,
};
}
function buildTreeModel(tree){
var childrenByParent={};
var nodeById={};
var index;
for(index=0;index<tree.nodes.length;index+=1){
var node=tree.nodes[index];
nodeById[node.node_id]=node;
var parent=node.parent_node_id;
if(parent===null)parent='__root__';
if(!Array.isArray(childrenByParent[parent]))childrenByParent[parent]=[];
childrenByParent[parent].push(node);
}
for(var parentId in childrenByParent){
if(!Object.prototype.hasOwnProperty.call(childrenByParent,parentId))continue;
childrenByParent[parentId].sort(function(left,right){
var leftLine=left.callsite!==null?toInteger(left.callsite.line):null;
var rightLine=right.callsite!==null?toInteger(right.callsite.line):null;
if(leftLine!==null&&rightLine!==null&&leftLine!==rightLine)return leftLine-rightLine;
if(leftLine!==null&&rightLine===null)return-1;
if(leftLine===null&&rightLine!==null)return 1;
return compareByString(left.symbol.name,right.symbol.name)||compareByString(left.node_id,right.node_id);
});
}
return{roots:childrenByParent.__root__||[],children:childrenByParent,nodeById:nodeById};
}
function CodeReaderIcon(props){
var size=props&&typeof props.size==='number'?props.size:18;
return el('svg',{
role:'img',
'aria-label':PANEL_LABEL,
focusable:'false',
width:size,
height:size,
viewBox:'0 0 18 18',
},
el('path',{d:'M6 3 2 9l4 6',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}),
el('path',{d:'M12 3l4 6-4 6',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}),
el('path',{d:'M10.5 2.5 7.5 15.5',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round'}),
el('circle',{cx:4,cy:4,r:1.1,fill:'currentColor'}),
el('circle',{cx:14,cy:14,r:1.1,fill:'currentColor'})
);
}
function EvidenceBadge(props){
var value=normalizeEvidenceClass(props.value);
return el('span',{className:'dcr-badge dcr-badge-'+value,'data-evidence-class':value},EVIDENCE_LABELS[value]);
}
function StatusBar(props){
return el('div',{
className:'dcr-status',
'data-code-view':'status',
'data-state':props.state,
role:'status',
'aria-live':'polite',
'aria-atomic':'true',
'aria-busy':props.state==='loading'?'true':'false',
},
el('span',{className:'dcr-status-label'},props.text),
props.gapCount>0?el('span',{className:'dcr-chip'},'缺口 '+String(props.gapCount)):null
);
}
function ErrorSection(props){
if(!props.errors.length)return null;
return el('div',{className:'dcr-errors'},props.errors.map(function(error,index){
return el('div',{
key:index,
className:'dcr-error',
'data-code-view':'error',
'data-error-code':error.code,
role:'alert',
},
el('strong',{className:'dcr-error-code'},String(error.code)),
' ',
el('span',{className:'dcr-error-message'},String(error.message||''))
);
}));
}
function SnapshotList(props){
if(props.loading===true)return el('p',{className:'dcr-muted',role:'status'},TEXT.snapshotsLoading);
if(props.rows===null)return el('p',{className:'dcr-muted'},props.error!==null?TEXT.snapshotsFailed:TEXT.snapshotsLoading);
if(props.rows.length===0){
return el('div',null,
el('p',{className:'dcr-muted'},TEXT.snapshotsEmpty),
el('p',{className:'dcr-muted'},TEXT.snapshotsEmptyHint)
);
}
return el('div',{className:'dcr-list',role:'list','aria-label':TEXT.snapshotsTitle},props.rows.map(function(row){
var selected=props.selectedId===row.snapshot_id;
return el('button',{
key:String(row.workspace_id)+'/'+String(row.variant_id)+'/'+row.snapshot_id,
type:'button',
role:'listitem',
className:'dcr-snapshot'+(selected?' dcr-selected':''),
'data-snapshot-id':row.snapshot_id,
'data-snapshot-status':row.status,
'aria-pressed':selected?'true':'false',
onClick:function(){props.onSelect(row);},
},
el('span',{className:'dcr-snapshot-line1'},String(row.workspace_id||'—')+' → '+String(row.variant_id||'—')+' → '+row.snapshot_id),
el('span',{className:'dcr-meta'},
'状态 '+statusLabel(row.status)+'（'+row.status+'） · 新鲜度 '+freshnessLabel(row.freshness)+'（'+row.freshness+'） · 入口 '+numberText(row.entry_count)+' · failed '+numberText(row.failed_count)+' · pending '+numberText(row.pending_count)+' · whole_program_complete '+(row.whole_program_complete===true?'true':'false')),
row.status==='invalid'&&row.error!==null?el('span',{className:'dcr-error-note'},'核验错误 '+row.error.code+'：'+row.error.message):null
);
}));
}
function EntryList(props){
if(props.loading===true)return el('p',{className:'dcr-muted',role:'status'},TEXT.entriesLoading);
if(props.rows===null)return el('p',{className:'dcr-muted'},props.error!==null?TEXT.entriesFailed:TEXT.entriesPrompt);
if(props.rows.length===0)return el('p',{className:'dcr-muted'},TEXT.entriesEmpty);
return el('div',{className:'dcr-list',role:'list','aria-label':TEXT.entriesTitle},props.rows.map(function(row){
var entryId=copyNullableString(row.entry_id);
var entryName=copyNullableString(row.name)||copyNullableString(row.display_name)||entryId||'unknown';
var selected=props.selectedEntryId!==null&&props.selectedEntryId===entryId;
return el('button',{
key:entryId||entryName,
type:'button',
role:'listitem',
className:'dcr-entry'+(selected?' dcr-selected':''),
'data-entry-id':entryId||'',
'data-entry-name':entryName,
'data-entry-is-entry':row.is_entry===true?'true':'false',
'aria-current':selected?'true':undefined,
title:'入口 '+entryName+' '+formatLocation(row.file,row.line),
onMouseEnter:function(){if(typeof props.onPrefetch==='function')props.onPrefetch(row);},
onFocus:function(){if(typeof props.onPrefetch==='function')props.onPrefetch(row);},
onClick:function(){props.onSelect(row);},
},
el('span',{className:'dcr-entry-name'},entryName+(row.is_entry===true?'（入口）':'')),
el('span',{className:'dcr-meta'},formatLocation(row.file,row.line)+(row.signature?' · '+String(row.signature):''))
);
}));
}
function Tabs(props){
return el('nav',{className:'dcr-tabs','data-code-view':'tabs','aria-label':TEXT.tabsLabel},
VIEW_KEYS.map(function(key){
return el('button',{
key:key,
type:'button',
className:'dcr-tab',
'data-view':key,
'aria-pressed':props.active===key?'true':'false',
onClick:function(){props.onSelect(key);},
},VIEW_LABELS[key]);
}),
el('span',{className:'dcr-tabs-spacer'}),
el('span',{className:'dcr-legend-wrap'},
el('button',{
type:'button',
className:'dcr-legend-trigger',
'aria-label':TEXT.legendTrigger,
'aria-expanded':props.legendOpen?'true':'false',
onClick:props.onToggleLegend,
},'?')
)
);
}
function LegendPanel(props){
var evidenceRows=['exact','may','unknown','observed','source_text'].map(function(key){
return el('div',{key:key,className:'dcr-legend-row'},
el(EvidenceBadge,{value:key}),
el('span',null,key+(key==='source_text'?'（源码证据，仅证明文本存在）':''))
);
});
var accessRows=ACCESS_VALUES.map(function(key){
return el('div',{key:key,className:'dcr-legend-row'},
el('span',{className:'dcr-swatch dcr-access-'+key}),
el('span',null,accessLabel(key)+'（'+key+'）')
);
});
var shapeRows=['ellipse','rect','diamond','parallelogram','rectangle'].map(function(key){
return el('div',{key:key,className:'dcr-legend-row'},
el('span',{className:'dcr-swatch dcr-swatch-'+key}),
el('span',null,SHAPE_LABELS[key]+'（'+key+'）')
);
});
return el('section',{
className:'dcr-legend',
'data-code-view':'legend',
hidden:props.open?undefined:true,
'aria-label':TEXT.legendTitle,
},
el('h3',null,TEXT.legendTitle),
el('p',{className:'dcr-muted'},TEXT.legendHint),
el('div',{className:'dcr-legend-section'},
el('h4',null,TEXT.legendEvidence),
evidenceRows
),
el('div',{className:'dcr-legend-section'},
el('h4',null,TEXT.legendAccess),
accessRows,
el('p',{className:'dcr-muted'},'实线 = exact，虚线 = may，点线 = unknown；异常出口统一红色实线。')
),
el('div',{className:'dcr-legend-section'},
el('h4',null,TEXT.legendShapes),
shapeRows
),
el('div',{className:'dcr-legend-section'},
el('h4',null,TEXT.legendBoundary),
el('div',{className:'dcr-legend-row'},el('span',{className:'dcr-swatch dcr-swatch-boundary'}),el('span',null,'外部边界：虚线框 / 虚线边')),
el('div',{className:'dcr-legend-row'},el('span',{className:'dcr-swatch dcr-swatch-exception'}),el('span',null,'异常返回：红色实线')),
el('div',{className:'dcr-legend-row'},el('span',{className:'dcr-swatch dcr-swatch-ai'}),el('span',null,TEXT.legendAi+'：'+TEXT.aiSummaryGap))
),
el('div',{className:'dcr-legend-section'},
el('h4',null,TEXT.legendObserved),
el('div',{className:'dcr-legend-row'},el(EvidenceBadge,{value:'observed'}),el('span',null,TEXT.legendObservedRow)),
el('div',{className:'dcr-legend-row'},el('span',{className:'dcr-swatch dcr-swatch-observed'}),el('span',null,'运行台账记录：scenario_id / generation / call_id'))
),
el('div',{className:'dcr-legend-section'},
el('h4',null,TEXT.legendGroups),
el('div',{className:'dcr-legend-row'},el('span',{className:'dcr-swatch dcr-swatch-group'}),el('span',null,TEXT.legendGroupRow)),
el('div',{className:'dcr-legend-row'},el('span',{className:'dcr-swatch dcr-swatch-blackbox'}),el('span',null,TEXT.legendBlackboxRow))
)
);
}
function InterfaceLibrary(props){
var payload=props.state==='ready'&&isRecord(props.payload)?normalizeInterfaces(props.payload):null;
var candidates=payload===null?[]:payload.candidates;
var boundaries=payload===null?[]:payload.external_boundaries;
function sideEffectLines(candidate){
var lines=[];
for(var index=0;index<candidate.field_accesses.length;index+=1){
var access=candidate.field_accesses[index];
if(access.access==='read')continue;
lines.push(accessLabel(access.access)+' '+(access.field_name||'字段')+' @ '+formatLocation(access.location.file,access.location.line));
}
return lines;
}
function renderCandidate(candidate){
var added=props.addedInterfaces[candidate.interface_id]!==undefined&&props.addedInterfaces[candidate.interface_id]!==null;
var reasons=candidate.reasons.map(function(reason){
return el('span',{key:reason.code,className:'dcr-chip'},reason.label||reason.code);
});
var effects=sideEffectLines(candidate);
var guards=candidate.input_guards.map(function(guard,index){
return el('span',{key:guard.callsite_id||String(index),className:'dcr-meta'},'guard '+formatLocation(guard.file,guard.line)+' · '+truncateLabel(guard.expression,80));
});
return el('article',{
key:candidate.interface_id,
className:'dcr-interface-card',
'data-interface-candidate':candidate.interface_id,
'data-interface-id':candidate.interface_id,
'data-interface-card':'',
'aria-label':'接口候选 '+candidate.name,
},
el('div',{className:'dcr-section-head'},
el('strong',null,candidate.name),
el(EvidenceBadge,{value:candidate.certainty}),
el('span',{className:'dcr-chip'},INTERFACE_DECOUPLING_LABELS[candidate.decoupling]||candidate.decoupling),
el('span',{className:'dcr-meta'},TEXT.interfaceCallCount+' '+numberText(candidate.call_count))
),
el('p',{className:'dcr-meta'},TEXT.interfaceSignature+' '+String(candidate.signature||'—')+(candidate.return_type!==null?' · '+TEXT.interfaceReturn+' '+candidate.return_type:'')),
el('p',{className:'dcr-meta'},TEXT.interfaceParameters+'：'+(candidate.parameters.length>0?candidate.parameters.map(function(parameter){return parameter.name+':'+parameter.type;}).join('，'):'—')),
el('p',{className:'dcr-meta'},formatLocation(candidate.file,candidate.line)),
reasons.length>0?el('p',{className:'dcr-meta'},TEXT.interfaceReasons+'：',reasons):null,
el('p',{className:'dcr-meta'},TEXT.interfaceEffects+'：'+(effects.length>0?effects.join('；'):'无写类副作用')),
guards.length>0?el('p',{className:'dcr-meta'},TEXT.interfaceGuards+'：',guards):null,
candidate.limitations.length>0?el('p',{className:'dcr-muted'},'局限：'+candidate.limitations.join('、')):null,
el('div',{className:'dcr-header-actions'},
el('button',{
type:'button',
className:'dcr-btn'+(added?'':' dcr-btn-primary'),
'data-interface-action':added?'remove':'add',
'data-interface-id':candidate.interface_id,
onClick:function(){if(added)props.onRemove(candidate);else props.onAdd(candidate);},
},added?TEXT.interfaceRemove:TEXT.interfaceAdd)
)
);
}
return el('section',{
className:'dcr-section dcr-interface-library',
'data-code-view':'interface-library',
'aria-label':TEXT.interfaceLibrary,
},
el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-subheading'},TEXT.interfaceLibrary+(candidates.length>0?'（'+String(candidates.length)+'）':'')),
el('button',{
type:'button',
className:'dcr-btn',
'data-interface-library-toggle':'',
'aria-expanded':props.open?'true':'false',
onClick:props.onToggle,
},props.open?'收起':'展开')
),
props.open===true
?el('div',{className:'dcr-interface-list'},
props.state==='loading'?el('p',{className:'dcr-muted',role:'status'},TEXT.interfaceLoading)
:props.state==='error'?el('p',{className:'dcr-error'},TEXT.interfaceFailed)
:candidates.length===0?el('p',{className:'dcr-muted'},TEXT.interfaceEmpty)
:candidates.map(renderCandidate),
boundaries.length>0
?el('div',{className:'dcr-external-boundaries'},
el('h4',{className:'dcr-subheading'},TEXT.interfaceExternal),
boundaries.map(function(boundary){
return el('div',{key:boundary.callee,className:'dcr-edge','data-external-boundary':boundary.callee},
el('span',{className:'dcr-chip'},TEXT.externalBoundary),
el('span',{className:'dcr-meta'},boundary.callee+' · 调用 '+numberText(boundary.call_count)+' 次')
);
})
)
:null,
payload!==null&&payload.truncated===true?el('p',{className:'dcr-muted'},'候选列表已截断（预算限制）。'):null,
el('p',{className:'dcr-muted'},TEXT.interfaceAddHint)
)
:null
);
}
function stubRoleLabel(role){
if(role==='entry')return TEXT.stubRoleEntry;
if(role==='stub_control')return TEXT.stubRoleStub;
return TEXT.stubRoleUtil;
}
function findStubInterface(profile,name){
if(profile===null||profile===undefined)return null;
for(var index=0;index<profile.interfaces.length;index+=1){
if(profile.interfaces[index].name===name)return profile.interfaces[index];
}
return null;
}
function findStubProfile(stub,profileId){
var payload=stub.profiles?stub.profiles.payload:null;
if(payload===null||!Array.isArray(payload.profiles))return null;
for(var index=0;index<payload.profiles.length;index+=1){
if(payload.profiles[index].profile_id===profileId)return payload.profiles[index];
}
return null;
}
function stubArgInvalid(value,param){
if(value===null||value===undefined||!Number.isInteger(value))return true;
if(param.min!==null&&value<param.min)return true;
if(param.max!==null&&value>param.max)return true;
return false;
}
function stubValidation(profile,stub){
var errors=[];
if(profile===null){
errors.push({code:'NO_PROFILE',message:TEXT.stubNoProfile});
return{errors:errors,steps:[]};
}
var limit=profile.limits&&profile.limits.steps?Math.min(MAX_STUB_STEPS,profile.limits.steps):MAX_STUB_STEPS;
var steps=Array.isArray(stub.steps)?stub.steps:[];
if(steps.length===0)errors.push({code:'INVALID_ARGUMENT',message:TEXT.stubSelectInterfaceFirst});
if(steps.length>limit)errors.push({code:'LIMIT_EXCEEDED',message:'步骤数超过上限 '+String(limit)+'。'});
var normalized=[];
for(var index=0;index<steps.length;index+=1){
var step=steps[index];
var iface=findStubInterface(profile,step.interface);
if(iface===null){
errors.push({code:'INVALID_ARGUMENT',message:'第 '+String(index+1)+' 步：'+TEXT.stubSelectInterfaceFirst});
continue;
}
if(step.args.length!==iface.params.length){
errors.push({code:'INVALID_ARGUMENT',message:'第 '+String(index+1)+' 步 '+iface.name+' 参数个数不匹配。'});
continue;
}
var args=[];
for(var pi=0;pi<iface.params.length;pi+=1){
var value=step.args[pi];
if(stubArgInvalid(value,iface.params[pi])){
errors.push({code:'INVALID_ARGUMENT',message:'第 '+String(index+1)+' 步 '+iface.name+'.'+iface.params[pi].name+'：'+TEXT.stubInvalidArg});
continue;
}
args.push(value);
}
normalized.push({interface:iface.name,args:args});
}
if(errors.length>0)return{errors:errors,steps:normalized};
return{errors:errors,steps:normalized};
}
function stubGapList(stub,profile,statusData){
var gaps=[];
var serverReasons={};
if(isRecord(statusData)&&Array.isArray(statusData.gaps)){
for(var sgi=0;sgi<statusData.gaps.length;sgi+=1){
var serverGap=statusData.gaps[sgi];
if(isRecord(serverGap)&&typeof serverGap.code==='string'&&typeof serverGap.reason==='string')serverReasons[serverGap.code]=serverGap.reason;
}
}
if(stub.profiles.state==='error')gaps.push({code:'sim_profile_read_failed',status:'unavailable',reason:TEXT.stubProfilesFailed});
if((stub.profiles.state==='ready'||stub.profiles.state==='empty')&&(stub.profiles.payload===null||stub.profiles.payload.profiles.length===0))gaps.push({code:'sim_profile_missing',status:'unavailable',reason:TEXT.stubProfilesEmpty});
if(profile!==null&&profile!==undefined&&profile.interfaces.length===0)gaps.push({code:'stub_profile_interfaces_unavailable',status:'unavailable',reason:'模拟 profile 未返回接口定义（仅 interface_count，无法生成 role/参数下拉）；需 Host/引擎在 listProfiles 返回 interfaces，不伪造接口。'});
var statusCapabilities=isRecord(statusData)&&isRecord(statusData.capabilities)?statusData.capabilities:{};
var deferredGaps=[
{code:'scenario_undo',capability:'scenario_undo',fallback:'回退末尾 N 次/前缀重放未开启。'},
{code:'trace_import',capability:'trace_import',fallback:'轨迹导入未开启。'},
{code:'real_device_dispatch',capability:'real_device_dispatch',fallback:'真实设备/内核下发需单独授权与运行验证；编译器/构建未启用（不在插件内编译）；S3a 只在隔离 Wasm worker 中模拟。'}
];
for(var dgi=0;dgi<deferredGaps.length;dgi+=1){
if(statusCapabilities[deferredGaps[dgi].capability]===true)continue;
var reason=serverReasons[deferredGaps[dgi].code]||deferredGaps[dgi].fallback;
if(deferredGaps[dgi].code==='real_device_dispatch'&&!/编译器|构建/.test(reason))reason=reason+'；编译器/构建未启用（不在插件内编译）';
gaps.push({code:deferredGaps[dgi].code,status:'unavailable',reason:reason});
}
if(stub.runError!==null&&stub.runError!==undefined&&stub.runError.code==='OUTCOME_UNKNOWN')gaps.push({code:'scenario_outcome_unknown',status:'unknown',reason:TEXT.stubGapUnknownReason});
return gaps;
}
function StubPanel(props){
var stub=props.stub;
var profilesPayload=stub.profiles.state==='ready'?stub.profiles.payload:null;
var profiles=profilesPayload===null?[]:profilesPayload.profiles;
var profile=findStubProfile(stub,stub.profileId);
var steps=Array.isArray(stub.steps)?stub.steps:[];
var limit=profile!==null&&profile.limits&&profile.limits.steps?Math.min(MAX_STUB_STEPS,profile.limits.steps):MAX_STUB_STEPS;
var gaps=stubGapList(stub,profile,props.status);
var latest=stub.latest;
var records=latest===null||latest===undefined?[]:latest.records;
var failedIndex=-1;
for(var ri=0;ri<records.length;ri+=1){
if(records[ri].status==='error'&&failedIndex<0)failedIndex=records[ri].step_index===null?-1:records[ri].step_index;
}
function renderStep(step,index){
var iface=findStubInterface(profile,step.interface);
var boundary=iface!==null&&iface.role==='stub_control';
return el('div',{key:'step-'+String(index),className:'dcr-stub-step'+(boundary?' dcr-stub-step-boundary':''),'data-stub-step':'','data-step-index':String(index)},
el('div',{className:'dcr-stub-step-head'},
el('span',{className:'dcr-chip'},'#'+String(index+1)),
boundary?el('span',{className:'dcr-chip dcr-stub-boundary-chip'},TEXT.stubRoleStub):null
),
el('select',{className:'dcr-select','data-step-interface':String(index),'aria-label':'步骤接口','value':step.interface,onChange:function(event){props.onStepInterface(index,event&&event.target?event.target.value:'');}},
el('option',{value:''},TEXT.stubStepInterface+'…'),
SIM_ROLES.map(function(role){
var list=profile===null?[]:profile.interfaces.filter(function(item){return item.role===role;});
if(list.length===0)return null;
return el('optgroup',{key:role,label:stubRoleLabel(role)},list.map(function(item){
return el('option',{key:item.name,value:item.name},item.name+(item.role==='entry'?' · 入口':''));
}));
})
),
iface!==null?el('div',{className:'dcr-stub-args'},iface.params.map(function(param,pi){
var value=step.args[pi];
var invalid=stubArgInvalid(value,param);
return el('label',{key:'arg-'+String(pi),className:'dcr-stub-arg'},
el('span',{className:'dcr-meta'},param.name+':'+param.type+(param.min!==null&&param.max!==null?' ['+String(param.min)+','+String(param.max)+']':'')),
el('input',{type:'number',className:'dcr-stub-arg-input'+(invalid?' dcr-stub-invalid':''),'data-step-arg':String(index)+':'+String(pi),'data-step-index':String(index),min:param.min===null?undefined:String(param.min),max:param.max===null?undefined:String(param.max),step:'1',value:value===null||value===undefined?'':String(value),onChange:function(event){props.onStepArg(index,pi,event&&event.target?event.target.value:'');}})
);
})):null,
boundary?el('p',{className:'dcr-meta dcr-stub-boundary-note'},TEXT.stubBoundaryHint):null,
el('div',{className:'dcr-stub-step-actions'},
el('button',{type:'button',className:'dcr-btn','data-step-move-up':String(index),disabled:index===0,onClick:function(){props.onMoveStep(index,-1);}},TEXT.stubStepUp),
el('button',{type:'button',className:'dcr-btn','data-step-move-down':String(index),disabled:index===steps.length-1,onClick:function(){props.onMoveStep(index,1);}},TEXT.stubStepDown),
el('button',{type:'button',className:'dcr-btn','data-step-remove':String(index),onClick:function(){props.onRemoveStep(index);}},TEXT.stubStepRemove)
)
);
}
function renderRecord(record){
var stubbed=record.stubbed===true;
return el('div',{key:record.call_id||('step-'+String(record.step_index)),className:'dcr-stub-record'+(stubbed?' dcr-stub-record-stubbed':''),'data-stub-record':'','data-call-id':record.call_id||'','data-status':record.status,'data-step-index':record.step_index===null?'':String(record.step_index),'data-result':record.result===null?undefined:String(record.result),'data-stubbed':stubbed?'true':undefined,tabIndex:0,role:'button',onClick:function(){props.onJumpRecord(record,null);},onKeyDown:function(event){if(event.key==='Enter'||event.key===' '){if(event.preventDefault)event.preventDefault();props.onJumpRecord(record,null);}}},
el('div',{className:'dcr-stub-record-head'},
el('span',{className:'dcr-chip'},'#'+String((record.step_index===null?0:record.step_index)+1)+' step '+String(record.step_index===null?0:record.step_index)+' '+record.interface+'('+record.args.join(', ')+')'),
el('span',{className:'dcr-chip dcr-stub-status-'+record.status},TEXT.stubRecordStatus+' '+record.status),
el('span',{className:'dcr-meta'},TEXT.stubRecordResult+' '+(record.result===null?'—':String(record.result))),
stubbed?el('span',{className:'dcr-chip dcr-stub-boundary-chip'},TEXT.stubStubbed):null,
el('span',{className:'dcr-meta dcr-stub-digest',title:String(record.memory_digest||'')},TEXT.stubMemoryDigest+' '+String(record.memory_digest||'—'))
),
record.events.length>0?el('div',{className:'dcr-stub-events'},record.events.map(function(event,eventIndex){
return el('button',{key:event.event_id||String(eventIndex),type:'button',className:'dcr-chip dcr-stub-event','data-stub-event':event.event_id||event.event,'data-event-kind':event.event,title:event.event+' code='+String(event.code===null?'—':event.code)+' a='+String(event.a===null?'—':event.a)+' b='+String(event.b===null?'—':event.b)+' c='+String(event.c===null?'—':event.c)+' line='+String(event.line===null?'—':event.line),onClick:function(eventClick){if(eventClick&&eventClick.stopPropagation)eventClick.stopPropagation();props.onJumpRecord(record,event);}},event.event+(event.line===null?'':'@'+String(event.line))+' #'+String(event.code===null?'—':event.code));
})):null,
record.affected_resources.length>0?el('div',{className:'dcr-stub-affects'},record.affected_resources.map(function(resource){
return el('span',{key:resource.resource_id,className:'dcr-chip dcr-stub-affect','data-stub-affect':resource.resource_id,'data-resource-id':resource.resource_id,'data-access':resource.access},resource.name+' · '+accessLabel(resource.access));
})):null,
record.status==='error'?el('p',{className:'dcr-error dcr-stub-record-error'},record.error_message||('返回 '+String(record.result===null?'—':record.result))):null
);
}
var recordRows=records.map(renderRecord);
if(stub.stopOnError===true&&failedIndex>=0){
for(var si=failedIndex+1;si<steps.length;si+=1){
recordRows.push(el('div',{key:'skipped-'+String(si),className:'dcr-stub-record dcr-stub-record-skipped','data-stub-record':'','data-call-id':'','data-status':'skipped','data-step-index':String(si)},
el('span',{className:'dcr-chip'},'#'+String(si+1)+' '+String(steps[si].interface||'—')),
el('span',{className:'dcr-meta'},TEXT.stubRecordSkipped)
));
}
}
var latestImported=latest!==null&&latest!==undefined&&latest.imported===true;
var undoMax=latestImported||latest===null||latest===undefined?0:latest.records.length;
var canUndo=latest!==null&&latest!==undefined&&!latestImported&&undoMax>=1&&stub.busy!==true&&stub.undoBusy!==true;
var undoStatusText='';
var undoStatusAttrs={className:'dcr-muted','data-stub-undo-status':''};
var undoStatus=stub.undoStatus===undefined?null:stub.undoStatus;
if(undoStatus!==null&&undoStatus!==undefined){
if(undoStatus.kind==='pending')undoStatusText=TEXT.stubUndoBusy;
else if(undoStatus.kind==='error'){
undoStatusText=TEXT.stubUndoFailed+' '+String(undoStatus.code||'UNKNOWN_ERROR')+'：'+String(undoStatus.message||'');
undoStatusAttrs.className='dcr-error';
undoStatusAttrs['data-error-code']=undoStatus.code||'UNKNOWN_ERROR';
}else if(undoStatus.kind==='success'){
undoStatusText=TEXT.stubUndoSuccess+' '+String(undoStatus.count)+' 步：前缀重放状态摘要一致（scenario '+String(undoStatus.scenarioId||'—')+' generation '+String(undoStatus.generation===null||undoStatus.generation===undefined?'—':undoStatus.generation)+'）';
}
}else if(latestImported)undoStatusText=TEXT.stubUndoImported;
else if(latest===null||latest===undefined)undoStatusText=TEXT.stubUndoNoLedger;
else undoStatusText='可回退 1..'+String(undoMax)+' 步（前缀重放并核验 memory digest）。';
var undoSection=el('div',{className:'dcr-stub-section'},
el('h3',{className:'dcr-subheading'},TEXT.stubUndoTitle),
el('div',{className:'dcr-stub-undobar'},
el('label',{className:'dcr-stub-check'},TEXT.stubUndoCount+' ',
el('input',{type:'number',className:'dcr-stub-arg-input','data-stub-undo-count':'',min:'1',max:undoMax>=1?String(undoMax):'1',step:'1',value:String(stub.undoCount===null||stub.undoCount===undefined?1:stub.undoCount),disabled:!canUndo||stub.undoBusy===true,onChange:function(event){props.onUndoCount(event&&event.target?event.target.value:'');}})),
el('button',{type:'button',className:'dcr-btn','data-stub-undo':'',disabled:!canUndo,onClick:props.onUndo},stub.undoBusy===true?TEXT.stubUndoBusy:TEXT.stubUndo)
),
el('p',undoStatusAttrs,undoStatusText),
el('p',{className:'dcr-muted'},TEXT.stubUndoHint)
);
var traceStatus=stub.traceStatus===undefined?null:stub.traceStatus;
var traceStatusText='';
var traceStatusAttrs={className:'dcr-muted','data-trace-import-status':''};
if(traceStatus!==null&&traceStatus!==undefined){
if(traceStatus.kind==='pending')traceStatusText=TEXT.traceImportBusy;
else if(traceStatus.kind==='error'){
traceStatusText=TEXT.traceImportFailed+' '+String(traceStatus.code||'UNKNOWN_ERROR')+'：'+String(traceStatus.message||'');
traceStatusAttrs.className='dcr-error';
traceStatusAttrs['data-error-code']=traceStatus.code||'UNKNOWN_ERROR';
}else if(traceStatus.kind==='success'){
traceStatusText=TEXT.traceImportSuccess+'scenario '+String(traceStatus.scenarioId||'—')+' generation '+String(traceStatus.generation===null||traceStatus.generation===undefined?'—':traceStatus.generation)+(traceStatus.label?'（'+String(traceStatus.label)+'）':'');
}
}
var traceSection=el('div',{className:'dcr-stub-section dcr-stub-trace'},
el('h3',{className:'dcr-subheading'},TEXT.traceTitle),
el('p',{className:'dcr-muted'},TEXT.traceHint),
el('div',{className:'dcr-stub-runbar'},
el('input',{type:'text',className:'dcr-graph-search','data-trace-import-input':'',placeholder:TEXT.traceInputPlaceholder,'aria-label':TEXT.traceTitle,value:stub.traceInput===undefined||stub.traceInput===null?'':stub.traceInput,disabled:stub.traceBusy===true,onChange:function(event){props.onTraceInput(event&&event.target?event.target.value:'');}}),
el('button',{type:'button',className:'dcr-btn','data-trace-import':'',disabled:stub.traceBusy===true||props.workspaceReady!==true||String(stub.traceInput===undefined||stub.traceInput===null?'':stub.traceInput).trim()==='',onClick:props.onTraceImport},stub.traceBusy===true?TEXT.traceImportBusy:TEXT.traceImport)
),
el('p',traceStatusAttrs,traceStatusText)
);
var profileOptions=[el('option',{key:'none',value:''},'（未选择）')];
for(var poi=0;poi<profiles.length;poi+=1){
profileOptions.push(el('option',{key:profiles[poi].profile_id,value:profiles[poi].profile_id},profiles[poi].label+' · '+profiles[poi].profile_id));
}
return el('div',{className:'dcr-stub dcr-stub-panel','data-code-view':'stub-panel','data-stub-panel':'','data-busy':stub.busy===true?'true':'false'},
el('h3',{className:'dcr-subheading'},TEXT.stubPanelTitle),
el('p',{className:'dcr-muted'},TEXT.stubHint),
props.workspaceReady!==true?el('p',{className:'dcr-warning'},'请先在「快照与入口」选择已核验快照；打桩模拟按快照绑定执行。'):null,
el('div',{className:'dcr-stub-section'},
el('label',{className:'dcr-subheading'},TEXT.stubProfileTitle+' ',
el('select',{className:'dcr-select','data-stub-profile':'','aria-label':TEXT.stubProfileTitle,value:stub.profileId||'',disabled:stub.busy,onChange:function(event){props.onSelectProfile(event&&event.target?event.target.value:null);}},profileOptions)
),
stub.profiles.state==='loading'?el('p',{className:'dcr-muted',role:'status'},TEXT.stubProfilesLoading):null,
stub.profiles.state==='error'?el('p',{className:'dcr-error'},TEXT.stubProfilesFailed):null,
stub.profiles.state==='ready'&&profiles.length===0?el('p',{className:'dcr-muted'},TEXT.stubProfilesEmpty):null,
stub.profiles.state==='empty'?el('p',{className:'dcr-muted'},TEXT.stubProfilesEmpty):null,
profile!==null?el('div',{className:'dcr-stub-profile-facts'},
el('span',{className:'dcr-chip'},profile.label),
el('span',{className:'dcr-meta'},'binding '+String(profile.binding.workspace_id||'—')+' / '+String(profile.binding.variant_id||'—')+' / '+String(profile.binding.repo_id||'—')+' / '+String(profile.binding.snapshot_id||'—')),
el('span',{className:'dcr-meta'},'module sha256 '+shortDigest(profile.module.sha256)+(profile.module.bytes!==null?' · '+numberText(profile.module.bytes)+' B':'')),
el('span',{className:'dcr-meta'},'接口 '+(profile.interfaces.length>0?String(profile.interfaces.length):(profile.interface_count!==null?'定义未随列表提供（'+String(profile.interface_count)+'，需 Host/引擎补充 interfaces）':'—'))+' · limits timeout '+(profile.limits.timeout_ms===null?'—':String(profile.limits.timeout_ms)+' ms')+' · steps '+(profile.limits.steps===null?'—':String(profile.limits.steps))+' · events/step '+(profile.limits.events_per_step===null?'—':String(profile.limits.events_per_step))),
profile.limitations.length>0?el('span',{className:'dcr-muted'},'局限：'+profile.limitations.join('、')):null
):el('p',{className:'dcr-muted'},TEXT.stubNoProfile)
),
profile!==null&&profile.interfaces.length>0?el('div',{className:'dcr-stub-section','data-stub-editor':''},
el('h3',{className:'dcr-subheading'},TEXT.stubStepsTitle+'（'+String(steps.length)+'/'+String(limit)+'）'),
steps.map(renderStep),
el('div',{className:'dcr-stub-step-actions'},
el('button',{type:'button',className:'dcr-btn','data-stub-add-step':'',disabled:stub.busy||steps.length>=limit,onClick:props.onAddStep},TEXT.stubStepAdd),
el('label',{className:'dcr-stub-check'},el('input',{type:'checkbox','data-stub-stop-on-error':'','checked':stub.stopOnError===true,disabled:stub.busy,onChange:props.onToggleStopOnError}),' '+TEXT.stubStopOnError)
),
):null,
el('div',{className:'dcr-stub-section dcr-stub-run-section'},
el('p',{className:'dcr-muted'},TEXT.stubRunHint),
el('div',{className:'dcr-stub-runbar'},
el('button',{type:'button',className:'dcr-btn dcr-btn-primary','data-stub-run':'',disabled:stub.busy===true||profile===null||profile.interfaces.length===0||props.workspaceReady!==true,onClick:props.onRun},stub.busy===true?TEXT.stubRunBusy:TEXT.stubRun),
profile!==null&&stub.plan!==null&&stub.plan!==undefined?el('span',{className:'dcr-chip','data-stub-plan':''},TEXT.stubPlan+' '+shortDigest(stub.plan.plan_id)+' · 代次 '+String(stub.plan.generation===null?'—':stub.plan.generation)+' · timeout '+(stub.plan.limits.timeout_ms===null?'—':String(stub.plan.limits.timeout_ms)+' ms')):null
),
profile===null?el('p',{className:'dcr-muted'},TEXT.stubNoProfile):null,
stub.runError!==null&&stub.runError!==undefined?el('p',{className:'dcr-error','data-stub-error':'','data-error-code':stub.runError.code},TEXT.stubRunFailed+' '+String(stub.runError.code)+'：'+String(stub.runError.message)):null
),
stub.latest!==null&&stub.latest!==undefined?el('div',{className:'dcr-stub-section dcr-stub-records','data-stub-records':''},
el('h3',{className:'dcr-subheading'},TEXT.stubRecordsTitle),
el('div',{className:'dcr-stub-generation','data-stub-generation':''},
el('span',{className:'dcr-chip'},TEXT.stubScenarioId+' '+String(stub.latest.scenario_id||'—')),
el('span',{className:'dcr-chip'},TEXT.stubGeneration+' '+String(stub.latest.generation===null?'—':stub.latest.generation)),
el('span',{className:'dcr-meta'},'records_digest '+shortDigest(stub.latest.records_digest)),
el('span',{className:'dcr-meta'},'profile '+String(stub.latest.profile_id||'—')),
latest.imported===true?el('span',{className:'dcr-chip'},'imported · '+String(latest.label||'导入轨迹')):null,
latest.imported===true?el('p',{className:'dcr-muted','data-stub-imported-limitations':''},'导入台账局限：'+latest.limitations.join('、')):null,
stub.latest.undo!==null&&stub.latest.undo!==undefined?el('span',{className:'dcr-chip'},'undo · count '+String(stub.latest.undo.count===null?'—':stub.latest.undo.count)+' · digest verified '+(stub.latest.undo.state_digest_verified?'true':'false')):null
),
recordRows.length===0?el('p',{className:'dcr-muted'},TEXT.stubRecordsEmpty):recordRows
):el('p',{className:'dcr-muted'},TEXT.stubRecordsEmpty),
undoSection,
traceSection,
gaps.length>0?el('div',{className:'dcr-stub-gaps'},gaps.map(function(gap){
return el('p',{key:gap.code,className:'dcr-muted dcr-stub-gap','data-stub-gap':gap.code},el('code',null,gap.code),' '+String(gap.reason||''));
})):null
);
}
function RailPanel(props){
var resources=Array.isArray(props.resources)?props.resources:[];
var related=[];
var others=[];
var focusFunctionIds={};
if(props.entryId!==null)focusFunctionIds[props.entryId]=true;
if(props.selectedFunctionId!==null)focusFunctionIds[props.selectedFunctionId]=true;
resources.forEach(function(resource){
var isRelated=false;
for(var index=0;index<resource.related_function_ids.length;index+=1){
if(focusFunctionIds[resource.related_function_ids[index]]===true)isRelated=true;
}
if(resource.accesses){
for(var ai=0;ai<resource.accesses.length;ai+=1){
if(resource.accesses[ai].function_id!==null&&focusFunctionIds[resource.accesses[ai].function_id]===true)isRelated=true;
}
}
if(isRelated)related.push(resource);
else others.push(resource);
});
function renderRows(list,emptyText){
if(list.length===0)return el('p',{className:'dcr-muted'},emptyText);
return el('div',{className:'dcr-list',role:'list','aria-label':TEXT.railResources},list.map(function(resource){
var selected=props.focusResourceId===resource.resource_id;
var directions={};
resource.accesses.forEach(function(access){directions[access.access]=(directions[access.access]||0)+1;});
return el('button',{
key:resource.resource_id,
type:'button',
role:'listitem',
className:'dcr-resource-row'+(selected?' dcr-selected':'')+(list===related?' dcr-related':''),
'data-resource-row':resource.resource_id,
'data-resource-id':resource.resource_id,
'aria-pressed':selected?'true':'false',
onClick:function(){props.onSelectResource(resource);},
},
el('strong',null,resource.name),
el('span',{className:'dcr-meta'},(resource.type||'类型未提供')+(resource.storage?' · '+resource.storage:'')+(resource.file!==null?' · '+formatLocation(resource.file,resource.line):' · 定义位置待复核')),
resource.fields.length>0?el('span',{className:'dcr-meta'},'字段：'+resource.fields.map(function(field){return field.field_name;}).join('、')):el('span',{className:'dcr-muted'},'字段说明待复核（缺口）'),
el('span',{className:'dcr-resource-tags'},ACCESS_VALUES.filter(function(key){return directions[key]>0;}).map(function(key){
return el('span',{key:key,className:'dcr-chip dcr-access-chip dcr-access-'+key},accessLabel(key)+' '+String(directions[key]));
}))
);
}));
}
var stubProps=assign({stub:props.stub,workspaceReady:props.workspaceReady,status:props.status},props.stubHandlers);
var modeContent=props.mode==='stub'
?el(StubPanel,stubProps)
:el('div',{className:'dcr-rail-pane'},
el('h3',{className:'dcr-subheading'},TEXT.railResources),
el('p',{className:'dcr-muted'},TEXT.resourceRelated+' · '+String(related.length)+' 项'),
renderRows(related,'暂无直接相关资源。'),
el('p',{className:'dcr-muted'},TEXT.resourceOther+' · '+String(others.length)+' 项'),
renderRows(others,'暂无其他资源。')
);
return el('aside',{className:'dcr-rail','data-rail-group':'','aria-label':TEXT.railLabel},
el('div',{className:'dcr-rail-tabs'},
el('button',{
type:'button',
className:'dcr-btn'+(props.mode==='resources'?' dcr-btn-selected':''),
'data-rail':'resources',
'aria-pressed':props.mode==='resources'?'true':'false',
onClick:function(){props.onSelectMode('resources');},
},TEXT.railResources),
el('button',{
type:'button',
className:'dcr-btn'+(props.mode==='stub'?' dcr-btn-selected':''),
'data-rail':'stub',
'aria-pressed':props.mode==='stub'?'true':'false',
onClick:function(){props.onSelectMode('stub');},
},TEXT.railStub)
),
modeContent,
el(InterfaceLibrary,{
state:props.interfaces.state,
payload:props.interfaces.payload,
open:props.libraryOpen,
addedInterfaces:props.addedInterfaces,
onToggle:props.onToggleLibrary,
onAdd:props.onAddInterface,
onRemove:props.onRemoveInterface,
})
);
}
function GapList(props){
var gaps=Array.isArray(props.gaps)?props.gaps:[];
return el('section',{className:'dcr-section'},
el('h3',{className:'dcr-heading'},TEXT.gapsTitle+'（'+String(gaps.length)+'）'),
el('div',{'data-code-view':'gaps',className:'dcr-gaps'},
gaps.length===0
?el('p',{className:'dcr-muted'},TEXT.gapsEmpty)
:gaps.map(function(gap,index){
return el('div',{key:gap.code+'-'+String(index),className:'dcr-gap','data-gap-code':gap.code},
el('code',{className:'dcr-gap-code','data-code-view':'gap-code'},gap.code),
' ',
el('span',{className:'dcr-chip'},'状态 '+gap.status),
' ',
el('span',{className:'dcr-gap-reason'},gap.reason||'（无原因文本）')
);
})
)
);
}
function SelectionBlock(props){
return el('section',{className:'dcr-section'},
el('h3',{className:'dcr-heading'},TEXT.selectionTitle),
el('p',{className:'dcr-muted'},TEXT.linksHint),
el('pre',{className:'dcr-selection','data-code-view':'selection','aria-label':'共享选择 Selection JSON'},JSON.stringify(props.selection,null,2))
);
}
function SourceView(props){
var source=props.source;
if(!isRecord(source)){
return el('section',{className:'dcr-section','data-code-view':'source'},
el('h3',{className:'dcr-heading'},TEXT.sourceTitle),
el('p',{className:'dcr-muted'},TEXT.sourceMissing)
);
}
var lines=Array.isArray(source.lines)?source.lines:[];
var header=el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},TEXT.sourceTitle),
source.status==='ok'?el(EvidenceBadge,{value:'source_text'}):null,
el('span',{className:'dcr-meta'},formatLocation(source.path,source.line_start)+(toInteger(source.line_end)!==null?'–'+String(source.line_end):'')),
source.truncated===true?el('span',{className:'dcr-chip'},'已截断'):null
);
if(source.status!=='ok'||lines.length===0){
return el('section',{className:'dcr-section','data-code-view':'source'},
header,
el('p',{className:'dcr-muted'},TEXT.sourceUnavailable+(copyNullableString(source.reason)||'source.status='+String(source.status||'unknown')))
);
}
var highlight=isRecord(source.highlight)?source.highlight:{line_start:source.line_start,line_end:source.line_end};
var highlightStart=toInteger(highlight.line_start);
var highlightEnd=toInteger(highlight.line_end);
return el('section',{className:'dcr-section','data-code-view':'source'},
header,
el('p',{className:'dcr-meta'},'证据区间 字节 '+numberText(source.byte_start)+'–'+numberText(source.byte_end)+' · sha256 '+shortDigest(source.sha256)),
el('div',{className:'dcr-code',role:'list','aria-label':'源码 '+String(source.path||'')},lines.map(function(line,index){
var lineNumber=isRecord(line)?toInteger(line.n):null;
var lineText=isRecord(line)&&typeof line.text==='string'?line.text:'';
var highlighted=lineNumber!==null&&highlightStart!==null&&highlightEnd!==null&&lineNumber>=highlightStart&&lineNumber<=highlightEnd;
var lineProps={key:index,className:'dcr-line'+(highlighted?' dcr-line-hit':''),role:'listitem'};
if(lineNumber!==null)lineProps['data-line']=String(lineNumber);
if(highlighted)lineProps['data-highlight']='true';
return el('div',lineProps,
el('span',{className:'dcr-line-no','aria-hidden':'true'},lineNumber===null?'':String(lineNumber)),
el('span',{className:'dcr-line-text'},lineText)
);
}))
);
}
function EdgeList(props){
var edges=Array.isArray(props.edges)?props.edges:[];
var heading=String(props.title)+'（'+String(edges.length)+'）'+(props.truncated===true?' 已截断':'');
return el('section',{className:'dcr-section'},
el('h3',{className:'dcr-heading'},heading),
edges.length===0
?el('p',{className:'dcr-muted'},String(props.emptyText||''))
:el('ul',{className:'dcr-edges','aria-label':props.title},edges.map(function(edge,index){
if(!isRecord(edge))return null;
var certainty=normalizeEdgeCertainty(edge.certainty);
var callsite=isRecord(edge.callsite)?edge.callsite:{};
var neighbor=isRecord(edge.target)?edge.target:(isRecord(edge.source)?edge.source:{});
var evidenceIds=Array.isArray(edge.evidence_ids)?edge.evidence_ids:[];
var limitations=Array.isArray(edge.limitations)?edge.limitations:[];
return el('li',{
key:copyNullableString(edge.edge_id)||'edge-'+String(index),
className:'dcr-edge',
'data-callsite-id':copyNullableString(edge.callsite_id)||undefined,
},
el(EvidenceBadge,{value:certainty}),
' ',
el('span',{className:'dcr-chip'},'确定性 '+certainty),
' ',
el('span',{className:'dcr-chip'},'来源 '+String(edge.origin||'unknown')),
' ',
el('span',{className:'dcr-meta'},'调用点 '+formatLocation(callsite.file,callsite.line)+(copyNullableString(callsite.expression)!==null?' · '+String(callsite.expression):'')),
' ',
el('span',{className:'dcr-meta'},'目标 '+String(neighbor.name||neighbor.display_name||'未知')+(copyNullableString(neighbor.file)!==null?'（'+formatLocation(neighbor.file,neighbor.line)+'）':'')),
' ',
el('span',{className:'dcr-meta'},'证据 '+(evidenceIds.length>0?evidenceIds.join('、'):'无')),
limitations.length>0?el('span',{className:'dcr-muted'},' 限制 '+limitations.join('、')):null
);
}))
);
}
function ResourceSection(props){
var resources=props.resources;
if(!isRecord(resources))return null;
var status=copyNullableString(resources.status)||'unavailable';
var reason=copyNullableString(resources.reason)||'';
var objects=Array.isArray(resources.objects)?resources.objects:[];
var accesses=Array.isArray(resources.field_accesses)?resources.field_accesses:[];
var header=el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},TEXT.resourcesTitle),
el('span',{className:'dcr-chip'},'状态 '+status),
resources.truncated===true?el('span',{className:'dcr-chip'},'已截断'):null
);
if(status==='unavailable'){
return el('section',{className:'dcr-section','data-code-view':'resources'},
header,
el('p',{className:'dcr-muted'},TEXT.resourcesUnavailable+(reason||'快照未提供 objects/field_accesses 资源层。')+'（已写入缺口区）'),
el('p',{className:'dcr-muted'},TEXT.resourcesNote)
);
}
return el('section',{className:'dcr-section','data-code-view':'resources'},
header,
reason!==''?el('p',{className:'dcr-muted'},'说明：'+reason):null,
objects.length>0
?el('div',null,
el('h4',{className:'dcr-subheading'},'对象（'+String(objects.length)+'）'),
el('ul',{className:'dcr-list','aria-label':'资源对象'},objects.map(function(object,index){
if(!isRecord(object))return null;
var resourceId=copyNullableString(object.resource_id)||'resource-'+String(index);
return el('li',{key:resourceId,className:'dcr-resource','data-resource-id':resourceId},
el('span',{className:'dcr-resource-name'},String(object.name||'（未命名）')),
' ',
el('span',{className:'dcr-meta'},'类型 '+String(object.type||'—')+' · 存储 '+String(object.storage||'—')),
' ',
el('span',{className:'dcr-meta'},'位置 '+formatLocation(object.file,object.line))
);
}))
)
:null,
accesses.length>0
?el('div',null,
el('h4',{className:'dcr-subheading'},'字段访问（'+String(accesses.length)+'）'),
el('ul',{className:'dcr-list','aria-label':'字段访问'},accesses.map(function(access,index){
if(!isRecord(access))return null;
var accessValue=normalizeAccess(access.access);
var certainty=normalizeCertainty(access.certainty);
var owner=isRecord(access.owner)?access.owner:{};
var location=isRecord(access.location)?access.location:{};
var objectNames=Array.isArray(access.object_names)?access.object_names:[];
var evidenceIds=Array.isArray(access.evidence_ids)?access.evidence_ids:[];
var limitations=Array.isArray(access.limitations)?access.limitations:[];
var accessId=copyNullableString(access.access_id)||'field-access-'+String(index);
var fieldName=copyNullableString(access.field_name)||'';
var expression=copyNullableString(access.expression)||'';
return el('li',{
key:accessId,
className:'dcr-field-access',
'data-field-access':accessId,
'data-access':accessValue,
'data-certainty':certainty,
},
el(EvidenceBadge,{value:certainty}),
' ',
el('span',{className:'dcr-chip'},'方向 '+accessLabel(accessValue)+'（'+accessValue+'）'),
' ',
el('span',{className:'dcr-meta'},'owner '+String(owner.name||'未知')+(copyNullableString(owner.file)!==null?'（'+formatLocation(owner.file,owner.line)+'）':'')),
' ',
el('span',{className:'dcr-meta'},'位置 '+formatLocation(location.file,location.line)),
' ',
el('span',{className:'dcr-meta'},'字段 '+(fieldName||'—')+(expression!==''?'（'+expression+'）':'')),
objectNames.length>0?el('span',{className:'dcr-meta'},'对象 '+objectNames.join('、')):null,
evidenceIds.length>0?el('span',{className:'dcr-meta'},'证据 '+evidenceIds.join('、')):null,
limitations.length>0?el('span',{className:'dcr-muted'},' 限制 '+limitations.join('、')):null
);
}))
)
:null,
objects.length===0&&accesses.length===0
?el('p',{className:'dcr-muted'},TEXT.resourcesEmpty)
:null
);
}
function EvidenceList(props){
var evidence=Array.isArray(props.evidence)?props.evidence:[];
return el('section',{className:'dcr-section'},
el('h3',{className:'dcr-heading'},TEXT.evidenceTitle+'（'+String(evidence.length)+'）'),
evidence.length===0
?el('p',{className:'dcr-muted'},TEXT.evidenceEmpty)
:el('ul',{className:'dcr-list','aria-label':TEXT.evidenceTitle},evidence.map(function(item,index){
if(!isRecord(item))return null;
var evidenceId=copyNullableString(item.evidence_id)||'evidence-'+String(index);
return el('li',{key:evidenceId,className:'dcr-evidence-row','data-evidence-id':evidenceId},
el('span',{className:'dcr-error-code'},evidenceId),
' ',
el('span',{className:'dcr-chip'},String(item.kind||'unknown')),
' ',
el('span',{className:'dcr-meta'},formatLocation(item.file,item.line)),
' ',
el('span',{className:'dcr-meta'},typeof item.text==='string'?item.text:''),
item.truncated===true?el('span',{className:'dcr-chip'},'已截断'):null
);
}))
);
}
function couplingConnectedFunctionIds(layout,resourceId){
var ids={};
for(var index=0;index<layout.edges.length;index+=1){
if(layout.edges[index].edge.to_resource===resourceId&&layout.edges[index].edge.from_function!==null)ids[layout.edges[index].edge.from_function]=true;
}
return ids;
}
function couplingConnectedResourceIds(layout,functionId){
var ids={};
for(var index=0;index<layout.edges.length;index+=1){
if(layout.edges[index].edge.from_function===functionId&&layout.edges[index].edge.to_resource!==null)ids[layout.edges[index].edge.to_resource]=true;
}
return ids;
}
function CouplingView(props){
var layout=couplingLayout(props.payload);
var focusResourceId=props.focusResourceId;
var selectedFunctionId=props.selectedFunctionId;
var relatedFunctions={};
var relatedResources={};
if(focusResourceId!==null){
relatedFunctions=couplingConnectedFunctionIds(layout,focusResourceId);
relatedResources[focusResourceId]=true;
}else if(selectedFunctionId!==null){
relatedResources=couplingConnectedResourceIds(layout,selectedFunctionId);
relatedFunctions[selectedFunctionId]=true;
}
function hasFocus(){return focusResourceId!==null||selectedFunctionId!==null;}
function functionNodeClass(node,role){
var classes='dcr-coupling-node dcr-function-node dcr-role-'+role;
if(selectedFunctionId!==null&&node.function_id===selectedFunctionId)classes+=' dcr-selected';
if(hasFocus())classes+=relatedFunctions[node.function_id]===true?' dcr-highlight':' dcr-dim';
return classes;
}
function renderFunctionNode(item,role){
var node=item.item;
return el('div',{
key:'fn-'+node.function_id,
className:functionNodeClass(node,role),
style:{left:item.x+'px',top:item.y+'px',width:item.w+'px',height:item.h+'px'},
'data-function-node':node.function_id,
'data-entry-id':node.function_id,
'data-function-role':role,
tabIndex:0,
role:'button',
'aria-label':'函数 '+node.name+' '+formatLocation(node.file,node.line),
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onSelectFunction(node);
},
onKeyDown:function(event){
if(event.key==='Enter'||event.key===' '){
event.preventDefault();
props.onSelectFunction(node);
}
},
},
el('span',{className:'dcr-graph-node-label'},node.name+'()'),
el('span',{className:'dcr-graph-node-sub'},formatLocation(node.file,node.line)+' · '+role+(props.entryId===node.function_id?' · 入口':'')),
node.access_summary&&(node.access_summary.exact||node.access_summary.may)?el('span',{className:'dcr-meta'},'访问 exact '+numberText(node.access_summary.exact)+' / may '+numberText(node.access_summary.may)):null
);
}
function renderResourceNode(item){
var node=item.item;
var classes='dcr-coupling-node dcr-resource-node';
if(focusResourceId!==null&&node.resource_id===focusResourceId)classes+=' dcr-selected';
if(hasFocus())classes+=relatedResources[node.resource_id]===true?' dcr-highlight':' dcr-dim';
return el('div',{
key:'resource-'+node.resource_id,
className:classes,
style:{left:item.x+'px',top:item.y+'px',width:item.w+'px',height:item.h+'px'},
'data-resource-node':node.resource_id,
'data-resource-id':node.resource_id,
tabIndex:0,
role:'button',
'aria-label':'资源 '+node.name,
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onSelectResourceNode(node);
},
onKeyDown:function(event){
if(event.key==='Enter'||event.key===' '){
event.preventDefault();
props.onSelectResourceNode(node);
}
},
},
el('span',{className:'dcr-graph-node-label'},node.name),
el('span',{className:'dcr-graph-node-sub'},(node.type||'类型未提供')+(node.storage?' · '+node.storage:'')),
node.fields.length>0?el('span',{className:'dcr-meta'},'字段：'+node.fields.map(function(field){return field.field_name;}).join('、')):el('span',{className:'dcr-meta'},'字段说明待复核'),
el('span',{className:'dcr-meta'},'写 '+numberText(node.write_count)+' / 读 '+numberText(node.read_count))
);
}
var scopeLabel=layout.data.scope.mode==='entry_neighborhood'?TEXT.couplingScopeEntry:TEXT.couplingScopeSnapshot;
return el('div',{className:'dcr-view-inner'},
el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},VIEW_LABELS.coupling),
el('span',{className:'dcr-chip'},scopeLabel),
el('span',{className:'dcr-meta'},TEXT.e2eHint)
),
el('div',{className:'dcr-coupling-columns',onClick:function(){props.onBlank();}},
el('div',{className:'dcr-coupling-canvas',style:{width:layout.width+'px',height:layout.height+'px'}},
el('div',{className:'dcr-column','data-coupling-column':'writer',style:{left:'0px',top:'0px',width:String(layout.writerX+layout.functionWidth)+'px'}},
el('span',{className:'dcr-column-title',style:{top:'2px'}},TEXT.columnWriters)
),
el('div',{className:'dcr-column','data-coupling-column':'resource',style:{left:String(layout.resourceX)+'px',top:'0px',width:String(layout.resourceWidth)+'px'}},
el('span',{className:'dcr-column-title',style:{top:'2px'}},TEXT.columnResources)
),
el('div',{className:'dcr-column','data-coupling-column':'reader',style:{left:String(layout.readerX)+'px',top:'0px',width:String(layout.functionWidth)+'px'}},
el('span',{className:'dcr-column-title',style:{top:'2px'}},TEXT.columnReaders)
),
el('svg',{className:'dcr-coupling-svg',width:layout.width,height:layout.height,viewBox:'0 0 '+layout.width+' '+layout.height,'aria-hidden':'true'},
layout.edges.map(function(item){
var edge=item.edge;
var classes='dcr-access-edge dcr-access-'+edge.access+' dcr-certainty-'+edge.certainty;
var pathProps={
key:edge.edge_id||(edge.from_function+'-'+edge.to_resource),
className:classes,
d:item.d,
'data-access-edge':'',
'data-access':edge.access,
'data-certainty':edge.certainty,
'data-field-name':edge.field_name,
'data-file':edge.location.file===null?'':edge.location.file,
'data-line':edge.location.line===null?'':String(edge.location.line),
'data-edge-id':edge.edge_id===null?'':edge.edge_id,
};
return el('g',{key:edge.edge_id||(edge.from_function+'-'+edge.to_resource)},
el('path',pathProps,el('title',null,accessLabel(edge.access)+' '+(edge.field_name||'字段')+' @ '+formatLocation(edge.location.file,edge.location.line))),
el('polygon',{className:'dcr-arrow dcr-arrow-access-'+edge.access,points:item.arrowPoints}),
edge.field_name!==''?el('text',{className:'dcr-edge-label',x:item.labelX,y:item.labelY,textAnchor:'middle'},edge.field_name):null
);
}),
layout.writerNodes.map(function(item){return renderFunctionNode(item,'writer');}),
layout.resourceNodes.map(function(item){return renderResourceNode(item);}),
layout.readerNodes.map(function(item){return renderFunctionNode(item,'reader');})
)
)
),
layout.data.external_nodes.length>0
?el('div',{className:'dcr-section'},
el('h4',{className:'dcr-subheading'},TEXT.externalTitle+'（'+String(layout.data.external_nodes.length)+'）'),
el('div',{className:'dcr-list'},layout.data.external_nodes.map(function(node,index){
return el('div',{key:'external-'+String(index),className:'dcr-edge'},
el('span',{className:'dcr-chip'},node.kind),
el('span',{className:'dcr-meta'},node.name+' @ '+formatLocation(node.file,node.line)),
el(EvidenceBadge,{value:node.certainty}),
el('span',{className:'dcr-muted'},node.reason||'分析域边界')
);
}))
)
:null,
layout.data.truncated?el('p',{className:'dcr-muted'},'投影已截断（预算限制）。'):null
);
}
function TreeView(props){
var tree=normalizeTree(props.payload);
var model=buildTreeModel(tree);
var statePair=useState({});
var collapsed=statePair[0];
var setCollapsed=statePair[1];
useEffect(function(){
setCollapsed({});
},[props.dataKey]);
function toggleNode(nodeId){
var next=assign({},collapsed);
if(next[nodeId]===true)delete next[nodeId];
else next[nodeId]=true;
setCollapsed(next);
}
function renderNode(node,depth){
var children=model.children[node.node_id]||[];
var hasChildren=children.length>0;
var isCollapsed=collapsed[node.node_id]===true;
var selected=props.selectedFunctionId!==null&&node.symbol.function_id===props.selectedFunctionId;
var blackbox=null;
if(props.addedInterfaces&&node.symbol.function_id!==null){
for(var ifaceKey in props.addedInterfaces){
if(!Object.prototype.hasOwnProperty.call(props.addedInterfaces,ifaceKey))continue;
var addedCandidate=props.addedInterfaces[ifaceKey];
if(isRecord(addedCandidate)&&addedCandidate.function_id===node.symbol.function_id){
blackbox=addedCandidate;
break;
}
}
}
if(blackbox&&props.blackboxExpanded[blackbox.interface_id]!==true){
var blackboxRow=el('div',{
key:'blackbox-row',
className:'dcr-tree-row dcr-blackbox-row'+(selected?' dcr-selected':''),
role:'treeitem',
'aria-level':String(depth+1),
'data-tree-node':node.node_id,
'data-node-id':node.node_id,
'data-depth':String(node.depth),
'data-blackbox-node':blackbox.interface_id,
'data-interface-id':blackbox.interface_id,
},
el('span',{className:'dcr-tree-indent',style:{width:String(depth*14)+'px'}}),
el('span',{className:'dcr-chip'},TEXT.blackboxTitle),
el('span',{className:'dcr-tree-name'},node.symbol.name+'() · 接口摘要'),
el('span',{className:'dcr-meta'},truncateLabel(blackbox.signature||'',72)),
el('span',{className:'dcr-meta'},TEXT.blackboxHidden+(children.length>0?'（'+String(children.length)+' 个直接子步骤）':'')),
el('button',{
key:'expand',
type:'button',
className:'dcr-btn',
'data-blackbox-expand':blackbox.interface_id,
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onExpandBlackbox(blackbox);
},
},TEXT.blackboxExpand)
);
return el('div',{key:node.node_id,className:'dcr-tree-node'},blackboxRow);
}
var rowChildren=[
el('span',{key:'indent',className:'dcr-tree-indent',style:{width:String(depth*14)+'px'}}),
];
if(hasChildren){
rowChildren.push(el('button',{
key:'toggle',
type:'button',
className:'dcr-tree-toggle',
'data-tree-toggle':node.node_id,
'aria-label':TEXT.treeToggle,
'aria-expanded':isCollapsed?'false':'true',
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
toggleNode(node.node_id);
},
},isCollapsed?'+':'−'));
}else{
rowChildren.push(el('span',{key:'toggle',className:'dcr-tree-toggle','aria-hidden':'true'}));
}
rowChildren.push(el('button',{
key:'name',
type:'button',
className:'dcr-tree-name',
onClick:function(){
props.onSelectNode(node,{jumpFile:true});
},
},node.symbol.name+'()'));
if(node.kind==='external')rowChildren.push(el('span',{key:'kind',className:'dcr-chip'},TEXT.treeExternal));
if(node.kind==='entry')rowChildren.push(el('span',{key:'entry',className:'dcr-chip'},'入口'));
if(blackbox){
rowChildren.push(el('span',{key:'blackbox',className:'dcr-chip'},TEXT.blackboxTitle+' · '+TEXT.blackboxExpanded));
rowChildren.push(el('button',{
key:'blackbox-toggle',
type:'button',
className:'dcr-btn',
'data-blackbox-expand':blackbox.interface_id,
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onExpandBlackbox(blackbox);
},
},TEXT.blackboxCollapse));
}
if(node.cycle)rowChildren.push(el('span',{key:'cycle',className:'dcr-chip'},TEXT.treeCycle));
if(node.callsite!==null){
rowChildren.push(el('span',{key:'callsite',className:'dcr-meta'},'调用点 '+formatLocation(node.callsite.file,node.callsite.line)+(node.callsite.expression!==null?' · '+truncateLabel(node.callsite.expression,80):'')));
}
for(var gi=0;gi<node.guards.length;gi+=1){
rowChildren.push(el('span',{key:'guard-'+String(gi),className:'dcr-tree-guard'},TEXT.treeGuard+'：'+truncateLabel(node.guards[gi].expression,160)));
}
for(var ri=0;ri<node.returns.length;ri+=1){
rowChildren.push(el('span',{key:'return-'+String(ri),className:'dcr-meta'},TEXT.treeReturn+' '+truncateLabel(node.returns[ri].expression,40)));
}
if(node.limitations.length>0)rowChildren.push(el('span',{key:'limits',className:'dcr-chip'},TEXT.treeLimits+' '+node.limitations.join('、')));
var row=el('div',{
key:'row',
className:'dcr-tree-row'+(selected?' dcr-selected':''),
role:'treeitem',
'aria-level':String(depth+1),
'aria-expanded':hasChildren?(isCollapsed?'false':'true'):undefined,
'data-tree-node':node.node_id,
'data-node-id':node.node_id,
'data-depth':String(node.depth),
},rowChildren);
var content=[row];
if(hasChildren&&!isCollapsed){
content.push(el('div',{key:'children',role:'group'},children.map(function(child){return renderNode(child,depth+1);})));
}
return el('div',{key:node.node_id,className:'dcr-tree-node'},content);
}
return el('div',{className:'dcr-view-inner'},
el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},VIEW_LABELS.tree),
tree.entry!==null?el('span',{className:'dcr-chip'},'入口 '+tree.entry.name+' '+formatLocation(tree.entry.file,tree.entry.line)):null,
tree.max_depth!==null?el('span',{className:'dcr-chip'},'最大深度 '+String(tree.max_depth)):null,
tree.truncated?el('span',{className:'dcr-chip'},'已截断'):null
),
el('p',{className:'dcr-muted'},'展开 / 折叠调用与分支；点击符号跳转文件视图对应行。'),
el('div',{className:'dcr-tree',role:'tree','aria-label':TEXT.treeTitle},model.roots.map(function(node){return renderNode(node,0);}))
);
}
function graphKindLabel(node){
if(node.kind==='entry')return '入口';
if(node.kind==='decision')return '判断';
if(node.kind==='exit')return node.role==='error'?'异常出口':'正常出口';
if(node.kind==='external')return '外部边界';
if(node.kind==='io')return '输入 / 输出';
return '处理';
}





function buildGroupModel(groups){
var byId={};
var order=[];
for(var index=0;index<groups.length;index+=1){
var group=groups[index];
if(byId[group.group_id]!==undefined)continue;
byId[group.group_id]=group;
order.push(group.group_id);
}
var ancestors={};
for(var oi=0;oi<order.length;oi+=1){
var chain=[];
var parent=byId[order[oi]].parent_group_id;
var guard=0;
while(parent!==null&&byId[parent]!==undefined&&guard<MAX_GROUPS){
chain.push(parent);
parent=byId[parent].parent_group_id;
guard+=1;
}
ancestors[order[oi]]=chain;
}
var nodeGroup={};
for(var gi=0;gi<order.length;gi+=1){
var members=byId[order[gi]].member_node_ids;
for(var mi=0;mi<members.length;mi+=1){
if(nodeGroup[members[mi]]===undefined)nodeGroup[members[mi]]=order[gi];
}
}
return{byId:byId,order:order,ancestors:ancestors,nodeGroup:nodeGroup};
}
function groupVisibleIn(model,groupId,collapsed){
var chain=model.ancestors[groupId]||[];
for(var index=0;index<chain.length;index+=1){
if(collapsed[chain[index]]===true)return false;
}
return true;
}
function representativeNode(model,nodeId,collapsed){
var groupId=model.nodeGroup[nodeId];
if(groupId===undefined)return nodeId;
var chain=[groupId];
var parent=model.byId[groupId].parent_group_id;
var guard=0;
while(parent!==null&&model.byId[parent]!==undefined&&guard<MAX_GROUPS){
chain.push(parent);
parent=model.byId[parent].parent_group_id;
guard+=1;
}
for(var index=chain.length-1;index>=0;index-=1){
if(collapsed[chain[index]]===true)return chain[index];
}
return nodeId;
}
function collectGroupNodeIds(model,groupId){
var ids=[];
var groups=[groupId];
for(var oi=0;oi<model.order.length;oi+=1){
var chain=model.ancestors[model.order[oi]]||[];
if(chain.indexOf(groupId)>=0)groups.push(model.order[oi]);
}
for(var gi=0;gi<groups.length;gi+=1){
var members=model.byId[groups[gi]].member_node_ids;
for(var mi=0;mi<members.length;mi+=1){
if(ids.indexOf(members[mi])<0)ids.push(members[mi]);
}
}
return ids;
}
function groupOverrideOf(overrides,groupId){
return isRecord(overrides[groupId])?overrides[groupId]:null;
}
function groupLabelOf(group,overrides){
var override=groupOverrideOf(overrides,group.group_id);
if(override!==null&&copyNullableString(override.label)!==null)return override.label;
return group.label;
}
function groupDescriptionOf(group,overrides){
var override=groupOverrideOf(overrides,group.group_id);
if(override!==null&&typeof override.description==='string'&&override.description.length>0)return override.description;
return group.description;
}
function computeGroupBoxes(model,layout,positions,collapsed){
var itemById={};
for(var ni=0;ni<layout.nodes.length;ni+=1)itemById[layout.nodes[ni].node.node_id]=layout.nodes[ni];
var boxes=[];
for(var oi=0;oi<model.order.length;oi+=1){
var groupId=model.order[oi];
if(!groupVisibleIn(model,groupId,collapsed))continue;
var nodeIds=collectGroupNodeIds(model,groupId);
var minX=null;
var minY=null;
var maxX=null;
var maxY=null;
for(var mi=0;mi<nodeIds.length;mi+=1){
var nodeId=nodeIds[mi];
var position=positions[nodeId];
if(!position)continue;
var item=itemById[nodeId];
var width=item?item.w:180;
var height=item?item.h:76;
if(minX===null||position.x<minX)minX=position.x;
if(minY===null||position.y<minY)minY=position.y;
if(maxX===null||position.x+width>maxX)maxX=position.x+width;
if(maxY===null||position.y+height>maxY)maxY=position.y+height;
}
if(minX===null){
minX=40+boxes.length*36;
minY=60+boxes.length*26;
maxX=minX+210;
maxY=minY+110;
}
var pad=16;
var header=24;
boxes.push({
group:model.byId[groupId],
groupId:groupId,
depth:(model.ancestors[groupId]||[]).length,
collapsed:collapsed[groupId]===true,
box:{x:minX-pad,y:minY-pad-header,w:(maxX-minX)+pad*2,h:(maxY-minY)+pad*2+header},
});
}
return boxes;
}
function findBlackboxTargets(layout,addedInterfaces,blackboxExpanded){
var targets=[];
for(var interfaceId in addedInterfaces){
if(!Object.prototype.hasOwnProperty.call(addedInterfaces,interfaceId))continue;
if(blackboxExpanded[interfaceId]===true)continue;
var candidate=addedInterfaces[interfaceId];
if(!isRecord(candidate))continue;
var match=null;
for(var index=0;index<layout.nodes.length&&match===null;index+=1){
var node=layout.nodes[index].node;
if(candidate.function_id!==null&&node.function_id===candidate.function_id)match=node;
}
for(var ni=0;ni<layout.nodes.length&&match===null;ni+=1){
var other=layout.nodes[ni].node;
if(other.kind==='external'&&(other.label===candidate.name||other.node_id.indexOf(candidate.name)>=0))match=other;
}
if(match!==null)targets.push({interfaceId:interfaceId,candidate:candidate,node:match});
}
return targets;
}
function computeBlackboxHidden(layout,targets){
var nodeById={};
for(var index=0;index<layout.nodes.length;index+=1)nodeById[layout.nodes[index].node.node_id]=layout.nodes[index].node;
function edgeOf(entry){return entry&&entry.edge!==undefined?entry.edge:entry;}
var targetIds={};
for(var ti=0;ti<targets.length;ti+=1)targetIds[targets[ti].node.node_id]=true;
var hidden={};
function isFlowEdge(edge){return edge.kind==='call'||edge.kind==='guard'||edge.kind==='return';}
for(var tii=0;tii<targets.length;tii+=1){
var queue=[];
for(var ei=0;ei<layout.edges.length;ei+=1){
var edge=edgeOf(layout.edges[ei]);
if(edge.from===targets[tii].node.node_id&&isFlowEdge(edge)&&edge.to!==null)queue.push(edge.to);
}
var seen={};
while(queue.length>0){
var current=queue.shift();
if(current===null||seen[current]===true)continue;
seen[current]=true;
if(targetIds[current]===true||nodeById[current]===undefined)continue;
hidden[current]=true;
for(var ei2=0;ei2<layout.edges.length;ei2+=1){
var nextEdge=edgeOf(layout.edges[ei2]);
if(nextEdge.from===current&&isFlowEdge(nextEdge)&&nextEdge.to!==null&&seen[nextEdge.to]!==true)queue.push(nextEdge.to);
}
}
}

for(var oi=0;oi<layout.nodes.length;oi+=1){
var nodeId=layout.nodes[oi].node.node_id;
if(hidden[nodeId]!==true)continue;
for(var ei3=0;ei3<layout.edges.length;ei3+=1){
var inEdge=edgeOf(layout.edges[ei3]);
if(inEdge.to!==nodeId||inEdge.from===null)continue;
if(hidden[inEdge.from]!==true&&targetIds[inEdge.from]!==true&&nodeById[inEdge.from]!==undefined){
delete hidden[nodeId];
break;
}
}
}
return hidden;
}
function routeGroupAwareEdge(startTerm,endTerm){
var startGroup=startTerm.group===true;
var endGroup=endTerm.group===true;
var scx=startTerm.x+startTerm.w/2;
var scy=startTerm.y+startTerm.h/2;
var ecx=endTerm.x+endTerm.w/2;
var ecy=endTerm.y+endTerm.h/2;
var sx;
var sy;
var ex;
var ey;
var startDir=0;
var endDir=0;
if(startGroup){
if(ecx>=scx){
sx=startTerm.x+startTerm.w;
sy=scy;
startDir=1;
}else{
sx=startTerm.x;
sy=scy;
startDir=-1;
}
}else{
sx=scx;
sy=startTerm.y+startTerm.h;
}
if(endGroup){
if(scx>=ecx){
ex=endTerm.x;
ey=ecy;
endDir=-1;
}else{
ex=endTerm.x+endTerm.w;
ey=ecy;
endDir=1;
}
}else{
ex=ecx;
ey=endTerm.y;
}
var d;
var labelX;
var labelY;
var arrowPoints;
if(!startGroup&&!endGroup){
if(ey>=sy+20){
var midY=Math.round((sy+ey)/2);
d='M'+sx+' '+sy+' V'+midY+' H'+ex+' V'+ey;
labelX=(sx+ex)/2;
labelY=midY-4;
}else{
var sideX=ex>=sx?startTerm.x+startTerm.w+34:startTerm.x-34;
d='M'+sx+' '+sy+' V'+(sy+26)+' H'+sideX+' V'+(ey-26)+' H'+ex+' V'+ey;
labelX=sideX;
labelY=(sy+ey)/2;
}
arrowPoints=ex+','+ey+' '+(ex-6)+','+(ey-10)+' '+(ex+6)+','+(ey-10);
}else if(startGroup&&!endGroup){
var x1=sx+startDir*26;
var approachY=ey-24;
d='M'+sx+' '+sy+' H'+x1+' V'+approachY+' H'+ex+' V'+ey;
labelX=(x1+ex)/2;
labelY=approachY-4;
arrowPoints=ex+','+ey+' '+(ex-6)+','+(ey-10)+' '+(ex+6)+','+(ey-10);
}else if(!startGroup&&endGroup){
var x2=ex-endDir*26;
var approachY2=ey-24;
d='M'+sx+' '+sy+' V'+approachY2+' H'+x2+' V'+ey+' H'+ex;
labelX=(sx+x2)/2;
labelY=approachY2-4;
arrowPoints=ex+','+ey+' '+(ex-endDir*10)+','+(ey-6)+' '+(ex-endDir*10)+','+(ey+6);
}else{
var x1b=sx+startDir*26;
var x2b=ex-endDir*26;
var midYb=Math.round((sy+ey)/2);
d='M'+sx+' '+sy+' H'+x1b+' V'+midYb+' H'+x2b+' V'+ey+' H'+ex;
labelX=(x1b+x2b)/2;
labelY=midYb-4;
arrowPoints=ex+','+ey+' '+(ex-endDir*10)+','+(ey-6)+' '+(ex-endDir*10)+','+(ey+6);
}
return{d:d,labelX:labelX,labelY:labelY,arrowPoints:arrowPoints,startGroup:startGroup,endGroup:endGroup};
}
function EndToEndView(props){
var initial=endToEndLayout(props.payload);
var firstPair=useState({layout:initial,positions:graphPositions(initial),camera:{x:20,y:8,zoom:1},search:'',selectedId:null,dragging:null,suppressClick:false,located:null});
var graph=firstPair[0];
var setGraph=firstPair[1];
var viewportRef=useRef(null);
var editPair=useState(null);
var editingGroup=editPair[0];
var setEditingGroup=editPair[1];
useEffect(function(){
var layout=endToEndLayout(props.payload);
setGraph({layout:layout,positions:graphPositions(layout),camera:fitCamera(layout,viewportRef),search:'',selectedId:null,dragging:null,suppressClick:false,located:null});
},[props.dataKey]);
function fitCamera(layout,ref){
var viewport=ref&&ref.current?ref.current:null;
var width=viewport&&viewport.clientWidth?viewport.clientWidth:960;
var height=viewport&&viewport.clientHeight?viewport.clientHeight:560;
var zoom=Math.min(1,(width-40)/Math.max(1,layout.width),(height-40)/Math.max(1,layout.height));
if(!isFinite(zoom)||zoom<=0)zoom=1;
return{x:20,y:12,zoom:zoom};
}
function graphPositions(layout){
var positions={};
for(var index=0;index<layout.nodes.length;index+=1){
var item=layout.nodes[index];
positions[item.node.node_id]={x:item.x,y:item.y};
}
return positions;
}
function viewportSize(){
var viewport=viewportRef.current;
return{
width:viewport&&viewport.clientWidth?viewport.clientWidth:960,
height:viewport&&viewport.clientHeight?viewport.clientHeight:560,
};
}
function zoomBy(factor){
var size=viewportSize();
var centerX=size.width/2;
var centerY=size.height/2;
var camera=graph.camera;
var next=Math.max(0.25,Math.min(2,camera.zoom*factor));
var ratio=next/camera.zoom;
setGraph(assign({},graph,{camera:{x:centerX-(centerX-camera.x)*ratio,y:centerY-(centerY-camera.y)*ratio,zoom:next}}));
}
function onNodePointerDown(event,nodeId){
if(event&&event.button!==undefined&&event.button!==0)return;
if(event&&event.stopPropagation)event.stopPropagation();
var position=graph.positions[nodeId];
if(!position)return;
setGraph(assign({},graph,{dragging:{nodeId:nodeId,startX:event.clientX,startY:event.clientY,origin:position,moved:false,pan:false}}));
try{
if(viewportRef.current&&typeof viewportRef.current.setPointerCapture==='function'&&event.pointerId!==undefined)viewportRef.current.setPointerCapture(event.pointerId);
}catch(error){
}
}
function onGroupPointerDown(event,groupId,memberIds){
if(event&&event.button!==undefined&&event.button!==0)return;
if(event&&event.stopPropagation)event.stopPropagation();
var origins={};
for(var index=0;index<memberIds.length;index+=1){
var position=graph.positions[memberIds[index]];
if(position)origins[memberIds[index]]=position;
}
setGraph(assign({},graph,{dragging:{pan:false,moved:false,startX:event.clientX,startY:event.clientY,groupId:groupId,origins:origins}}));
}
function onViewportPointerDown(event){
if(graph.dragging)return;
if(event&&event.button!==undefined&&event.button!==0)return;
var target=event&&event.target;
if(target&&typeof target.closest==='function'&&target.closest('[data-graph-node],[data-graph-group],[data-group-toggle],[data-group-edit],[data-blackbox-expand]'))return;
setGraph(assign({},graph,{dragging:{pan:true,startX:event.clientX,startY:event.clientY,originCamera:graph.camera,moved:false}}));
}
function onViewportPointerMove(event){
var dragging=graph.dragging;
if(!dragging)return;
var dx=event.clientX-dragging.startX;
var dy=event.clientY-dragging.startY;
var moved=dragging.moved===true||Math.abs(dx)+Math.abs(dy)>4;
if(dragging.pan===true){
setGraph(assign({},graph,{dragging:assign({},dragging,{moved:moved}),camera:{x:dragging.originCamera.x+dx,y:dragging.originCamera.y+dy,zoom:graph.camera.zoom}}));
return;
}
var positions=assign({},graph.positions);
if(isRecord(dragging.origins)){
for(var nodeId in dragging.origins){
if(!Object.prototype.hasOwnProperty.call(dragging.origins,nodeId))continue;
positions[nodeId]={x:dragging.origins[nodeId].x+dx/graph.camera.zoom,y:dragging.origins[nodeId].y+dy/graph.camera.zoom};
}
}else{
positions[dragging.nodeId]={x:dragging.origin.x+dx/graph.camera.zoom,y:dragging.origin.y+dy/graph.camera.zoom};
}
setGraph(assign({},graph,{dragging:assign({},dragging,{moved:moved}),positions:positions}));
}
function onViewportPointerUp(){
var dragging=graph.dragging;
if(!dragging)return;
setGraph(assign({},graph,{dragging:null,suppressClick:dragging.moved===true}));
}
function onViewportClick(event){
if(graph.suppressClick===true){
setGraph(assign({},graph,{suppressClick:false}));
return;
}
var target=event&&event.target;
if(target&&typeof target.closest==='function'&&target.closest('[data-graph-node],[data-graph-group],[data-group-toggle],[data-group-edit],[data-blackbox-expand]'))return;
setGraph(assign({},graph,{selectedId:null}));
props.onBlank();
}
function onViewportKeyDown(event){
var step={ArrowLeft:[45,0],ArrowRight:[-45,0],ArrowUp:[0,45],ArrowDown:[0,-45]}[event.key];
if(!step)return;
if(event.preventDefault)event.preventDefault();
setGraph(assign({},graph,{camera:{x:graph.camera.x+step[0],y:graph.camera.y+step[1],zoom:graph.camera.zoom}}));
}
function onSelectNode(node){
setGraph(assign({},graph,{selectedId:node.node_id}));
props.onSelectNode(node);
}
function onFit(){
setGraph(assign({},graph,{camera:fitCamera(graph.layout,viewportRef)}));
}
function onReset(){
var layout=endToEndLayout(props.payload);
setGraph(assign({},graph,{layout:layout,positions:graphPositions(layout),camera:fitCamera(layout,viewportRef),dragging:null,suppressClick:false}));
}
function onSearchChange(event){
setGraph(assign({},graph,{search:event&&event.target?event.target.value:''}));
}
function onLocate(){
var needle=String(graph.search||'').trim().toLowerCase();
if(needle==='')return;
var layout=graph.layout;
for(var index=0;index<layout.nodes.length;index+=1){
var item=layout.nodes[index];
var haystack=String(item.node.label||'').toLowerCase()+' '+String(item.node.sublabel||'').toLowerCase();
if(haystack.indexOf(needle)<0)continue;
var size=viewportSize();
setGraph(assign({},graph,{
selectedId:item.node.node_id,
located:item.node.node_id,
camera:{x:size.width/2-(item.x+item.w/2)*graph.camera.zoom,y:size.height/2-(item.y+item.h/2)*graph.camera.zoom,zoom:graph.camera.zoom},
}));
props.onSelectNode(item.node);
return;
}
}

var groupModel=buildGroupModel(normalizeEndToEnd(props.payload).groups);
var groupBoxes=computeGroupBoxes(groupModel,graph.layout,graph.positions,props.groupCollapsed);
var boxByGroupId={};
for(var gbi=0;gbi<groupBoxes.length;gbi+=1)boxByGroupId[groupBoxes[gbi].groupId]=groupBoxes[gbi];
var blackboxTargets=findBlackboxTargets(graph.layout,props.addedInterfaces,props.blackboxExpanded);
var blackboxByNodeId={};
var blackboxHidden={};
var blackboxHiddenCount={};
for(var bti=0;bti<blackboxTargets.length;bti+=1){
var ownHidden=computeBlackboxHidden(graph.layout,[blackboxTargets[bti]]);
blackboxHiddenCount[blackboxTargets[bti].interfaceId]=Object.keys(ownHidden).length;
for(var ownKey in ownHidden){
if(Object.prototype.hasOwnProperty.call(ownHidden,ownKey))blackboxHidden[ownKey]=true;
}
blackboxByNodeId[blackboxTargets[bti].node.node_id]=blackboxTargets[bti];
}
var layoutItemById={};
for(var lii=0;lii<graph.layout.nodes.length;lii+=1)layoutItemById[graph.layout.nodes[lii].node.node_id]=graph.layout.nodes[lii];
function terminalFor(repId){
if(boxByGroupId[repId]!==undefined){
var groupBox=boxByGroupId[repId].box;
return{group:true,x:groupBox.x,y:groupBox.y,w:groupBox.w,h:groupBox.h};
}
var position=graph.positions[repId];
var item=layoutItemById[repId];
if(!position||!item)return null;
return{group:false,x:position.x,y:position.y,w:item.w,h:item.h};
}
var projectedEdges=[];
for(var pei=0;pei<graph.layout.edges.length;pei+=1){
var layoutEdgeItem=graph.layout.edges[pei];
var sourceEdge=layoutEdgeItem.edge!==undefined?layoutEdgeItem.edge:layoutEdgeItem;
if(sourceEdge.from===null||sourceEdge.to===null)continue;
var repFrom=representativeNode(groupModel,sourceEdge.from,props.groupCollapsed);
var repTo=representativeNode(groupModel,sourceEdge.to,props.groupCollapsed);
if(repFrom===repTo)continue;
if(blackboxHidden[sourceEdge.from]===true||blackboxHidden[sourceEdge.to]===true)continue;
var fromTerminal=terminalFor(repFrom);
var toTerminal=terminalFor(repTo);
if(fromTerminal===null||toTerminal===null)continue;
projectedEdges.push({
edge:sourceEdge,
geometry:routeGroupAwareEdge(fromTerminal,toTerminal),
crossGroup:repFrom!==sourceEdge.from||repTo!==sourceEdge.to,
});
}
var renderedNodes=[];
for(var rni=0;rni<graph.layout.nodes.length;rni+=1){
var candidateItem=graph.layout.nodes[rni];
var candidateNodeId=candidateItem.node.node_id;
if(representativeNode(groupModel,candidateNodeId,props.groupCollapsed)!==candidateNodeId)continue;
if(blackboxHidden[candidateNodeId]===true)continue;
renderedNodes.push({item:candidateItem,blackbox:blackboxByNodeId[candidateNodeId]||null});
}
function selectGroupForEdit(entry){
setEditingGroup({
groupId:entry.groupId,
label:groupLabelOf(entry.group,props.groupOverrides),
description:groupDescriptionOf(entry.group,props.groupOverrides),
});
}
function renderGroupHeader(entry){
var group=entry.group;
var isEdited=groupOverrideOf(props.groupOverrides,entry.groupId)!==null;
var isEditing=editingGroup!==null&&editingGroup.groupId===entry.groupId;
var memberIds=collectGroupNodeIds(groupModel,entry.groupId);
var controls=[
el('button',{
key:'toggle',
type:'button',
className:'dcr-group-toggle',
'data-group-toggle':entry.groupId,
'aria-expanded':entry.collapsed?'false':'true',
'aria-label':TEXT.groupToggle,
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onFocusGroup(entry.groupId);
props.onToggleGroup(entry.groupId);
},
},entry.collapsed?'+':'−'),
el('strong',{
key:'label',
className:'dcr-group-label',
onDoubleClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
selectGroupForEdit(entry);
},
},groupLabelOf(group,props.groupOverrides)),
el('span',{key:'count',className:'dcr-chip'},String(memberIds.length)+' '+TEXT.groupMembers),
el('span',{key:'state',className:'dcr-chip'},entry.collapsed?TEXT.groupCollapsed:TEXT.groupExpanded),
isEdited?el('span',{key:'revised',className:'dcr-chip dcr-group-revised','data-group-revised':'true'},TEXT.groupRevised):null,
];
if(!isEditing){
controls.push(el('button',{
key:'edit',
type:'button',
className:'dcr-btn',
'data-group-edit':entry.groupId,
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
selectGroupForEdit(entry);
},
},TEXT.groupEdit));
}else{
controls.push(el('input',{
key:'edit-label',
className:'dcr-graph-search',
'data-group-edit-label':entry.groupId,
'aria-label':'组名',
value:editingGroup.label,
onChange:function(event){setEditingGroup(assign({},editingGroup,{label:event&&event.target?event.target.value:''}));},
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
}));
controls.push(el('input',{
key:'edit-description',
className:'dcr-graph-search',
'data-group-edit-description':entry.groupId,
'aria-label':'组描述',
value:editingGroup.description,
onChange:function(event){setEditingGroup(assign({},editingGroup,{description:event&&event.target?event.target.value:''}));},
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
}));
controls.push(el('button',{
key:'edit-save',
type:'button',
className:'dcr-btn dcr-btn-primary',
'data-group-edit-save':entry.groupId,
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onSaveGroupOverride(entry.groupId,editingGroup.label,editingGroup.description);
setEditingGroup(null);
},
},TEXT.groupEditSave));
controls.push(el('button',{
key:'edit-cancel',
type:'button',
className:'dcr-btn',
'data-group-edit-cancel':entry.groupId,
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
setEditingGroup(null);
},
},TEXT.groupEditCancel));
}
return controls;
}
function renderGroupBox(entry,terminal){
var box=entry.box;
var description=groupDescriptionOf(entry.group,props.groupOverrides);
var classes=terminal?'dcr-graph-node dcr-graph-group dcr-group-terminal':'dcr-graph-group dcr-group-frame';
if(props.focusGroupId===entry.groupId)classes+=' dcr-selected';
return el('div',{
key:(terminal?'group-terminal-':'group-frame-')+entry.groupId,
className:classes,
style:{
left:box.x+'px',
top:box.y+'px',
width:String(box.w)+'px',
height:String(box.h)+'px',
zIndex:terminal?'20':String(1+entry.depth),
},
'data-graph-group':entry.groupId,
'data-group-id':entry.groupId,
'data-collapsed':entry.collapsed?'true':'false',
'data-group-depth':String(entry.depth),
onPointerDown:function(event){
var target=event&&event.target;
if(target&&typeof target.closest==='function'&&target.closest('button,input'))return;
onGroupPointerDown(event,entry.groupId,collectGroupNodeIds(groupModel,entry.groupId));
},
onClick:function(event){
var target=event&&event.target;
if(target&&typeof target.closest==='function'&&target.closest('button,input,select,textarea'))return;
if(event&&event.stopPropagation)event.stopPropagation();
if(typeof props.onSelectGroup==='function')props.onSelectGroup(entry.groupId);
},
tabIndex:0,
role:'button',
},
el('div',{className:'dcr-group-header'},renderGroupHeader(entry)),
description!==''?el('span',{className:'dcr-graph-node-sub dcr-group-description'},truncateLabel(description,90)):null,
terminal?el('span',{className:'dcr-meta'},TEXT.groupCrossEdges):null
);
}
function renderBlackboxNode(item,target){
var node=item.node;
var position=graph.positions[node.node_id]||{x:item.x,y:item.y};
var candidate=target.candidate;
var classes='dcr-graph-node dcr-blackbox-node';
if(props.focusInterfaceId===target.interfaceId)classes+=' dcr-selected';
return el('div',{
key:node.node_id,
className:classes,
style:{left:position.x+'px',top:position.y+'px',width:String(item.w)+'px',height:String(item.h)+'px'},
'data-graph-node':node.node_id,
'data-node-id':node.node_id,
'data-node-kind':'blackbox',
'data-blackbox-node':target.interfaceId,
'data-interface-id':target.interfaceId,
tabIndex:0,
role:'button',
'aria-label':TEXT.blackboxTitle+' '+candidate.name,
onPointerDown:function(event){onNodePointerDown(event,node.node_id);},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onSelectInterface(target.interfaceId,candidate);
},
onKeyDown:function(event){
if(event.key==='Enter'||event.key===' '){
if(event.preventDefault)event.preventDefault();
props.onSelectInterface(target.interfaceId,candidate);
}
},
},
el('span',{className:'dcr-graph-node-label'},TEXT.blackboxTitle+' · '+candidate.name),
el('span',{className:'dcr-graph-node-sub'},truncateLabel(candidate.signature||'',34)),
el('span',{className:'dcr-graph-node-sub'},TEXT.blackboxHidden+' '+String(blackboxHiddenCount[target.interfaceId]||0)),
el('button',{
type:'button',
className:'dcr-btn dcr-blackbox-expand',
'data-blackbox-expand':target.interfaceId,
onPointerDown:function(event){if(event&&event.stopPropagation)event.stopPropagation();},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
props.onToggleBlackbox(target.interfaceId);
},
},TEXT.blackboxExpand)
);
}
function renderGraphNode(item){
var node=item.node;
var position=graph.positions[node.node_id]||{x:item.x,y:item.y};
var classes='dcr-graph-node dcr-kind-'+node.kind+' dcr-shape-'+node.shape;
if(node.role==='error')classes+=' dcr-role-error';
if(node.role==='boundary')classes+=' dcr-role-boundary';
if(graph.selectedId===node.node_id||(props.selectedFunctionId!==null&&node.function_id===props.selectedFunctionId))classes+=' dcr-selected';
if(node.shape==='diamond')classes+=' dcr-shape-diamond';
if(node.shape==='parallelogram')classes+=' dcr-shape-parallelogram';
return el('div',{
key:node.node_id,
className:classes,
style:{left:position.x+'px',top:position.y+'px',width:String(item.w)+'px',height:String(item.h)+'px'},
'data-graph-node':node.node_id,
'data-node-id':node.node_id,
'data-node-kind':node.kind,
'data-shape':node.shape,
'data-role':node.role,
'data-dashed':node.kind==='external'||node.role==='boundary'?'true':undefined,
'data-function-id':node.function_id===null?undefined:node.function_id,
tabIndex:0,
role:'button',
'aria-label':node.label+' '+graphKindLabel(node),
onPointerDown:function(event){onNodePointerDown(event,node.node_id);},
onClick:function(event){
if(event&&event.stopPropagation)event.stopPropagation();
onSelectNode(node);
},
onKeyDown:function(event){
if(event.key==='Enter'||event.key===' '){
if(event.preventDefault)event.preventDefault();
onSelectNode(node);
}
},
},
el('span',{className:'dcr-graph-node-label'},truncateLabel(node.label,36)),
node.sublabel!==''?el('span',{className:'dcr-graph-node-sub'},truncateLabel(node.sublabel,36)):null,
node.kind==='decision'?el('span',{className:'dcr-graph-node-sub'},'判断菱形'):null,
node.kind==='external'?el('span',{className:'dcr-graph-node-sub'},'分析域边界'):null,
node.role==='error'?el('span',{className:'dcr-graph-node-sub'},'异常出口'):null
);
}
var layout=graph.layout;
var camera=graph.camera;
var expandedFrames=[];
var collapsedTerminals=[];
for(var gfi=0;gfi<groupBoxes.length;gfi+=1){
if(groupBoxes[gfi].collapsed)collapsedTerminals.push(groupBoxes[gfi]);
else expandedFrames.push(groupBoxes[gfi]);
}
expandedFrames.sort(function(left,right){return left.depth-right.depth;});
return el('div',{className:'dcr-view-inner'},
el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},VIEW_LABELS.end_to_end),
el('span',{className:'dcr-meta'},TEXT.e2eHint),
groupBoxes.length>0?el('span',{className:'dcr-chip'},TEXT.groupSectionTitle+' '+String(groupBoxes.length)):null,
blackboxTargets.length>0?el('span',{className:'dcr-chip'},TEXT.blackboxTitle+' '+String(blackboxTargets.length)):null,
normalizeEndToEnd(props.payload).truncated===true?el('span',{className:'dcr-chip'},'已截断'):null
),
el('div',{className:'dcr-graph-toolbar'},
el('button',{type:'button',className:'dcr-btn','data-graph-fit':'',onClick:onFit},TEXT.e2eFit),
el('button',{type:'button',className:'dcr-btn',onClick:onReset},TEXT.e2eReset),
el('button',{type:'button',className:'dcr-btn','data-graph-collapse-all':'',disabled:groupBoxes.length===0,onClick:props.onCollapseAll},TEXT.groupCollapseAll),
el('button',{type:'button',className:'dcr-btn','data-graph-expand-all':'',disabled:groupBoxes.length===0,onClick:props.onExpandAll},TEXT.groupExpandAll),
el('button',{type:'button',className:'dcr-btn',onClick:function(){zoomBy(1/1.2);},'aria-label':TEXT.e2eZoomOut},'−'),
el('button',{type:'button',className:'dcr-btn',onClick:function(){zoomBy(1.2);},'aria-label':TEXT.e2eZoomIn},'+'),
el('span',{className:'dcr-graph-zoom'},String(Math.round(camera.zoom*100))+'%'),
el('input',{type:'search',className:'dcr-graph-search','data-graph-search':'',placeholder:TEXT.e2eSearch,'aria-label':TEXT.e2eSearch,value:graph.search,onChange:onSearchChange}),
el('button',{type:'button',className:'dcr-btn',onClick:onLocate},TEXT.e2eLocate)
),
el('p',{className:'dcr-muted'},TEXT.groupHint+' '+TEXT.blackboxTitle+'：'+TEXT.interfaceAddHint),
el('div',{className:'dcr-canvas'},
el('div',{
className:'dcr-canvas-viewport'+(graph.dragging!==null?' dcr-dragging':''),
ref:viewportRef,
tabIndex:0,
role:'application',
'aria-label':TEXT.e2eCanvasLabel,
onPointerDown:onViewportPointerDown,
onPointerMove:onViewportPointerMove,
onPointerUp:onViewportPointerUp,
onPointerCancel:onViewportPointerUp,
onPointerLeave:onViewportPointerUp,
onClick:onViewportClick,
onKeyDown:onViewportKeyDown,
},
el('div',{className:'dcr-canvas-world',style:{transform:'translate('+camera.x+'px,'+camera.y+'px) scale('+camera.zoom+')',width:String(layout.width)+'px',height:String(layout.height)+'px'}},
expandedFrames.map(function(entry){return renderGroupBox(entry,false);}),
el('svg',{className:'dcr-canvas-svg',width:layout.width,height:layout.height,viewBox:'0 0 '+layout.width+' '+layout.height,'aria-hidden':'true'},
projectedEdges.map(function(item){
var edge=item.edge;
var geometry=item.geometry;
var classes='dcr-graph-edge'+(edge.style_color==='exception'?' dcr-graph-edge-exception':'')+(edge.style_line==='dashed'||edge.kind==='external'?' dcr-graph-edge-dashed':'');
var titleText=edge.kind+' · '+edge.certainty+(edge.label!==''?' · '+edge.label:'')+(item.crossGroup?' · 跨组端口':'');
return el('g',{key:edge.edge_id},
el('path',{
className:classes,
d:geometry.d,
'data-graph-edge':'',
'data-edge-kind':edge.kind,
'data-certainty':edge.certainty,
'data-color':edge.style_color==='exception'?'exception':'normal',
'data-line-style':edge.style_line==='dashed'||edge.kind==='external'?'dashed':'solid',
'data-edge-id':edge.edge_id,
'data-edge-label':edge.label,
'data-evidence-ids':edge.evidence_ids.join(','),
'data-cross-group':item.crossGroup?'true':'false',
'data-from':item.crossGroup?representativeNode(groupModel,edge.from,props.groupCollapsed):edge.from,
'data-to':item.crossGroup?representativeNode(groupModel,edge.to,props.groupCollapsed):edge.to,
},el('title',null,titleText)),
el('polygon',{className:'dcr-arrow'+(edge.style_color==='exception'?' dcr-arrow-exception':''),points:geometry.arrowPoints}),
edge.label!==''?el('text',{className:'dcr-edge-label'+(edge.style_color==='exception'?' dcr-edge-label-exception':''),x:geometry.labelX,y:geometry.labelY,textAnchor:'middle'},truncateLabel(edge.label,52)):null
);
})),
renderedNodes.map(function(entry){
return entry.blackbox!==null?renderBlackboxNode(entry.item,entry.blackbox):renderGraphNode(entry.item);
}),
collapsedTerminals.map(function(entry){return renderGroupBox(entry,true);})
)
)
),
el('p',{className:'dcr-muted'},'形状：椭圆=入口，矩形=处理，菱形=判断，虚线框=外部边界；红色实线=异常返回；矩形组框=结构归纳组（可修订）。')
);
}
function sequenceParticipantLabel(participants,id){
for(var index=0;index<participants.length;index+=1){
if(participants[index].participant_id===id)return participants[index].label;
}
return String(id);
}
function sequencePercent(participants,id,fallbackIndex){
var count=Math.max(participants.length,2);
var found=-1;
for(var index=0;index<participants.length;index+=1){
if(participants[index].participant_id===id)found=index;
}
if(found<0)found=fallbackIndex%count;
return((found+0.5)/count)*100;
}
function SequenceView(props){
var mode=props.mode==='observed'?'observed':'static';
var observed=props.observed||{state:'idle',payload:null,error:null};
function deriveParticipants(sequence){
var participants=sequence.participants.slice();
if(participants.length===0){
var seen={};
for(var index=0;index<sequence.messages.length;index+=1){
var message=sequence.messages[index];
if(seen[message.from]!==true){seen[message.from]=true;participants.push({participant_id:message.from,label:message.from});}
if(seen[message.to]!==true){seen[message.to]=true;participants.push({participant_id:message.to,label:message.to});}
}
}
return participants;
}
function renderMessage(sequence,participants,message,messageIndex,observedFlag){
var fromX=sequencePercent(participants,message.from,messageIndex);
var toX=sequencePercent(participants,message.to,messageIndex+1);
var self=participants.length>0&&fromX===toX;
var d=self?('M '+fromX+' 8 h 3 v 8 h -3'):('M '+fromX+' 10 H '+toX);
var dashed=message.kind==='return'||message.kind==='external'||message.kind==='error';
var arrowClass='dcr-arrow'+(message.kind==='error'?' dcr-arrow-exception':'');
var selected=props.focusCallsiteId!==null&&message.callsite_id===props.focusCallsiteId;
var asyncFlag=observedFlag===true&&message.async===true;
return el('div',{
key:message.message_id,
className:'dcr-seq-row dcr-seq-'+message.kind+(selected?' dcr-selected':'')+(asyncFlag?' dcr-seq-async-row':''),
'data-sequence-message':message.message_id,
'data-message-kind':message.kind,
'data-certainty':message.certainty,
'data-observed':observedFlag===true?'true':undefined,
'data-sequence-async':asyncFlag?'true':undefined,
'data-call-id':observedFlag===true&&message.call_id!==null?message.call_id:undefined,
tabIndex:0,
role:'button',
onClick:function(){props.onSelectMessage(message);},
onKeyDown:function(event){
if(event.key==='Enter'||event.key===' '){
if(event.preventDefault)event.preventDefault();
props.onSelectMessage(message);
}
},
},
el('svg',{className:'dcr-seq-arrow-svg',viewBox:'0 0 100 20',preserveAspectRatio:'none','aria-hidden':'true'},
el('path',{className:'dcr-seq-msg'+(dashed?' dcr-seq-msg-dashed':'')+(message.kind==='error'?' dcr-seq-msg-error':''),d:d}),
el('polygon',{className:arrowClass,points:toX+',10 '+(toX-2)+',6 '+(toX-2)+',14'})
),
el('div',{className:'dcr-seq-row-text'},
el('span',{className:'dcr-chip'},'#'+String(message.index)),
el('span',{className:'dcr-seq-'+message.kind},sequenceParticipantLabel(participants,message.from)+' → '+sequenceParticipantLabel(participants,message.to)),
el('span',null,message.label),
el('span',{className:'dcr-chip'},KIND_LABELS[message.kind]||message.kind),
observedFlag===true?el(EvidenceBadge,{value:'observed'}):el(EvidenceBadge,{value:message.certainty}),
observedFlag===true&&message.call_id!==null?el('span',{className:'dcr-meta'},'call '+message.call_id):null,
observedFlag===true&&message.status!==null?el('span',{className:'dcr-chip dcr-stub-status-'+message.status},'status '+message.status):null,
observedFlag===true&&message.result!==null?el('span',{className:'dcr-meta'},'结果 '+String(message.result)):null,
observedFlag===true&&message.stubbed===true?el('span',{className:'dcr-chip dcr-stub-boundary-chip','data-stubbed':'true'},'stubbed'):null,
observedFlag===true&&message.imported===true?el('span',{className:'dcr-chip'},'imported'):null,
observedFlag===true&&message.event!==null?el('span',{className:'dcr-chip'},'event '+message.event+(message.code===null?'':' #'+String(message.code))):null,
asyncFlag?el('span',{className:'dcr-chip dcr-seq-async-chip','data-sequence-async-chip':''},TEXT.sequenceAsyncChip):null,
observedFlag===true?message.affected_resources.map(function(resource){
return el('span',{key:resource.resource_id,className:'dcr-chip dcr-stub-affect','data-stub-affect':resource.resource_id,'data-resource-id':resource.resource_id},resource.name+' · '+accessLabel(resource.access));
}):null,
message.evidence_ids.length>0?el('span',{className:'dcr-meta'},'证据 '+message.evidence_ids.join('、')):null,
message.limitations.length>0?el('span',{className:'dcr-muted'},'限制 '+message.limitations.join('、')):null
)
);
}
function renderDiagram(sequence,observedFlag){
var participants=deriveParticipants(sequence);
return el('div',{className:'dcr-seq'},
el('div',{className:'dcr-seq-head'},participants.map(function(participant){
return el('div',{key:participant.participant_id,className:'dcr-seq-participant'},participant.label);
})),
el('div',{className:'dcr-seq-body'},
participants.map(function(participant){
return el('div',{key:'lane-'+participant.participant_id,className:'dcr-seq-lane',style:{left:sequencePercent(participants,participant.participant_id,0)+'%'}});
}),
sequence.messages.map(function(message,index){return renderMessage(sequence,participants,message,index,observedFlag);})
)
);
}
var staticSequence=normalizeSequence(props.payload);
var modeBar=el('div',{className:'dcr-seq-mode','data-code-view':'sequence-mode','aria-label':TEXT.sequenceModeLabel},
el('span',{className:'dcr-meta'},TEXT.sequenceModeLabel),
el('button',{type:'button',className:'dcr-btn'+(mode==='static'?' dcr-btn-selected':''),'data-sequence-mode':'static','aria-pressed':mode==='static'?'true':'false',onClick:function(){props.onSelectMode('static');}},TEXT.sequenceModeStatic),
el('button',{type:'button',className:'dcr-btn'+(mode==='observed'?' dcr-btn-selected':''),'data-sequence-mode':'observed','aria-pressed':mode==='observed'?'true':'false',disabled:props.scenarioAvailable!==true,onClick:function(){props.onSelectMode('observed');}},TEXT.sequenceModeObserved),
props.scenarioAvailable!==true?el('span',{className:'dcr-muted','data-sequence-gap':''},TEXT.sequenceObservedGap):null
);
var head=el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},VIEW_LABELS.sequence),
el('span',{className:'dcr-chip'},'mode '+mode),
el('span',{className:'dcr-chip'},'observed '+(mode==='observed'?'true':'false')),
mode==='observed'&&observed.state==='ready'&&isRecord(observed.payload)&&isRecord(observed.payload.scenario)?el('span',{className:'dcr-chip'},TEXT.sequenceScenario+' '+String(observed.payload.scenario.scenario_id||'—')):null,
mode==='observed'&&observed.state==='ready'&&isRecord(observed.payload)&&isRecord(observed.payload.scenario)?el('span',{className:'dcr-chip'},TEXT.sequenceGeneration+' '+String(observed.payload.scenario.generation===null?'—':observed.payload.scenario.generation)):null,
staticSequence.truncated&&mode==='static'?el('span',{className:'dcr-chip'},'已截断'):null
);
var scenarioOptions=Array.isArray(props.scenarios)?props.scenarios:[];
var scenarioPicker=el('div',{className:'dcr-seq-mode','aria-label':TEXT.sequenceScenarioLabel},
el('span',{className:'dcr-meta'},TEXT.sequenceScenarioLabel),
el('select',{className:'dcr-select','data-code-view':'sequence-scenario','data-sequence-scenario-select':'','aria-label':TEXT.sequenceScenarioLabel,disabled:scenarioOptions.length===0,value:props.selectedScenarioId===null||props.selectedScenarioId===undefined?'':props.selectedScenarioId,onChange:function(event){props.onSelectScenario(event&&event.target?event.target.value:'');}},scenarioOptions.map(function(item){
var suffix=' · gen '+(item.generation===null||item.generation===undefined?'—':String(item.generation))+' · '+(item.steps===null||item.steps===undefined?'—':String(item.steps))+' 步 · '+String(item.updated_at||item.created_at||'—');
if(item.imported===true)suffix+=' · imported'+(item.label?' '+item.label:'');
return el('option',{key:item.scenario_id,value:item.scenario_id},item.scenario_id+suffix);
})),
scenarioOptions.length===0?el('span',{className:'dcr-muted','data-sequence-gap':''},TEXT.sequenceScenarioNoLedger):null
);
function findScenarioSummary(id){
for(var index=0;index<scenarioOptions.length;index+=1){
if(scenarioOptions[index].scenario_id===id)return scenarioOptions[index];
}
return null;
}
var body;
if(mode==='observed'){
if(observed.state==='loading')body=el('div',null,scenarioPicker,el('p',{className:'dcr-muted',role:'status','data-sequence-observed':'true'},TEXT.sequenceObservedLoading));
else if(observed.state==='error')body=el('div',null,scenarioPicker,el('p',{className:'dcr-error','data-error-code':observed.error?observed.error.code:'UNKNOWN_ERROR'},TEXT.sequenceObservedFailed));
else if(observed.state!=='ready')body=el('div',null,scenarioPicker,el('p',{className:'dcr-muted','data-sequence-gap':''},TEXT.sequenceObservedEmpty));
else{
var observedSequence=normalizeSequence(observed.payload);
var scenario=observedSequence.scenario;
var selectedSummary=scenario!==null&&scenario.scenario_id!==null?findScenarioSummary(scenario.scenario_id):(props.selectedScenarioId?findScenarioSummary(props.selectedScenarioId):null);
var observedPayloadRecord=isRecord(observed.payload)?observed.payload:{};
var importedScenario=observedPayloadRecord.imported===true||(scenario!==null&&scenario.imported===true)||(selectedSummary!==null&&selectedSummary.imported===true);
var scenarioLabel=scenario!==null&&scenario.label!==null?scenario.label:(selectedSummary!==null?selectedSummary.label:null);
if(scenarioLabel===null&&copyNullableString(observedPayloadRecord.label)!==null)scenarioLabel=observedPayloadRecord.label;
var asyncDeclared=observedSequence.async_events.length>0;
for(var asyncIndex=0;asyncIndex<observedSequence.messages.length;asyncIndex+=1){
if(observedSequence.messages[asyncIndex].async===true){asyncDeclared=true;break;}
}
body=el('div',null,
scenarioPicker,
el('p',{className:'dcr-warning dcr-warning-observed','data-sequence-observed':'true'},TEXT.sequenceObservedTitle+' · '+TEXT.sequenceObservedTrue),
asyncDeclared?el('p',{className:'dcr-warning dcr-warning-async','data-sequence-async-note':''},TEXT.sequenceAsyncNote):null,
importedScenario?el('p',{className:'dcr-chip dcr-seq-imported','data-sequence-imported':'true'},TEXT.sequenceImportedBadge+String(scenarioLabel!==null?scenarioLabel:'imported trace')):null,
observedSequence.limitations.length>0?el('p',{className:'dcr-muted','data-sequence-limitations':''},observedSequence.limitations.join('、')):null,
el('div',{className:'dcr-seq-scenario','data-scenario-id':scenario!==null&&scenario.scenario_id!==null?scenario.scenario_id:undefined,'data-scenario-generation':scenario!==null&&scenario.generation!==null?String(scenario.generation):undefined},
scenario!==null?el('span',{className:'dcr-chip'},'scenario_id '+String(scenario.scenario_id||'—')):null,
scenario!==null?el('span',{className:'dcr-chip'},'generation '+String(scenario.generation===null?'—':scenario.generation)):null,
scenario!==null?el('span',{className:'dcr-meta'},'profile '+String(scenario.profile_id||'—')):null,
scenario!==null?el('span',{className:'dcr-meta'},'records_digest '+shortDigest(scenario.records_digest)):null,
scenario!==null?el('span',{className:'dcr-meta'},'created '+String(scenario.created_at||'—')):null
),
el('p',{className:'dcr-muted'},TEXT.sequenceObservedHint),
el('div',{'data-sequence-observed':'true'},renderDiagram(observedSequence,true))
);
}
}else{
body=el('div',null,
el('p',{className:'dcr-warning','data-sequence-warning':'','data-observed':'false'},staticSequence.warning+' · '+TEXT.sequenceObserved),
el('p',{className:'dcr-muted'},TEXT.sequenceHint),
renderDiagram(staticSequence,false)
);
}
return el('div',{className:'dcr-view-inner'},head,modeBar,body);
}
function FileView(props){
var tree=normalizeFileTree(props.treePayload);
var read=props.readPayload===null?null:normalizeFileRead(props.readPayload);
var repos=tree.repos;
var treeContent=repos.length===0
?el('p',{className:'dcr-muted'},TEXT.viewEmptyNoFiles)
:repos.map(function(repo){
return el('div',{key:String(repo.repo_id)},
el('p',{className:'dcr-file-repo'},String(repo.repo_id||'repo')),
repo.files.map(function(file){
var selected=props.selectedPath===file.path;
return el('button',{
key:String(repo.repo_id)+'/'+file.path,
type:'button',
className:'dcr-file-button'+(selected?' dcr-selected':''),
'data-file-path':file.path,
'data-file-repo':repo.repo_id===null?'':repo.repo_id,
onClick:function(){props.onSelectFile(repo.repo_id,file.path);},
},file.path+(file.has_evidence?'':'（无证据）'));
})
);
});
var readContent;
if(props.readLoading===true)readContent=el('p',{className:'dcr-muted',role:'status'},TEXT.fileReadLoading);
else if(props.readError!==null)readContent=el('p',{className:'dcr-error'},TEXT.fileReadFailed);
else if(read===null)readContent=el('p',{className:'dcr-muted'},TEXT.fileReadHint);
else{
readContent=el('div',null,
el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},String(read.path||'文件')),
el('span',{className:'dcr-chip'},'仓库 '+String(read.repo_id||'—')),
el('span',{className:'dcr-meta'},'总行 '+numberText(read.total_lines)+' · 字节 '+numberText(read.bytes)+' · sha256 '+shortDigest(read.sha256)),
read.truncated===true?el('span',{className:'dcr-chip'},'已截断'):null
),
el('p',{className:'dcr-muted'},TEXT.fileReadHint),
read.reason!==null?el('p',{className:'dcr-muted'},TEXT.fileRefOnly+read.reason):null,
el('div',{className:'dcr-code',role:'list','aria-label':'只读文件 '+String(read.path||'')},read.lines.map(function(line){
var hit=props.highlightLine!==null&&line.n===props.highlightLine;
var lineProps={
key:String(line.n),
className:'dcr-line'+(hit?' dcr-line-hit':''),
role:'listitem',
tabIndex:0,
'data-file-line':line.n===null?'':String(line.n),
'data-line':line.n===null?'':String(line.n),
onClick:function(){props.onSelectLine(line.n);},
onKeyDown:function(event){
if(event.key==='Enter')props.onSelectLine(line.n);
},
};
if(hit)lineProps['data-highlight']='true';
return el('div',lineProps,
el('span',{className:'dcr-line-no','aria-hidden':'true'},line.n===null?'':String(line.n)),
el('span',{className:'dcr-line-text'},line.text)
);
}))
);
}
return el('div',{className:'dcr-view-inner'},
el('div',{className:'dcr-section-head'},
el('h3',{className:'dcr-heading'},VIEW_LABELS.file),
el('span',{className:'dcr-muted'},TEXT.fileLineHint)
),
el('div',{className:'dcr-file-layout'},
el('div',{className:'dcr-file-tree','data-file-tree':'',role:'tree','aria-label':TEXT.fileTreeTitle},
el('h3',{className:'dcr-subheading'},TEXT.fileTreeTitle),
treeContent
),
el('div',{className:'dcr-file-viewer'},readContent)
)
);
}
function SubflowView(props){
var subflow=props.subflow||{state:'idle',payload:null,error:null};
if(subflow.state==='loading'){
return el('section',{className:'dcr-section','data-code-view':'subflow'},
el('p',{className:'dcr-muted',role:'status'},TEXT.subflowLoading)
);
}
if(subflow.state==='error'){
return el('section',{className:'dcr-section','data-code-view':'subflow'},
el('p',{className:'dcr-error'},TEXT.subflowFailed+(subflow.error!==null?'（'+subflow.error.code+'）':''))
);
}
if(subflow.state!=='ready'||!isRecord(subflow.payload)){
return el('section',{className:'dcr-section','data-code-view':'subflow'},
el('p',{className:'dcr-muted'},subflow.state==='empty'?TEXT.subflowEmpty:TEXT.subflowHint)
);
}
var payload=normalizeEndToEnd(subflow.payload);
var layout=endToEndLayout(subflow.payload);
var scale=Math.min(1,820/Math.max(1,layout.width));
var breadcrumb=payload.breadcrumb;
var crumbBar=breadcrumb.length>0
?el('div',{className:'dcr-breadcrumb','data-breadcrumb':'','aria-label':TEXT.breadcrumbLabel},
breadcrumb.map(function(crumb,index){
var isRoot=index===0;
return el('button',{
key:crumb.function_id+':'+String(index),
type:'button',
className:'dcr-btn dcr-crumb'+(isRoot?' dcr-crumb-root':''),
'data-crumb':crumb.function_id,
'data-crumb-index':String(index),
onClick:function(){props.onCrumbClick(crumb,index,breadcrumb);},
},(isRoot?TEXT.subflowRootBadge+' ':'')+crumb.name);
})
)
:el('p',{className:'dcr-muted','data-breadcrumb-gap':''},TEXT.breadcrumbUnavailable);
var gaps=payload.gaps.map(function(gap,index){
return el('div',{key:gap.code+'-'+String(index),className:'dcr-gap','data-subflow-gap':gap.code},
el('code',{className:'dcr-gap-code'},gap.code),
' ',
el('span',{className:'dcr-gap-reason'},gap.reason||'')
);
});
var renderedNodes=layout.nodes.map(function(item){
var node=item.node;
var classes='dcr-subflow-node dcr-graph-node dcr-kind-'+node.kind+' dcr-shape-'+node.shape;
if(node.role==='error')classes+=' dcr-role-error';
return el('div',{
key:node.node_id,
className:classes,
style:{left:item.x+'px',top:item.y+'px',width:String(item.w)+'px',height:String(item.h)+'px'},
'data-subflow-node':node.node_id,
'data-node-id':node.node_id,
'data-node-kind':node.kind,
'data-shape':node.shape,
'data-role':node.role,
tabIndex:0,
role:'button',
'aria-label':node.label,
onClick:function(){props.onSelectSubflowNode(node);},
onKeyDown:function(event){
if(event.key==='Enter'||event.key===' '){
if(event.preventDefault)event.preventDefault();
props.onSelectSubflowNode(node);
}
},
},
el('span',{className:'dcr-graph-node-label'},truncateLabel(node.label,32)),
node.sublabel!==''?el('span',{className:'dcr-graph-node-sub'},truncateLabel(node.sublabel,30)):null
);
});
return el('section',{className:'dcr-section dcr-subflow-section','data-code-view':'subflow','aria-label':TEXT.subflowTitle},
crumbBar,
el('p',{className:'dcr-muted'},TEXT.subflowHint),
el('div',{className:'dcr-mini-viewport'},
el('div',{className:'dcr-mini-world',style:{width:Math.round(layout.width*scale)+'px',height:Math.round(layout.height*scale)+'px'}},
el('div',{style:{width:layout.width+'px',height:layout.height+'px',transform:'scale('+scale+')',transformOrigin:'0 0',position:'relative'}},
el('svg',{className:'dcr-canvas-svg',width:layout.width,height:layout.height,viewBox:'0 0 '+layout.width+' '+layout.height,'aria-hidden':'true'},
layout.edges.map(function(item){
return el('g',{key:item.edge.edge_id},
el('path',{
className:'dcr-graph-edge'+(item.exception?' dcr-graph-edge-exception':'')+(item.dashed?' dcr-graph-edge-dashed':''),
d:item.d,
'data-subflow-edge':'',
'data-edge-kind':item.edge.kind,
'data-certainty':item.edge.certainty,
'data-color':item.exception?'exception':'normal',
'data-edge-id':item.edge.edge_id,
}),
el('polygon',{className:'dcr-arrow'+(item.exception?' dcr-arrow-exception':''),points:item.arrowPoints})
);
})),
renderedNodes
)
)
),
gaps.length>0?el('div',null,gaps):null
);
}
function summaryFactsText(record){
var counts={};
for(var index=0;index<record.facts.length;index+=1){
var kind=record.facts[index].kind;
counts[kind]=(counts[kind]||0)+1;
}
var kinds=[];
for(var kindKey in counts){
if(Object.prototype.hasOwnProperty.call(counts,kindKey))kinds.push(kindKey+'×'+String(counts[kindKey]));
}
var refs=record.facts.slice(0,8).map(function(fact){return fact.ref;});
return String(record.facts.length)+'（'+(kinds.length>0?kinds.join('、'):'无')+'）'+(refs.length>0?'：'+refs.join('、'):'');
}
function renderEntrySummaryBlock(record,subject){
if(record===null||record===undefined)return null;
var stale=record.stale===true;
return el('div',{className:'dcr-ai-summary-entry','data-ai-summary-entry':'','data-ai-summary-entry-stale':stale?'true':'false'},
el('div',{className:'dcr-section-head'},el('h4',{className:'dcr-heading'},TEXT.aiSummaryEntryTitle),subject!==null&&subject!==undefined?el('span',{className:'dcr-chip'},TEXT.aiSummaryEntrySubject+' '+String(subject.label||subject.id)):null),
stale?el('p',{className:'dcr-warning dcr-ai-summary-stale'},TEXT.aiSummaryStale):null,
el('p',{className:'dcr-ai-summary-text','data-ai-summary-entry-text':''},record.text),
el('p',{className:'dcr-meta','data-ai-summary-entry-generator':''},TEXT.aiSummaryGenerator+'：'+String(record.generator.kind||'—')+' / '+String(record.generator.ref||'—')+(record.generator.model_ref!==null?' · model '+String(record.generator.model_ref):'')),
el('p',{className:'dcr-meta','data-ai-summary-entry-generated-at':''},TEXT.aiSummaryGeneratedAt+' '+String(record.generated_at||'—')),
el('p',{className:'dcr-meta','data-ai-summary-entry-facts':''},TEXT.aiSummaryFacts+' '+summaryFactsText(record)),
el('p',{className:'dcr-meta','data-ai-summary-entry-labels':''},TEXT.aiSummaryLabels+'：'+(record.inference_labels.length>0?record.inference_labels.join('、'):'—')),
record.limitations.length>0?el('p',{className:'dcr-muted'},'局限：'+record.limitations.join('、')):null,
el('p',{className:'dcr-muted'},TEXT.aiSummaryGap)
);
}
function AISummarySection(props){
var summary=props.summary===null||props.summary===undefined?createInitialSummaryState():props.summary;
var subject=props.subject===null||props.subject===undefined?null:props.subject;
var entrySummary=props.entrySummary===null||props.entrySummary===undefined?null:props.entrySummary;
var entrySubject=props.entrySubject===null||props.entrySubject===undefined?null:props.entrySubject;
var entryRecord=entrySummary!==null&&entrySummary.state==='ready'&&entrySubject!==null?findSummaryForSubject(entrySummary.payload,'entry',entrySubject.id):null;
var entryBlock=renderEntrySummaryBlock(entryRecord,entrySubject);
var subjectChip=subject!==null?el('span',{className:'dcr-chip'},(subject.type==='group'?TEXT.aiSummarySubjectGroup:TEXT.aiSummarySubjectFunction)+' '+String(subject.label||subject.id)):null;
var head=el('div',{className:'dcr-section-head'},el('h3',{className:'dcr-heading'},TEXT.aiSummaryTitle),subjectChip);
if(summary.state==='loading'||summary.state==='idle'){
return el('section',{className:'dcr-section dcr-ai-summary','data-ai-summary-loading':''},head,el('p',{className:'dcr-muted',role:'status'},TEXT.aiSummaryLoading),entryBlock);
}
if(summary.state==='error'){
var errorCode=summary.error!==null&&summary.error!==undefined?summary.error.code:'UNKNOWN_ERROR';
return el('section',{className:'dcr-section dcr-ai-summary'},head,el('p',{className:'dcr-error','data-ai-summary-error':'','data-error-code':errorCode},TEXT.aiSummaryFailed+String(errorCode)),entryBlock);
}
var record=findSummaryForSubject(summary.payload,subject!==null?subject.type:null,subject!==null?subject.id:null);
if(record===null){
return el('section',{className:'dcr-section dcr-ai-summary'},head,el('p',{className:'dcr-muted','data-ai-summary-gap':''},TEXT.aiSummaryNotGenerated),el('p',{className:'dcr-muted'},TEXT.aiSummaryGap),entryBlock);
}
var stale=record.stale===true;
return el('section',{className:'dcr-section dcr-ai-summary','data-code-view':'ai-summary','data-ai-summary-stale':stale?'true':'false'},
head,
stale?el('p',{className:'dcr-warning dcr-ai-summary-stale'},TEXT.aiSummaryStale):null,
el('p',{className:'dcr-ai-summary-text','data-ai-summary-text':''},record.text),
el('p',{className:'dcr-meta','data-ai-summary-generator':''},TEXT.aiSummaryGenerator+'：'+String(record.generator.kind||'—')+' / '+String(record.generator.ref||'—')+(record.generator.model_ref!==null?' · model '+String(record.generator.model_ref):'')),
el('p',{className:'dcr-meta','data-ai-summary-generated-at':''},TEXT.aiSummaryGeneratedAt+' '+String(record.generated_at||'—')),
el('p',{className:'dcr-meta','data-ai-summary-facts':''},TEXT.aiSummaryFacts+' '+summaryFactsText(record)),
el('p',{className:'dcr-meta','data-ai-summary-labels':''},TEXT.aiSummaryLabels+'：'+(record.inference_labels.length>0?record.inference_labels.join('、'):'—')),
record.limitations.length>0?el('p',{className:'dcr-muted'},'局限：'+record.limitations.join('、')):null,
entryBlock,
el('p',{className:'dcr-muted'},TEXT.aiSummaryGap)
);
}
function DetailsPanel(props){
var details=props.details;
if(details===null)return null;
var title;
var body;
if(details.kind==='group'){
var groupInfo=props.groupInfo;
title=TEXT.groupDetailTitle+'：'+(groupInfo!==null&&groupInfo!==undefined?groupInfo.label:details.group_id);
body=el('div',{className:'dcr-details-body'},
el('p',{className:'dcr-meta'},'组 id '+String(details.group_id)),
groupInfo!==null&&groupInfo!==undefined
?el('p',{className:'dcr-meta'},'成员 '+String(groupInfo.member_count)+' · '+String(groupInfo.description||'—'))
:el('p',{className:'dcr-muted'},'组信息暂不可用（等待端到端图投影）。'),
el(AISummarySection,{summary:props.summary,subject:props.summarySubject,entrySummary:props.entrySummary,entrySubject:props.entrySubject})
);
}else if(details.kind==='resource'){
var resource=props.selectedResource;
title=TEXT.resourceDetailTitle+'：'+(resource!==null?resource.name:details.resource_id);
if(resource===null){
body=el('p',{className:'dcr-muted'},'资源详情暂不可用（等待 coupling 投影）。');
}else{
var directions={};
for(var ai=0;ai<resource.accesses.length;ai+=1)directions[resource.accesses[ai].access]=(directions[resource.accesses[ai].access]||0)+1;
body=el('div',null,
el('p',{className:'dcr-meta'},'类型 '+String(resource.type||'—')+' · 存储 '+String(resource.storage||'—')+' · 位置 '+formatLocation(resource.file,resource.line)),
el('p',{className:'dcr-meta'},'字段：'+(resource.fields.length>0?resource.fields.map(function(field){return field.field_name;}).join('、'):'字段说明待复核（缺口）')),
el('p',{className:'dcr-meta'},'访问：'+ACCESS_VALUES.filter(function(key){return directions[key]>0;}).map(function(key){return accessLabel(key)+' '+String(directions[key]);}).join(' · ')),
el('ul',{className:'dcr-list','aria-label':'资源访问'},resource.accesses.map(function(access,index){
return el('li',{key:access.access_id||String(index),className:'dcr-field-access','data-field-access':access.access_id||('access-'+String(index)),'data-access':access.access,'data-certainty':access.certainty},
el(EvidenceBadge,{value:access.certainty}),
' ',
el('span',{className:'dcr-chip'},accessLabel(access.access)),
' ',
el('span',{className:'dcr-meta'},'owner '+access.function_name+'（'+formatLocation(access.function_file,access.function_line)+'）'),
' ',
el('span',{className:'dcr-meta'},'位置 '+formatLocation(access.location.file,access.location.line)),
' ',
el('span',{className:'dcr-meta'},'字段 '+(access.field_name||'—')+(access.expression!==''?'（'+access.expression+'）':'')),
access.limitations.length>0?el('span',{className:'dcr-muted'},' 限制 '+access.limitations.join('、')):null
);
})),
el('p',{className:'dcr-muted'},TEXT.aiSummaryGap)
);
}
}else{
var detail=props.entryDetail;
title=TEXT.functionDetailTitle+'：'+(detail!==null?String(detail.name||detail.entry_id):String(props.selectedFunctionName||'函数'));
if(props.entryLoading===true){
body=el('p',{className:'dcr-muted',role:'status'},TEXT.entryLoading);
}else if(props.entryError!==null){
body=el('p',{className:'dcr-error'},TEXT.entryFailedHint);
}else if(detail===null){
body=el('p',{className:'dcr-muted'},TEXT.entryIncomplete);
}else{
var entryData=props.entryData;
var calls=isRecord(entryData)&&Array.isArray(entryData.calls)?entryData.calls:[];
var callers=isRecord(entryData)&&Array.isArray(entryData.callers)?entryData.callers:[];
var evidence=isRecord(entryData)&&Array.isArray(entryData.evidence)?entryData.evidence:[];
var resources=isRecord(entryData)&&isRecord(entryData.resources)?entryData.resources:null;
var activeTab=props.detailsTab==='subflow'||props.detailsTab==='resources'?props.detailsTab:'source';
var tabDefs=[
['source',TEXT.detailsTabSource],
['subflow',TEXT.detailsTabSubflow],
['resources',TEXT.detailsTabResources],
];
var tabs=el('div',{className:'dcr-details-tabs','aria-label':TEXT.detailsTabsLabel},
tabDefs.map(function(definition){
var active=activeTab===definition[0];
return el('button',{
key:definition[0],
type:'button',
className:'dcr-tab'+(active?' dcr-btn-selected':''),
'data-code-view':'details-tab',
'data-tab':definition[0],
'aria-pressed':active?'true':'false',
onClick:function(){props.onSelectTab(definition[0]);},
},definition[1]);
})
);
var sourceContent=el('div',null,
el('p',{className:'dcr-meta'},'签名 '+String(detail.signature||'—')),
el('p',{className:'dcr-meta'},'位置 '+formatLocation(detail.file,detail.line)+' · 类型 '+String(detail.kind||'—')+' · 存储 '+String(detail.storage||'—')),
el(SourceView,{source:isRecord(entryData)?entryData.source:null}),
el(ResourceSection,{resources:resources}),
el(EdgeList,{title:TEXT.callsTitle,edges:calls,emptyText:TEXT.callsEmpty,truncated:isRecord(entryData)&&entryData.truncated===true}),
el(EdgeList,{title:TEXT.callersTitle,edges:callers,emptyText:TEXT.callersEmpty,truncated:isRecord(entryData)&&entryData.truncated===true}),
el(EvidenceList,{evidence:evidence})
);
var resourcesContent=el('div',null,
el(ResourceSection,{resources:resources})
);
var subflowContent=el(SubflowView,{
subflow:props.subflow,
onCrumbClick:props.onCrumbClick,
onSelectSubflowNode:props.onSelectSubflowNode,
});
var content=activeTab==='subflow'?subflowContent:activeTab==='resources'?resourcesContent:sourceContent;
body=el('div',{className:'dcr-details-body'},tabs,content,el(AISummarySection,{summary:props.summary,subject:props.summarySubject,entrySummary:props.entrySummary,entrySubject:props.entrySubject}));
}
}
return el('section',{className:'dcr-details','data-code-view':'details','aria-label':TEXT.detailsTitle,'data-cache':props.cacheHit===true?'hit':undefined,'data-first-screen':props.firstScreen===null||props.firstScreen===undefined?undefined:props.firstScreen},
el('div',{className:'dcr-details-head'},
el('h3',{className:'dcr-heading'},title),
el('div',{className:'dcr-header-actions'},
props.jumpFile!==null?el('button',{type:'button',className:'dcr-btn',onClick:props.onJumpFile},TEXT.openInFile):null,
el('button',{type:'button',className:'dcr-btn',onClick:props.onClose},TEXT.detailsClose)
)
),
el('p',{className:'dcr-muted'},TEXT.detailsHint),
body
);
}

var remembered={
snapshot:null,
entry:null,
view:'coupling',
focus:null,
details:null,
resource_id:null,
callsite_id:null,
file:null,
};

var VIEW_CACHE_LIMIT=32;
var viewCache=new Map();
var viewPending=new Map();
var viewCacheGeneration=0;
function cacheKeyFor(endpoint,payload){
var record=isRecord(payload)?payload:{};
var extras=[];
var extraKeys=['root','scenario','repo','path','subject_type','subject_id','max_lines'];
for(var index=0;index<extraKeys.length;index+=1){
var key=extraKeys[index];
if(record[key]!==undefined&&record[key]!==null)extras.push(key+'='+String(record[key]));
}
return String(copyNullableString(record.workspace)||'')+'|'+String(copyNullableString(record.snapshot)||'')+'|'+String(copyNullableString(record.entry)||'')+'|'+String(endpoint)+'|'+String(copyNullableString(record.mode)||'')+'|'+extras.join('&');
}
function cacheHas(key){return viewCache.has(key);}
function cacheGet(key){
var value=viewCache.get(key);
if(value===undefined)return null;
viewCache.delete(key);
viewCache.set(key,value);
return value;
}
function cacheSet(key,value){
if(!isRecord(value)&&!Array.isArray(value))return;
if(viewCache.has(key))viewCache.delete(key);
viewCache.set(key,value);
while(viewCache.size>VIEW_CACHE_LIMIT){
var oldest=viewCache.keys().next();
if(oldest.done)break;
viewCache.delete(oldest.value);
}
}
function clearViewCache(){
viewCache.clear();
viewPending.clear();
viewCacheGeneration+=1;
}
var sessionUi={
groupCollapsed:{},
groupOverrides:{},
addedInterfaces:{},
blackboxExpanded:{},
detailsTab:'source',
subflowRootId:null,
focusGroupId:null,
focusInterfaceId:null,
libraryOpen:true,
stubProfileId:null,
sequenceMode:'static',
scenarioId:null,
runGeneration:null,
callId:null,
};
function rememberSnapshot(row){
remembered.snapshot={
workspace_id:copyNullableString(row.workspace_id),
variant_id:copyNullableString(row.variant_id),
snapshot_id:copyNullableString(row.snapshot_id),
repo_id:copyNullableString(row.repo_id),
};
}
function resetRememberedEntryState(){
remembered.entry=null;
remembered.focus=null;
remembered.details=null;
remembered.resource_id=null;
remembered.callsite_id=null;
remembered.file=null;
}
function normalizeRpcResult(result){
if(!isRecord(result)){
return{kind:'error',code:'PROTOCOL_ERROR',message:'代码工作台返回了无法识别的响应。'};
}
if(result.ok===true){
if(!isRecord(result.value)){
return{kind:'error',code:'PROTOCOL_ERROR',message:'代码工作台返回的数据格式无效。'};
}
var value=result.value;
var engineFailure=isRecord(value.error)&&typeof value.error.code==='string'&&value.error.code.length>0;
if(value.ok===false||(value.ok===undefined&&engineFailure)){
var engineError=isRecord(value.error)?value.error:{};
return{
kind:'error',
code:safeCode(engineError.code),
message:safeMessage(engineError.message)||'引擎未能完成该请求。',
};
}
return{kind:'ok',value:value};
}
if(result.ok===false){
var error=isRecord(result.error)?result.error:{};
return{
kind:'error',
code:safeCode(error.code),
message:safeMessage(error.message)||'请求失败。',
};
}
return{kind:'error',code:'PROTOCOL_ERROR',message:'代码工作台返回了无法识别的响应。'};
}
function callCodeView(connection,endpoint,payload,signal){
if(!isRecord(connection)||!isRecord(connection.rpc)||typeof connection.rpc.call!=='function'){
return Promise.resolve({kind:'error',code:'BRIDGE_UNAVAILABLE',message:'客户端连接服务不可用，无法访问代码工作台。'});
}
var pending;
try{
pending=connection.rpc.call(CHANNEL,endpoint,payload,signal);
}catch(error){
return Promise.resolve({kind:'error',code:'TRANSPORT_FAILURE',message:safeMessage(error&&error.message)||'无法连接代码工作台服务。'});
}
return Promise.resolve(pending).then(function(result){
if(signal&&signal.aborted)return{kind:'aborted'};
return normalizeRpcResult(result);
},function(error){
if(signal&&signal.aborted)return{kind:'aborted'};
if(error&&error.name==='AbortError')return{kind:'aborted'};
return{kind:'error',code:'TRANSPORT_FAILURE',message:safeMessage(error&&error.message)||'无法连接代码工作台服务。'};
});
}
var EXTRA_CSS=[
'.dcr-tabs-row{position:relative;display:flex;gap:8px;align-items:flex-start;}',
'.dcr-view-inner{display:flex;flex-direction:column;gap:6px;min-width:0;}',
'.dcr-warning{margin:2px 0;padding:6px 8px;border:1px dashed var(--dsh-warning-color,currentColor);border-radius:6px;color:inherit;}',
'.dcr-swatch-read{border-color:currentColor;opacity:0.8;}',
'.dcr-swatch-write{border-width:2px;}',
'.dcr-swatch-rmw{border-style:dashed;}',
'.dcr-swatch-init{border-style:dotted;}',
'.dcr-swatch-deinit{border-style:dotted;}',
'.dcr-swatch-alloc{border-style:dashed;}',
'.dcr-swatch-free{border-style:dashed;}',
'.dcr-swatch-acquire{border-style:double;}',
'.dcr-swatch-release{border-style:double;}',
'.dcr-swatch-ellipse{border-radius:50%;}',
'.dcr-swatch-rect{border-radius:2px;}',
'.dcr-swatch-rectangle{border-radius:2px;}',
'.dcr-swatch-diamond{transform:rotate(45deg);width:12px;height:12px;}',
'.dcr-swatch-parallelogram{transform:skewX(-14deg);}',
'.dcr-swatch-boundary{border-style:dashed;}',
'.dcr-swatch-exception{border-color:var(--dsh-danger-color,currentColor);background:var(--dsh-danger-color,currentColor);}',
'.dcr-swatch-ai{border-style:dotted;}',
'.dcr-access-chip{font-size:11px;}',
'.dcr-access-chip.dcr-access-write{font-weight:600;}',
'.dcr-tree-children{display:flex;flex-direction:column;gap:2px;}',
'.dcr-details-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px;}',
'.dcr-details-body{display:flex;flex-direction:column;gap:4px;}',
'.dcr-graph-group{position:absolute;border:1.5px dashed var(--dsh-accent-color,currentColor);border-radius:10px;background:var(--dsh-group-background,transparent);}',
'.dcr-group-frame{pointer-events:auto;}',
'.dcr-group-terminal{border-style:solid;background:var(--dsh-node-background,var(--dsh-panel-background,transparent));display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;text-align:left;}',
'.dcr-group-header{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:4px 6px;}',
'.dcr-group-toggle{font:inherit;width:22px;min-width:22px;height:22px;line-height:1;border-radius:4px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));background:transparent;color:inherit;cursor:pointer;}',
'.dcr-group-label{font-size:12px;cursor:text;}',
'.dcr-group-revised{border-style:dashed;font-weight:600;}',
'.dcr-group-description{display:block;padding:0 8px 4px;}',
'.dcr-blackbox-node{border-style:double;border-width:3px;background:var(--dsh-node-background,var(--dsh-panel-background,transparent));}',
'.dcr-blackbox-expand{font-size:11px;min-height:22px;padding:1px 6px;}',
'.dcr-interface-library{margin-top:8px;}',
'.dcr-interface-list{display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow:auto;}',
'.dcr-interface-card{border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:2px;}',
'.dcr-external-boundaries{display:flex;flex-direction:column;gap:4px;margin-top:6px;}',
'.dcr-breadcrumb{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:2px 0;}',
'.dcr-crumb{font-size:12px;min-height:24px;padding:2px 8px;}',
'.dcr-crumb-root{font-weight:600;}',
'.dcr-subflow-section{display:flex;flex-direction:column;gap:4px;}',
'.dcr-mini-viewport{overflow:auto;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;max-height:46vh;}',
'.dcr-mini-world{position:relative;}',
'.dcr-subflow-node{font-size:11px;cursor:pointer;}',
'.dcr-swatch-group{border-style:dashed;}',
'.dcr-swatch-blackbox{border-style:double;border-width:3px;}',
'.dcr-swatch-observed{border-style:double;border-width:3px;}',
'.dcr-stub-panel{display:flex;flex-direction:column;gap:6px;min-width:0;}',
'.dcr-stub-section{border:1px solid var(--dsh-border-color,rgba(127,127,127,0.3));border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:5px;min-width:0;}',
'.dcr-select{font:inherit;max-width:100%;padding:3px 6px;border-radius:6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.45));background:transparent;color:inherit;}',
'.dcr-stub-profile-facts{display:flex;flex-direction:column;gap:2px;}',
'.dcr-stub-step{border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-left-width:4px;border-radius:6px;padding:5px 6px;display:flex;flex-direction:column;gap:4px;}',
'.dcr-stub-step.dcr-stub-step-boundary{border-left-color:var(--dsh-warning-color,currentColor);}',
'.dcr-stub-step-head{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;}',
'.dcr-stub-args{display:flex;flex-direction:column;gap:3px;}',
'.dcr-stub-arg{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;}',
'.dcr-stub-arg-input{font:inherit;width:92px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.45));background:transparent;color:inherit;}',
'.dcr-stub-arg-input.dcr-stub-invalid{border-color:var(--dsh-danger-color,currentColor);color:var(--dsh-danger-color,currentColor);}',
'.dcr-stub-step-actions{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}',
'.dcr-stub-check{display:inline-flex;align-items:center;gap:4px;font-size:12px;}',
'.dcr-stub-runbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
'.dcr-stub-boundary-chip{border-color:var(--dsh-warning-color,currentColor);}',
'.dcr-stub-boundary-note{color:var(--dsh-warning-color,currentColor);}',
'.dcr-stub-records{max-height:44vh;overflow:auto;}',
'.dcr-stub-generation{display:flex;flex-wrap:wrap;gap:5px;align-items:baseline;}',
'.dcr-stub-record{border:1px solid var(--dsh-border-color,rgba(127,127,127,0.35));border-radius:6px;padding:5px 6px;display:flex;flex-direction:column;gap:3px;cursor:pointer;}',
'.dcr-stub-record.dcr-stub-record-stubbed{border-style:double;border-color:var(--dsh-warning-color,currentColor);}',
'.dcr-stub-record.dcr-stub-record-skipped{opacity:0.7;border-style:dashed;cursor:default;}',
'.dcr-stub-record-head{display:flex;flex-wrap:wrap;gap:5px;align-items:baseline;}',
'.dcr-stub-events,.dcr-stub-affects{display:flex;flex-wrap:wrap;gap:4px;}',
'.dcr-stub-event{font:inherit;font-size:11px;cursor:pointer;border-radius:999px;padding:0 6px;border:1px solid var(--dsh-border-color,rgba(127,127,127,0.4));background:transparent;color:inherit;}',
'.dcr-stub-status-ok{border-color:var(--dsh-accent-color,currentColor);}',
'.dcr-stub-status-error{color:var(--dsh-danger-color,currentColor);border-color:var(--dsh-danger-color,currentColor);}',
'.dcr-stub-status-skipped{opacity:0.75;}',
'.dcr-stub-gaps{display:flex;flex-direction:column;gap:3px;}',
'.dcr-stub-gap{font-size:12px;}',
'.dcr-stub-record-error{margin:2px 0 0;}',
'.dcr-stub-digest{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;vertical-align:bottom;}',
'.dcr-seq-mode{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 0;}',
'.dcr-seq-scenario{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding:2px 0;}',
'.dcr-warning-observed{border-color:var(--dsh-accent-color,currentColor);border-style:double;}',
'.dcr-stub-undobar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
'.dcr-stub-trace{display:flex;flex-direction:column;gap:5px;}',
'.dcr-seq-imported{display:inline-block;margin:2px 0;}',
'.dcr-seq-async-row{border-left:2px dashed var(--dsh-warning-color,currentColor);}',
'.dcr-ai-summary-entry{margin-top:8px;padding-top:6px;border-top:1px dashed var(--dsh-warning-color,currentColor);}',
'.dcr-seq-async-chip{border-style:dashed;}',
'.dcr-warning-async{margin:2px 0;padding:6px 8px;border-left:3px dashed var(--dsh-warning-color,currentColor);}',
].join('\n');
CSS=CSS+'\n'+EXTRA_CSS;
function createInitialFileState(){
return{
treeKey:null,
tree:null,
treeLoading:false,
treeError:null,
readKey:null,
read:null,
readLoading:false,
readError:null,
selectedRepo:null,
selectedPath:null,
highlightLine:null,
};
}
function createInitialStubState(){
return{
profiles:{key:null,state:'idle',payload:null,error:null},
ledger:{key:null,state:'idle',payload:null,error:null},
profileId:sessionUi.stubProfileId,
steps:[{interface:'',args:[]}],
stopOnError:true,
busy:false,
runError:null,
plan:null,
latest:null,
latestScenarioId:null,
latestGeneration:null,
undoCount:1,
undoBusy:false,
undoStatus:null,
traceInput:'',
traceBusy:false,
traceStatus:null,
notice:'',
};
}
function createInitialPanelView(){
return{
phase:'loading',
status:null,
statusError:null,
snapshots:null,
snapshotGaps:[],
snapshotWorkspaces:0,
snapshotsError:null,
snapshot:null,
entries:null,
entriesData:null,
entriesSelection:null,
entriesGaps:[],
entriesLoading:false,
entriesError:null,
entry:null,
entryData:null,
entryDetail:null,
entrySelection:null,
entryLoading:false,
entryError:null,
entryCached:false,
firstScreen:null,
selectedFunctionId:null,
selectedFunctionName:null,
data:{},
interfaces:{key:null,state:'idle',payload:null,error:null},
summary:createInitialSummaryState(),
entrySummary:createInitialSummaryState(),
groupCollapsed:assign({},sessionUi.groupCollapsed),
groupOverrides:assign({},sessionUi.groupOverrides),
addedInterfaces:assign({},sessionUi.addedInterfaces),
blackboxExpanded:assign({},sessionUi.blackboxExpanded),
stub:createInitialStubState(),
file:createInitialFileState(),
actionError:null,
notice:'',
};
}
function createInitialUi(){
return{
view:VIEW_KEYS.indexOf(remembered.view)>=0?remembered.view:'coupling',
rail:'resources',
legendOpen:false,
details:remembered.details,
focus_resource_id:remembered.resource_id,
focus_callsite_id:remembered.callsite_id,
focus_group_id:sessionUi.focusGroupId,
focus_interface_id:sessionUi.focusInterfaceId,
detailsTab:sessionUi.detailsTab,
subflowRootId:sessionUi.subflowRootId,
libraryOpen:sessionUi.libraryOpen,
subflow:{key:null,state:'idle',payload:null,error:null,entryId:null,rootId:null},
sequenceMode:sessionUi.sequenceMode==='observed'?'observed':'static',
focus_scenario_id:sessionUi.scenarioId,
focus_run_generation:sessionUi.runGeneration,
focus_call_id:sessionUi.callId,
summaryEpoch:0,
};
}
function findResourceById(payload,resourceId){
if(!isRecord(payload)||resourceId===null)return null;
var coupling=normalizeCoupling(payload);
for(var index=0;index<coupling.resources.length;index+=1){
if(coupling.resources[index].resource_id===resourceId)return coupling.resources[index];
}
return null;
}
function CodeReaderPanel(props){
var ctx=props.ctx;
var statePair=useState(createInitialPanelView);
var view=statePair[0];
var setView=statePair[1];
var uiPair=useState(createInitialUi);
var ui=uiPair[0];
var setUi=uiPair[1];
var liveRef=useRef(null);
if(liveRef.current===null)liveRef.current={view:view,ui:ui};
var seqRef=useRef({});
var aliveRef=useRef(false);
function getViewState(){
return liveRef.current.view;
}
function getUiState(){
return liveRef.current.ui;
}
function patchView(patch){
var previous=liveRef.current.view;
var next=assign({},previous,typeof patch==='function'?patch(previous):patch);
liveRef.current.view=next;
setView(next);
}
function patchUi(patch){
var previous=liveRef.current.ui;
var next=assign({},previous,typeof patch==='function'?patch(previous):patch);
liveRef.current.ui=next;
setUi(next);
}
function patchFile(patch){
patchView(function(previous){
return{file:assign({},previous.file,typeof patch==='function'?patch(previous.file):patch)};
});
}
function nextSeq(name){
var map=seqRef.current;
map[name]=(map[name]||0)+1;
return map[name];
}
function isCurrent(name,seq){
return seqRef.current[name]===seq;
}
function request(name,endpoint,payload,signal,options){
var opts=options||{};
var cacheKey=opts.cache===true&&signal===undefined?cacheKeyFor(endpoint,payload):null;
var cacheGeneration=viewCacheGeneration;
var seq=nextSeq(name);
if(cacheKey!==null){
var cached=cacheGet(cacheKey);
if(cached!==null)return Promise.resolve({kind:'ok',value:cached,cached:true});
var pending=viewPending.get(cacheKey);
if(pending!==undefined){
return pending.then(function(result){
if(cacheGeneration!==viewCacheGeneration)return null;
if(result!==null&&result.kind==='ok')return {kind:'ok',value:result.value,cached:true};
return result;
});
}
}
var readPromise=callCodeView(ctx?ctx.connection:null,endpoint,payload,signal).then(function(result){
if(!isCurrent(name,seq))return null;
if(!aliveRef.current)return null;
if(cacheKey!==null&&cacheGeneration===viewCacheGeneration&&result&&result.kind==='ok')cacheSet(cacheKey,result.value);
return result;
});
if(cacheKey!==null){
viewPending.set(cacheKey,readPromise);
readPromise.then(function(){viewPending.delete(cacheKey);},function(){viewPending.delete(cacheKey);});
}
return readPromise;
}
var prefetchTimerRef=useRef(null);
var firstScreenRef=useRef({controller:null,token:0,unsupported:false});
function cancelPrefetchTimer(){
if(prefetchTimerRef.current!==null){
clearTimeout(prefetchTimerRef.current);
prefetchTimerRef.current=null;
}
}
function prefetchRequest(endpoint,payload){
request('prefetch:'+endpoint,endpoint,payload,undefined,{cache:true});
}
function prefetchEntry(row){
var snapshot=currentSnapshot();
if(snapshot===null||!aliveRef.current)return;
var entryId=isRecord(row)?copyNullableString(row.entry_id):null;
if(entryId===null)return;
var payload={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,entry:entryId};
prefetchRequest('view.getEntry',payload);
prefetchRequest('view.coupling',payload);
}
function scheduleIdlePrefetch(rows){
cancelPrefetchTimer();
if(!Array.isArray(rows)||rows.length===0)return;
var snapshot=currentSnapshot();
if(snapshot===null)return;
var current=getViewState();
if(current.entry!==null||current.selectedFunctionId!==null)return;
var first=rows[0];
var snapshotId=snapshot.snapshot_id;
prefetchTimerRef.current=setTimeout(function(){
prefetchTimerRef.current=null;
if(!aliveRef.current)return;
var nowSnapshot=currentSnapshot();
if(nowSnapshot===null||nowSnapshot.snapshot_id!==snapshotId)return;
var now=getViewState();
if(now.entry!==null||now.selectedFunctionId!==null)return;
prefetchEntry(first);
},40);
}
var summaryReqRef=useRef({key:null,timer:null,controller:null,entryController:null});
var summaryEpochRef=useRef(-1);
var activeSummarySubject=summarySubjectFor(getViewState(),getUiState());
var activeSummaryKey=activeSummarySubject===null?null:activeSummarySubject.type+'|'+activeSummarySubject.id;
var activeEntrySummarySubject=entrySummarySubjectFor(getViewState(),getUiState());
var activeEntrySummaryKey=activeEntrySummarySubject===null?null:'entry|'+activeEntrySummarySubject.id;
function requestSummary(subject,key,controller){
var snapshot=currentSnapshot();
if(snapshot===null||!aliveRef.current){
patchView({summary:{key:key,state:'idle',payload:null,error:null}});
return;
}
patchView({summary:{key:key,state:'loading',payload:null,error:null}});
request('summary','view.summary',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,subject_type:subject.type,subject_id:subject.id},controller!==null?controller.signal:undefined).then(function(result){
if(!result||result.kind==='aborted')return;
var current=getViewState().summary;
if(current===null||current===undefined||current.key!==key)return;
if(result.kind==='error'){
patchView({summary:{key:key,state:'error',payload:null,error:result}});
return;
}
patchView({summary:{key:key,state:'ready',payload:result.value,error:null}});
});
}
function requestEntrySummary(subject,key,controller){
var snapshot=currentSnapshot();
if(snapshot===null||!aliveRef.current){
patchView({entrySummary:createInitialSummaryState()});
return;
}
patchView({entrySummary:{key:key,state:'loading',payload:null,error:null}});
request('entrySummary','view.summary',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,subject_type:'entry',subject_id:subject.id},controller!==null?controller.signal:undefined).then(function(result){
if(!result||result.kind==='aborted')return;
var current=getViewState().entrySummary;
if(current===null||current===undefined||current.key!==key)return;
if(result.kind==='error'){
patchView({entrySummary:{key:key,state:'error',payload:null,error:result}});
return;
}
patchView({entrySummary:{key:key,state:'ready',payload:result.value,error:null}});
});
}
useEffect(function(){
var req=summaryReqRef.current;
if(req.timer!==null){clearTimeout(req.timer);req.timer=null;}
if(req.controller!==null){try{req.controller.abort();}catch(error){}req.controller=null;}
if(req.entryController!==null){try{req.entryController.abort();}catch(error){}req.entryController=null;}
var epoch=getsUiEpoch();
var force=summaryEpochRef.current!==epoch;
summaryEpochRef.current=epoch;
var currentSummary=getViewState().summary;
var currentEntrySummary=getViewState().entrySummary;
var functionReady=activeSummaryKey===null?true:(currentSummary!==null&&currentSummary!==undefined&&currentSummary.key===activeSummaryKey&&(currentSummary.state==='loading'||currentSummary.state==='ready'||currentSummary.state==='error'));
var entryReady=activeEntrySummaryKey===null?true:(currentEntrySummary!==null&&currentEntrySummary!==undefined&&currentEntrySummary.key===activeEntrySummaryKey&&(currentEntrySummary.state==='loading'||currentEntrySummary.state==='ready'||currentEntrySummary.state==='error'));
if(activeSummaryKey===null&&activeEntrySummaryKey===null){
req.key=null;
patchView({summary:createInitialSummaryState(),entrySummary:createInitialSummaryState()});
return;
}
if(activeSummaryKey===null&&currentSummary!==null&&currentSummary!==undefined&&currentSummary.state!=='idle')patchView({summary:createInitialSummaryState()});
if(activeEntrySummaryKey===null&&currentEntrySummary!==null&&currentEntrySummary!==undefined&&currentEntrySummary.state!=='idle')patchView({entrySummary:createInitialSummaryState()});
var needFunction=activeSummaryKey!==null&&(force||!functionReady);
var needEntry=activeEntrySummaryKey!==null&&(force||!entryReady);
if(!needFunction&&!needEntry)return;
if(needFunction&&force)patchView({summary:createInitialSummaryState()});
if(needEntry&&force)patchView({entrySummary:createInitialSummaryState()});
var functionSubject=activeSummarySubject;
var functionKey=activeSummaryKey;
var entrySubject=activeEntrySummarySubject;
var entryKey=activeEntrySummaryKey;
req.key=functionKey;
req.timer=setTimeout(function(){
req.timer=null;
if(!aliveRef.current)return;
if(needFunction){
var controller=null;
if(typeof AbortController==='function'){
controller=new AbortController();
req.controller=controller;
}
requestSummary(functionSubject,functionKey,controller);
}
if(needEntry){
var entryController=null;
if(typeof AbortController==='function'){
entryController=new AbortController();
req.entryController=entryController;
}
requestEntrySummary(entrySubject,entryKey,entryController);
}
},120);
return function(){
var cleanupReq=summaryReqRef.current;
if(cleanupReq.timer!==null){clearTimeout(cleanupReq.timer);cleanupReq.timer=null;}
if(cleanupReq.controller!==null){try{cleanupReq.controller.abort();}catch(error){}cleanupReq.controller=null;}
if(cleanupReq.entryController!==null){try{cleanupReq.entryController.abort();}catch(error){}cleanupReq.entryController=null;}
};
},[activeSummaryKey,activeEntrySummaryKey,ui.summaryEpoch]);
function getsUiEpoch(){return toInteger(getUiState().summaryEpoch)||0;}
function setData(name,patch){
patchView(function(previous){
var data=assign({},previous.data);
data[name]=assign({},previous.data[name]||{},patch);
return{data:data};
});
}
function currentSnapshot(){
return getViewState().snapshot;
}
function currentEntryId(){
var entry=getViewState().entry;
return entry===null?null:copyNullableString(entry.entry_id);
}
function rememberCurrent(){
var current=getViewState();
var currentUi=getUiState();
remembered.view=currentUi.view;
remembered.details=currentUi.details;
remembered.resource_id=currentUi.focus_resource_id;
remembered.callsite_id=currentUi.focus_callsite_id;
if(current.snapshot!==null)rememberSnapshot(current.snapshot);
remembered.entry=current.entry===null?null:{
entry_id:copyNullableString(current.entry.entry_id),
name:copyNullableString(current.entry.name),
file:copyNullableString(current.entry.file),
line:toInteger(current.entry.line),
symbol_id:copyNullableString(current.entry.symbol_id),
};
if(currentUi.details!==null&&currentUi.details.kind==='function'){
remembered.focus={
function_id:currentUi.details.function_id,
name:current.selectedFunctionName,
file:current.entryDetail!==null?copyNullableString(current.entryDetail.file):null,
line:current.entryDetail!==null?toInteger(current.entryDetail.line):null,
};
}else if(current.entry!==null){
remembered.focus={
function_id:copyNullableString(current.entry.entry_id),
name:copyNullableString(current.entry.name),
file:copyNullableString(current.entry.file),
line:toInteger(current.entry.line),
};
}else{
remembered.focus=null;
}
if(current.file.selectedPath!==null){
remembered.file={repo:current.file.selectedRepo,path:current.file.selectedPath,line:current.file.highlightLine};
}
sessionUi.detailsTab=currentUi.detailsTab;
sessionUi.subflowRootId=currentUi.subflowRootId;
sessionUi.focusGroupId=currentUi.focus_group_id;
sessionUi.focusInterfaceId=currentUi.focus_interface_id;
sessionUi.libraryOpen=currentUi.libraryOpen;
sessionUi.stubProfileId=current.stub!==undefined&&current.stub!==null?current.stub.profileId:sessionUi.stubProfileId;
sessionUi.sequenceMode=currentUi.sequenceMode;
sessionUi.scenarioId=currentUi.focus_scenario_id;
sessionUi.runGeneration=currentUi.focus_run_generation;
sessionUi.callId=currentUi.focus_call_id;
}
function openPanel(){
cancelPrefetchTimer();
cancelFirstScreen();
clearViewCache();
patchView(createInitialPanelView());
patchUi(function(previous){return{rail:'resources',subflow:{key:null,state:'idle',payload:null,error:null,entryId:null,rootId:null},summaryEpoch:(previous.summaryEpoch||0)+1};});
request('status','view.status',{}).then(function(result){
if(!result)return;
var status=result.kind==='ok'?result.value:null;
var statusError=result.kind==='error'?result:null;
patchView({status:status,statusError:statusError});
request('snapshots','view.listSnapshots',{}).then(function(snapshotsResult){
if(!snapshotsResult)return;
handleSnapshots(status,statusError,snapshotsResult);
});
});
}
function handleSnapshots(statusData,statusError,result){
var engineGap=hasEngineGap(statusData);
if(result.kind==='error'){
patchView({
snapshots:null,
snapshotGaps:[],
snapshotWorkspaces:0,
snapshotsError:result,
phase:engineGap?'ready':'error',
notice:engineGap?'引擎或引导文件不可用：面板保留并显示缺口，快照列表无法读取。':'',
});
return;
}
var payload=result.value;
var rows=flattenSnapshots(payload);
var gaps=Array.isArray(payload.gaps)?payload.gaps:[];
var workspaceCount=Array.isArray(payload.workspaces)?payload.workspaces.length:0;
patchView({
snapshots:rows,
snapshotGaps:gaps,
snapshotWorkspaces:workspaceCount,
snapshotsError:null,
phase:statusError!==null&&!engineGap?'error':'ready',
});
var rememberedRow=remembered.snapshot===null?null:findSnapshotRow(rows,remembered.snapshot.snapshot_id);
if(rememberedRow!==null&&rememberedRow.status==='verified'){
chooseSnapshotRow(rememberedRow,{restore:true});
return;
}
if(rememberedRow!==null){
resetRememberedEntryState();
patchView({notice:'上次选择的快照当前未核验通过，未自动恢复。'});
}
}
function chooseSnapshotRow(row,options){
var opts=options||{};
var restore=opts.restore===true;
cancelPrefetchTimer();
cancelFirstScreen();
clearViewCache();
if(restore!==true)resetRememberedEntryState();
rememberSnapshot(row);
patchView({
snapshot:row,
entries:null,
entriesData:null,
entriesSelection:null,
entriesGaps:[],
entriesLoading:true,
entriesError:null,
entry:null,
entryData:null,
entryDetail:null,
entrySelection:null,
entryLoading:false,
entryError:null,
entryCached:false,
selectedFunctionId:null,
selectedFunctionName:null,
data:{},
interfaces:{key:null,state:'idle',payload:null,error:null},
summary:createInitialSummaryState(),
entrySummary:createInitialSummaryState(),
stub:createInitialStubState(),
file:createInitialFileState(),
actionError:null,
notice:'',
phase:'ready',
});
patchUi({
details:restore?remembered.details:null,
focus_resource_id:restore?remembered.resource_id:null,
focus_callsite_id:restore?remembered.callsite_id:null,
subflow:{key:null,state:'idle',payload:null,error:null,entryId:null,rootId:null},
});
request('entries','view.listEntries',{workspace:row.workspace_id,snapshot:row.snapshot_id}).then(function(result){
if(!result)return;
if(result.kind==='error'){
patchView({entriesLoading:false,entriesError:result});
return;
}
var payload=result.value;
var entries=normalizeEntries(payload);
patchView({
entriesLoading:false,
entries:entries,
entriesData:payload,
entriesSelection:isRecord(payload.selection)?payload.selection:null,
entriesGaps:Array.isArray(payload.gaps)?payload.gaps:[],
entriesError:null,
});
if(restore&&remembered.entry!==null){
var match=findEntryRow(entries,remembered.entry.entry_id);
if(match!==null){
chooseEntryRow(match,{restore:true});
return;
}
patchView({notice:'上次选择的入口不在当前入口列表中，已清除。'});
resetRememberedEntryState();
patchUi({details:null,focus_resource_id:null,focus_callsite_id:null});
}
scheduleIdlePrefetch(entries);
var snapshotReads=[loadData('coupling'),loadInterfaces()];
loadActiveView();
if(snapshotReads.length>0&&typeof Promise.allSettled==='function')Promise.allSettled(snapshotReads).catch(function(){});
});
}
function chooseEntryRow(row,options){
var opts=options||{};
var restore=opts.restore===true;
cancelPrefetchTimer();
cancelFirstScreen();
var snapshot=currentSnapshot();
var entryId=copyNullableString(row.entry_id);
if(snapshot===null||entryId===null)return;
var detailKind=restore&&remembered.details!==null?remembered.details:{kind:'function',function_id:entryId};
var focusFunctionId=detailKind.kind==='function'?detailKind.function_id:entryId;
var focusMeta={
name:copyNullableString(row.name)||entryId,
file:copyNullableString(row.file),
line:toInteger(row.line),
};
patchView({
entry:row,
selectedFunctionId:focusFunctionId,
selectedFunctionName:restore&&detailKind.kind==='function'&&remembered.focus!==null&&remembered.focus.function_id===focusFunctionId?remembered.focus.name:focusMeta.name,
entryData:null,
entryDetail:null,
entrySelection:null,
entryLoading:true,
entryError:null,
entryCached:false,
firstScreen:null,
data:{},
interfaces:{key:null,state:'loading',payload:null,error:null},
actionError:null,
notice:'',
});
patchUi({
details:detailKind,
focus_resource_id:restore?remembered.resource_id:null,
focus_callsite_id:restore?remembered.callsite_id:null,
});
remembered.entry={
entry_id:entryId,
name:copyNullableString(row.name),
file:copyNullableString(row.file),
line:toInteger(row.line),
symbol_id:copyNullableString(row.symbol_id),
};
if(restore!==true){
remembered.details=detailKind;
remembered.focus={function_id:focusFunctionId,name:focusMeta.name,file:focusMeta.file,line:focusMeta.line};
remembered.resource_id=null;
remembered.callsite_id=null;
remembered.file=null;
}
// Prefer one batch first-screen RPC for entry+interfaces+current view.
// When it fails (engine gap/error, LIMIT_EXCEEDED, old host) fall back to the
// existing parallel individual reads; cache-hot selections skip the batch.
var batchView=firstScreenBatchView(getUiState().view);
var batchTargets=firstScreenTargets(snapshot,focusFunctionId,batchView);
if(focusFunctionId!==entryId){
// Restore with an explicitly focused function: the batch entry and the view
// scope differ, so keep the separate requests that preserve both semantics.
runEntryIndividualReads(focusFunctionId);
}else if(firstScreenAllCached(batchTargets,batchView)){
runEntryIndividualReads(focusFunctionId);
}else if(firstScreenRef.current.unsupported===true){
runEntryFallback(focusFunctionId);
}else if(!startFirstScreen(focusFunctionId,batchView)){
runEntryFallback(focusFunctionId);
}
if(getUiState().detailsTab==='subflow'){
setSubflow({key:null,state:'idle',payload:null,error:null,entryId:focusFunctionId,rootId:getUiState().subflowRootId});
loadSubflow();
}
if(restore===true&&remembered.file!==null){
var target=remembered.file;
openFile(target.repo,target.path,target.line,true);
}
}
function loadEntryData(functionId){
var snapshot=currentSnapshot();
if(snapshot===null||functionId===null)return Promise.resolve(null);
patchView({entryLoading:true,entryError:null,entryData:null,entryDetail:null,entrySelection:null,entryCached:false});
return request('getEntry','view.getEntry',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,entry:functionId},undefined,{cache:true}).then(function(result){
if(!result)return null;
if(result.kind==='error'){
patchView({entryLoading:false,entryError:result});
return result;
}
var payload=result.value;
var applied=applyEntrySuccess(payload,result.cached===true,functionId);
if(!applied)return result;
return result;
});
}
function applyEntrySuccess(payload,cached,functionId){
var detail=isRecord(payload)&&isRecord(payload.entry)?payload.entry:null;
if(detail===null){
patchView({entryLoading:false,entryData:payload,entryDetail:null,entryError:{kind:'error',code:'PROTOCOL_ERROR',message:'view.getEntry/view.firstScreen 响应缺少 entry 字段。'}});
return false;
}
var name=copyNullableString(detail.name);
if(name!==null){
patchView(function(previous){
return{selectedFunctionName:previous.selectedFunctionId===functionId?name:previous.selectedFunctionName};
});
if(remembered.focus!==null&&remembered.focus.function_id===functionId)remembered.focus.name=name;
}
patchView({entryLoading:false,entryData:payload,entryDetail:detail,entrySelection:isRecord(payload.selection)?payload.selection:null,entryError:null,entryCached:cached===true});
if(getUiState().detailsTab==='subflow')loadSubflow();
return true;
}
function loadData(name){
if(name==='file'){
prepareFileView();
return Promise.resolve(null);
}
if(VIEW_KEYS.indexOf(name)<0)return Promise.resolve(null);
var snapshot=currentSnapshot();
if(snapshot===null){
setData(name,{key:null,state:'empty',payload:null,error:null});
return Promise.resolve(null);
}
var entryId=currentEntryId();
if(NEEDS_ENTRY[name]!==false&&entryId===null){
setData(name,{key:null,state:'empty',payload:null,error:null});
return Promise.resolve(null);
}

var key=snapshot.snapshot_id+'|'+(entryId||'');
var existing=getViewState().data[name];
if(existing&&existing.key===key&&(existing.state==='loading'||existing.state==='ready'||existing.state==='empty'||existing.state==='error'))return Promise.resolve(null);
setData(name,{key:key,state:'loading',payload:null,error:null,cached:false});
var payload={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id};
if(name==='coupling'){
if(entryId!==null)payload.entry=entryId;
}else{
payload.entry=entryId;
}
if(name==='sequence')payload.mode='static';
return request('view:'+name,VIEW_ENDPOINTS[name],payload,undefined,{cache:true}).then(function(result){
if(!result)return null;
if(result.kind==='error'){
setData(name,{state:'error',payload:null,error:result,cached:false});
return result;
}
applyViewSuccess(name,result.value,result.cached===true);
return result;
});
}
function applyViewSuccess(name,payload,cached){
setData(name,{state:viewPayloadState(name,payload),payload:payload,error:null,cached:cached===true});
if(name==='end_to_end')initializeGroupDefaults(payload);
return true;
}
function initializeGroupDefaults(payload){
var groups=normalizeEndToEnd(payload).groups;
if(groups.length===0)return;
var collapsed=assign({},getViewState().groupCollapsed);
var changed=false;
for(var index=0;index<groups.length;index+=1){
if(collapsed[groups[index].group_id]===undefined){
collapsed[groups[index].group_id]=groups[index].collapsed_default===true;
changed=true;
}
}
if(changed){
sessionUi.groupCollapsed=collapsed;
patchView({groupCollapsed:collapsed});
}
}
function loadInterfaces(){
var snapshot=currentSnapshot();
if(snapshot===null)return Promise.resolve(null);
var entryId=currentEntryId();
var key=snapshot.snapshot_id+'|'+(entryId||'');
var existing=getViewState().interfaces;
if(existing&&existing.key===key&&(existing.state==='loading'||existing.state==='ready'||existing.state==='empty'||existing.state==='error'))return Promise.resolve(null);
patchView({interfaces:{key:key,state:'loading',payload:null,error:null}});
var payload={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id};
if(entryId!==null)payload.entry=entryId;
return request('interfaces','view.interfaces',payload,undefined,{cache:true}).then(function(result){
if(!result)return null;
if(result.kind==='error'){
patchView({interfaces:{key:key,state:'error',payload:null,error:result}});
return result;
}
applyInterfacesSuccess(result.value,key,result.cached===true);
return result;
});
}
function applyInterfacesSuccess(payload,key,cached){
var normalized=normalizeInterfaces(payload);
patchView({interfaces:{key:key,state:normalized.candidates.length>0?'ready':'empty',payload:payload,error:null,cached:cached===true}});
return true;
}
function cancelFirstScreen(){
var state=firstScreenRef.current;
if(state.controller!==null){try{state.controller.abort();}catch(error){}state.controller=null;}
state.token+=1;
}
function firstScreenBatchView(uiView){
return VIEW_KEYS.indexOf(uiView)>=0?uiView:'coupling';
}
function firstScreenViewSpec(viewName,base,entryId){
var payload=assign({},base);
if(viewName!=='file')payload.entry=entryId;
if(viewName==='sequence')payload.mode='static';
return{endpoint:viewName==='file'?'view.fileTree':VIEW_ENDPOINTS[viewName],payload:payload,view:viewName};
}
function isFileTreeProjection(value){
return isRecord(value)&&(Array.isArray(value.repos)||Array.isArray(value.nodes)||isRecord(value.tree));
}
function firstScreenTargets(snapshot,entryId,batchView){
var base={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id};
var entryPayload=assign({},base,{entry:entryId});
var interfacesPayload=assign({},base,{entry:entryId});
var viewSpec=firstScreenViewSpec(batchView,base,entryId);
return{
entryPayload:entryPayload,
interfacesPayload:interfacesPayload,
entryKey:cacheKeyFor('view.getEntry',entryPayload),
interfacesKey:cacheKeyFor('view.interfaces',interfacesPayload),
viewSpec:viewSpec,
viewKey:cacheKeyFor(viewSpec.endpoint,viewSpec.payload),
};
}
function firstScreenAllCached(targets,batchView){
if(!cacheHas(targets.entryKey)||!cacheHas(targets.interfacesKey))return false;
if(batchView==='file')return true;
return cacheHas(targets.viewKey);
}
function runEntryIndividualReads(focusFunctionId){
var reads=[loadEntryData(focusFunctionId),loadData('coupling'),loadInterfaces()];
loadActiveView();
if(reads.length>0&&typeof Promise.allSettled==='function')Promise.allSettled(reads).catch(function(){});
}
function runEntryFallback(focusFunctionId){
patchView({firstScreen:'fallback'});
runEntryIndividualReads(focusFunctionId);
}
function isCouplingProjection(value){
return isRecord(value)&&(Array.isArray(value.resources)||Array.isArray(value.functions));
}
function couplingCacheKeyFor(snapshot,entryId){
return cacheKeyFor('view.coupling',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,entry:entryId});
}
function applyFirstScreenSuccess(value,meta){
if(meta.token!==firstScreenRef.current.token)return false;
if(viewCacheGeneration!==meta.generation)return false;
var snapshot=currentSnapshot();
if(snapshot===null||snapshot.snapshot_id!==meta.snapshotId)return false;
if(copyNullableString(getViewState().selectedFunctionId)!==meta.entryId)return false;
var entryPayload=isRecord(value.entry)?value.entry:null;
var interfacesPayload=isRecord(value.interfaces)?value.interfaces:null;
var viewPayload=isRecord(value.view_payload)?value.view_payload:null;
if(entryPayload===null||interfacesPayload===null||viewPayload===null)return false;
if(!applyEntrySuccess(entryPayload,false,meta.entryId))return false;
applyInterfacesSuccess(interfacesPayload,meta.snapshotId+'|'+String(meta.entryId),false);
var viewCached=false;
if(meta.batchView==='file'){
viewCached=isFileTreeProjection(viewPayload);
}else{
applyViewSuccess(meta.batchView,viewPayload,false);
viewCached=true;
}
var couplingAux=meta.batchView!=='coupling'&&isCouplingProjection(value.coupling_aux)?value.coupling_aux:null;
if(couplingAux!==null)applyViewSuccess('coupling',couplingAux,false);
patchView({firstScreen:'batch'});
if(viewCacheGeneration===meta.generation){
cacheSet(meta.targets.entryKey,entryPayload);
cacheSet(meta.targets.interfacesKey,interfacesPayload);
if(viewCached)cacheSet(meta.targets.viewKey,viewPayload);
if(couplingAux!==null)cacheSet(couplingCacheKeyFor(snapshot,meta.entryId),couplingAux);
}
if(meta.batchView!=='coupling'&&couplingAux===null)loadData('coupling');
return true;
}
function startFirstScreen(focusFunctionId,batchView){
var snapshot=currentSnapshot();
if(snapshot===null)return false;
var targets=firstScreenTargets(snapshot,focusFunctionId,batchView);
var state=firstScreenRef.current;
cancelFirstScreen();
var token=state.token;
var controller=null;
if(typeof AbortController==='function'){
controller=new AbortController();
state.controller=controller;
}
var generation=viewCacheGeneration;
var snapshotId=snapshot.snapshot_id;
request('firstScreen','view.firstScreen',{workspace:snapshot.workspace_id,snapshot:snapshotId,entry:focusFunctionId,view:batchView},controller!==null?controller.signal:undefined).then(function(result){
if(token!==state.token)return;
state.controller=null;
if(result!==null&&result.kind==='aborted')return;
if(result===null){
var staleSnapshot=currentSnapshot();
if(staleSnapshot===null||staleSnapshot.snapshot_id!==snapshotId)return;
if(copyNullableString(getViewState().selectedFunctionId)!==focusFunctionId)return;
runEntryFallback(focusFunctionId);
return;
}
if(result.kind==='ok'&&isRecord(result.value)&&!isRecord(result.value.error)){
if(applyFirstScreenSuccess(result.value,{token:token,generation:generation,snapshotId:snapshotId,entryId:focusFunctionId,batchView:batchView,targets:targets}))return;
}else if(result.kind==='error'){
var code=String(result.code||'');
if(/UNKNOWN|UNIMPLEMENTED|NOT_SUPPORTED|METHOD_NOT_FOUND/.test(code))state.unsupported=true;
}
var current=currentSnapshot();
if(current===null||current.snapshot_id!==snapshotId)return;
if(copyNullableString(getViewState().selectedFunctionId)!==focusFunctionId)return;
runEntryFallback(focusFunctionId);
});
return true;
}
function patchStub(patch){
patchView(function(previous){
var stub=assign({},previous.stub,typeof patch==='function'?patch(previous.stub):patch);
return{stub:stub};
});
}
function stubEditResetPatch(){
return{latestGeneration:0,plan:null};
}
function selectedStubProfile(){
var stub=getViewState().stub;
return findStubProfile(stub,stub.profileId);
}
function defaultStubSteps(){
return[{interface:'',args:[]}];
}
function defaultStubArg(param){
var min=param.min!==null?param.min:(param.type==='u32'?0:-2147483648);
var max=param.max!==null?param.max:2147483647;
if(min<=0&&max>=0)return 0;
return min;
}
function loadStubProfiles(force){
var snapshot=currentSnapshot();
if(snapshot===null)return;
var workspace=snapshot.workspace_id;
var key='ws|'+String(workspace);
var stub=getViewState().stub;
if(force!==true&&stub.profiles.key===key&&(stub.profiles.state==='loading'||stub.profiles.state==='ready'||stub.profiles.state==='empty'||stub.profiles.state==='error'))return;
patchStub({profiles:{key:key,state:'loading',payload:null,error:null}});
request('stubProfiles','scenario.listProfiles',{workspace:workspace}).then(function(result){
if(!result)return;
if(result.kind==='error'){
patchStub({profiles:{key:key,state:'error',payload:null,error:result}});
return;
}
var normalized=normalizeStubProfiles(result.value);
var current=getViewState().stub;
var selected=current.profileId;
var holder={profiles:{payload:normalized}};
if(selected===null||findStubProfile(holder,selected)===null)selected=normalized.profiles.length>0?normalized.profiles[0].profile_id:null;
if(selected!==null)sessionUi.stubProfileId=selected;
var profile=findStubProfile(holder,selected);
var steps=current.steps;
var reset=profile===null||steps.length===0;
if(!reset){
for(var index=0;index<steps.length;index+=1){
if(steps[index].interface!==''&&findStubInterface(profile,steps[index].interface)===null){reset=true;break;}
}
}
patchStub({profiles:{key:key,state:normalized.profiles.length>0?'ready':'empty',payload:normalized,error:null},profileId:selected,steps:reset?defaultStubSteps():steps});
});
}
function setScenarioFocus(scenarioId,generation,callId){
var current=getUiState();
var nextScenario=copyNullableString(scenarioId)!==null?scenarioId:current.focus_scenario_id;
var nextGeneration=toSignedInteger(generation)!==null?generation:current.focus_run_generation;
var nextCall=callId===undefined?current.focus_call_id:callId;
sessionUi.scenarioId=nextScenario;
sessionUi.runGeneration=nextGeneration;
sessionUi.callId=nextCall;
patchUi({focus_scenario_id:nextScenario,focus_run_generation:nextGeneration,focus_call_id:nextCall});
}
function loadScenarioLedger(force,callback){
var snapshot=currentSnapshot();
if(snapshot===null){if(typeof callback==='function')callback();return;}
var workspace=snapshot.workspace_id;
var key='ws|'+String(workspace);
var stub=getViewState().stub;
if(force!==true&&stub.ledger.key===key&&(stub.ledger.state==='loading'||stub.ledger.state==='ready'||stub.ledger.state==='empty')){
if(typeof callback==='function')callback();
return;
}
patchStub({ledger:{key:key,state:'loading',payload:null,error:null}});
request('scenarios','scenario.list',{workspace:workspace}).then(function(result){
if(!result){if(typeof callback==='function')callback();return;}
if(result.kind==='error'){
patchStub({ledger:{key:key,state:'error',payload:null,error:result}});
if(typeof callback==='function')callback();
return;
}
var normalized=normalizeScenarioLedger(result.value);
var latest=normalized.scenarios.length>0?normalized.scenarios[0]:null;
var current=getViewState().stub;
patchStub({ledger:{key:key,state:normalized.scenarios.length>0?'ready':'empty',payload:normalized,error:null},latestScenarioId:latest!==null?latest.scenario_id:current.latestScenarioId});
var focusId=getUiState().focus_scenario_id;
var focusExists=false;
for(var fi=0;fi<normalized.scenarios.length;fi+=1){
if(normalized.scenarios[fi].scenario_id===focusId)focusExists=true;
}
if(latest!==null&&!focusExists)setScenarioFocus(latest.scenario_id,latest.generation,getUiState().focus_call_id);
if(typeof callback==='function')callback();
});
}
function ensureStubData(){
var snapshot=currentSnapshot();
if(snapshot===null)return;
var stub=getViewState().stub;
if(stub.profiles.key===null||stub.profiles.state==='idle'||stub.profiles.state==='error')loadStubProfiles(false);
if(stub.ledger.key===null||stub.ledger.state==='idle'||stub.ledger.state==='error')loadScenarioLedger(false);
}
function selectStubProfile(profileId){
var id=copyNullableString(profileId);
sessionUi.stubProfileId=id;
patchStub(assign(stubEditResetPatch(),{profileId:id,steps:defaultStubSteps(),runError:null,latest:null}));
}
function addStubStep(){
var stub=getViewState().stub;
var profile=selectedStubProfile();
var limit=profile!==null&&profile.limits&&profile.limits.steps?Math.min(MAX_STUB_STEPS,profile.limits.steps):MAX_STUB_STEPS;
if(stub.steps.length>=limit)return;
patchStub(assign(stubEditResetPatch(),{steps:stub.steps.concat([{interface:'',args:[]}])}));
}
function removeStubStep(index){
patchStub(function(stub){
var steps=stub.steps.slice();
if(index>=0&&index<steps.length)steps.splice(index,1);
return assign(stubEditResetPatch(),{steps:steps.length===0?defaultStubSteps():steps});
});
}
function moveStubStep(index,delta){
patchStub(function(stub){
var steps=stub.steps.slice();
var target=index+delta;
if(index<0||index>=steps.length||target<0||target>=steps.length)return{};
var moved=steps[index];
steps[index]=steps[target];
steps[target]=moved;
return assign(stubEditResetPatch(),{steps:steps});
});
}
function setStubStepInterface(index,name){
var profile=selectedStubProfile();
var iface=findStubInterface(profile,name);
var args=[];
if(iface!==null){
for(var pi=0;pi<iface.params.length;pi+=1)args.push(defaultStubArg(iface.params[pi]));
}
patchStub(function(stub){
var steps=stub.steps.slice();
if(index<0||index>=steps.length)return{};
steps[index]=assign({},steps[index],{interface:name,args:args});
return assign(stubEditResetPatch(),{steps:steps});
});
}
function setStubStepArg(index,argIndex,raw){
var text=typeof raw==='string'?raw.trim():String(raw===undefined||raw===null?'':raw);
var value=null;
if(text!==''&&/^-?\d+$/.test(text)){
var number=Number(text);
if(Number.isSafeInteger(number))value=number;
}
patchStub(function(stub){
var steps=stub.steps.slice();
if(index<0||index>=steps.length)return{};
var step=assign({},steps[index]);
var args=step.args.slice();
args[argIndex]=value;
step.args=args;
steps[index]=step;
return assign(stubEditResetPatch(),{steps:steps});
});
}
function toggleStubStopOnError(){
patchStub(function(stub){return assign(stubEditResetPatch(),{stopOnError:stub.stopOnError!==true});});
}
function stubUndoMax(){
var latest=getViewState().stub.latest;
if(latest===null||latest===undefined||latest.imported===true)return 0;
return latest.records.length;
}
function setUndoCount(raw){
var text=typeof raw==='string'?raw.trim():String(raw===undefined||raw===null?'':raw);
var value=parseInt(text,10);
if(!Number.isInteger(value))value=1;
patchStub({undoCount:value});
}
function setTraceInput(raw){
patchStub({traceInput:String(raw===undefined||raw===null?'':raw).slice(0,256)});
}
function invalidateObservedSequence(){
patchView(function(previous){
var data=assign({},previous.data);
delete data.sequence_observed;
return{data:data};
});
}
function runUndoTail(){
var stub=getViewState().stub;
var latest=stub.latest;
if(stub.undoBusy===true||stub.busy===true)return;
var snapshot=currentSnapshot();
if(snapshot===null||latest===null||latest===undefined)return;
if(latest.imported===true){
patchStub({undoStatus:{kind:'error',code:'UNDO_UNAVAILABLE',message:TEXT.stubUndoImported}});
return;
}
var max=latest.records.length;
if(max<1)return;
var count=parseInt(String(stub.undoCount),10);
if(!Number.isInteger(count)||count<1||count>max){
patchStub({undoStatus:{kind:'error',code:'INVALID_ARGUMENT',message:'回退步数必须在 1..'+String(max)+' 之间（当前 '+String(stub.undoCount)+'）。'}});
return;
}
var generation=toSignedInteger(latest.generation)!==null?latest.generation:0;
var payload={workspace:snapshot.workspace_id,scenario:latest.scenario_id,count:count,expected_generation:generation};
patchStub({undoBusy:true,undoStatus:{kind:'pending',count:count}});
request('stubUndo','scenario.undoTail',payload).then(function(result){
if(!result)return;
if(result.kind==='error'){
patchStub({undoBusy:false,undoStatus:{kind:'error',code:result.code,message:result.message}});
return;
}
var ledger=normalizeScenarioRun(result.value);
var prefixSteps=[];
for(var index=0;index<ledger.records.length;index+=1){
prefixSteps.push({interface:ledger.records[index].interface,args:ledger.records[index].args.slice()});
}
if(prefixSteps.length===0)prefixSteps=defaultStubSteps();
var nextCount=count;
if(nextCount<1)nextCount=1;
if(nextCount>prefixSteps.length)nextCount=prefixSteps.length;
patchStub({undoBusy:false,undoStatus:{kind:'success',count:count,scenarioId:ledger.scenario_id,generation:ledger.generation,verified:ledger.undo!==null&&ledger.undo.state_digest_verified===true},latest:ledger,latestScenarioId:ledger.scenario_id!==null?ledger.scenario_id:latest.scenario_id,latestGeneration:ledger.generation,steps:prefixSteps,undoCount:nextCount<1?1:nextCount,runError:null,notice:'回退已写入前缀台账（scenario '+String(ledger.scenario_id||'—')+' generation '+String(ledger.generation===null?'—':ledger.generation)+'）。'});
if(ledger.scenario_id!==null)setScenarioFocus(ledger.scenario_id,ledger.generation,null);
invalidateObservedSequence();
loadScenarioLedger(true);
if(getUiState().sequenceMode==='observed')loadObservedSequence();
});
}
function selectObservedScenario(scenarioId){
var id=copyNullableString(scenarioId);
if(id===null)return;
var ledger=getViewState().stub.ledger.payload;
var summary=null;
if(ledger!==null&&ledger!==undefined&&Array.isArray(ledger.scenarios)){
for(var index=0;index<ledger.scenarios.length;index+=1){
if(ledger.scenarios[index].scenario_id===id)summary=ledger.scenarios[index];
}
}
var generation=summary!==null?summary.generation:getUiState().focus_run_generation;
setScenarioFocus(id,generation,null);
invalidateObservedSequence();
if(getUiState().sequenceMode==='observed')loadObservedSequence();
}
function runTraceImport(){
var stub=getViewState().stub;
if(stub.traceBusy===true)return;
var snapshot=currentSnapshot();
if(snapshot===null)return;
var input=String(stub.traceInput||'').trim();
if(input===''||!/^[A-Za-z0-9._-]{1,256}$/.test(input)||input==='.'||input==='..'){
patchStub({traceStatus:{kind:'error',code:'INVALID_ARGUMENT',message:TEXT.traceImportInvalid}});
return;
}
patchStub({traceBusy:true,traceStatus:{kind:'pending',input:input}});
request('traceImport','trace.import',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,input:input}).then(function(result){
if(!result)return;
if(result.kind==='error'){
patchStub({traceBusy:false,traceStatus:{kind:'error',code:result.code,message:result.message}});
return;
}
var ledger=normalizeScenarioRun(result.value);
patchStub({traceBusy:false,traceStatus:{kind:'success',scenarioId:ledger.scenario_id,generation:ledger.generation,label:ledger.label,imported:ledger.imported},latest:ledger,latestScenarioId:ledger.scenario_id!==null?ledger.scenario_id:getViewState().stub.latestScenarioId,latestGeneration:ledger.generation,undoCount:1,undoStatus:null,notice:'已导入轨迹台账（scenario '+String(ledger.scenario_id||'—')+' generation '+String(ledger.generation===null?'—':ledger.generation)+'）。'});
if(ledger.scenario_id!==null)setScenarioFocus(ledger.scenario_id,ledger.generation,null);
invalidateObservedSequence();
loadScenarioLedger(true);
if(getUiState().sequenceMode==='observed')loadObservedSequence();
});
}
function buildStubScenario(stub,steps,generation){
return{generation:generation,stop_on_error:stub.stopOnError===true,steps:steps.map(function(step){return{interface:step.interface,args:step.args.slice()};})};
}
function runStub(){
var stub=getViewState().stub;
if(stub.busy===true)return;
var snapshot=currentSnapshot();
if(snapshot===null)return;
var profile=selectedStubProfile();
var check=stubValidation(profile,stub);
if(check.errors.length>0){
patchStub({runError:{code:check.errors[0].code,message:check.errors[0].message},plan:null});
return;
}
var expected=stub.latest!==null&&stub.latest!==undefined&&stub.latest.imported===true?0:(toSignedInteger(stub.latestGeneration)!==null?stub.latestGeneration:0);
var payload={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,profile:profile.profile_id};
var scenario=buildStubScenario(stub,check.steps,expected);
patchStub({busy:true,runError:null,plan:null});
request('stubPreview','scenario.preview',assign({},payload,{scenario:scenario})).then(function(previewResult){
if(!previewResult)return;
if(previewResult.kind==='error'){
patchStub({busy:false,runError:previewResult});
return;
}
var plan=normalizeScenarioPlan(previewResult.value);
patchStub({plan:plan});
var runScenario=assign({},scenario,{generation:expected});
request('stubRun','scenario.run',assign({},payload,{scenario:runScenario,expected_generation:expected})).then(function(runResult){
if(!runResult)return;
if(runResult.kind==='error'){
patchStub({busy:false,runError:runResult});
if(runResult.code==='STATE_CONFLICT')loadScenarioLedger(true);
if(runResult.code==='OUTCOME_UNKNOWN'||runResult.code==='TRANSPORT_FAILURE')loadScenarioLedger(true);
return;
}
var latest=normalizeScenarioRun(runResult.value);
var currentStub=getViewState().stub;
patchStub({busy:false,runError:null,latest:latest,latestScenarioId:latest.scenario_id!==null?latest.scenario_id:currentStub.latestScenarioId,latestGeneration:latest.generation!==null?latest.generation:currentStub.latestGeneration,undoStatus:null,undoCount:1,notice:'已写入运行台账（generation '+String(latest.generation===null?'—':latest.generation)+'）。'});
if(latest.scenario_id!==null)setScenarioFocus(latest.scenario_id,latest.generation,null);
patchView(function(previous){
var data=assign({},previous.data);
delete data.sequence_observed;
return{data:data};
});
loadScenarioLedger(true);
if(getUiState().sequenceMode==='observed')loadObservedSequence();
});
});
}
function observedScenarioId(){
var ui=getUiState();
var stub=getViewState().stub;
if(copyNullableString(ui.focus_scenario_id)!==null)return ui.focus_scenario_id;
if(copyNullableString(stub.latestScenarioId)!==null)return stub.latestScenarioId;
var ledger=stub.ledger.payload;
if(ledger!==null&&ledger!==undefined&&Array.isArray(ledger.scenarios)&&ledger.scenarios.length>0)return ledger.scenarios[0].scenario_id;
return null;
}
function loadObservedSequence(){
var snapshot=currentSnapshot();
var scenarioId=observedScenarioId();
if(snapshot===null||scenarioId===null){
setData('sequence_observed',{key:null,state:'empty',payload:null,error:null});
return;
}
var generation=getUiState().focus_run_generation;
var key=snapshot.snapshot_id+'|'+scenarioId+'|'+String(generation);
var existing=getViewState().data.sequence_observed;
if(existing&&existing.key===key&&(existing.state==='loading'||existing.state==='ready'||existing.state==='error'))return;
setData('sequence_observed',{key:key,state:'loading',payload:null,error:null});
var payload={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,mode:'observed',scenario:scenarioId};
request('sequenceObserved','view.sequence',payload).then(function(result){
if(!result)return;
if(result.kind==='error'){
setData('sequence_observed',{state:'error',payload:null,error:result});
return;
}
var normalized=normalizeSequence(result.value);
setData('sequence_observed',{state:normalized.messages.length>0||normalized.participants.length>0?'ready':'empty',payload:result.value,error:null});
if(normalized.scenario!==null&&normalized.scenario.scenario_id!==null)setScenarioFocus(normalized.scenario.scenario_id,normalized.scenario.generation,getUiState().focus_call_id);
});
}
function switchSequenceMode(mode){
var next=mode==='observed'?'observed':'static';
if(next===getUiState().sequenceMode)return;
patchUi({sequenceMode:next});
sessionUi.sequenceMode=next;
if(next==='observed'){
var stub=getViewState().stub;
if(stub.latestScenarioId!==null){
if(stub.ledger.state!=='ready')loadScenarioLedger(false,loadObservedSequence);
else loadObservedSequence();
}else{
loadScenarioLedger(false,loadObservedSequence);
}
}else{
loadData('sequence');
}
}
function observedSequenceScenario(){
var entry=getViewState().data.sequence_observed;
if(!entry||!isRecord(entry.payload))return null;
return normalizeSequence(entry.payload).scenario;
}
function onJumpStubRecord(record,event){
var stub=getViewState().stub;
var snapshot=currentSnapshot();
if(snapshot===null)return;
var scenarioId=stub.latestScenarioId!==null?stub.latestScenarioId:observedScenarioId();
setScenarioFocus(scenarioId,stub.latestGeneration!==null?stub.latestGeneration:getUiState().focus_run_generation,record.call_id);
var profile=selectedStubProfile();
var iface=profile!==null?findStubInterface(profile,record.interface):null;
var line=null;
var file=null;
var meta=iface!==null&&iface.entry_id!==null?locateFunctionMeta(iface.entry_id):null;
if(event!==null&&event!==undefined&&toInteger(event.line)!==null){
line=event.line;
}
if(line===null&&(event===null||event===undefined)&&meta!==null&&toInteger(meta.line)!==null)line=meta.line;
for(var index=0;index<record.events.length&&line===null;index+=1){
if(toInteger(record.events[index].line)!==null)line=record.events[index].line;
}
if(meta!==null&&copyNullableString(meta.file)!==null)file=meta.file;
if(file===null&&getViewState().entryDetail!==null)file=getViewState().entryDetail.file;
if(file===null&&remembered.file!==null)file=remembered.file.path;
if(copyNullableString(file)===null){
patchView({notice:'运行记录 '+String(record.call_id||'')+' 没有可定位的源码行（缺口）。'});
return;
}
patchUi({view:'file'});
remembered.view='file';
openFile(snapshot.repo_id,file,line,true);
ensureFileTree();
}
function setSubflow(patch){
patchUi(function(previous){
return{subflow:assign({},previous.subflow,patch)};
});
}
function subflowKey(entryId,rootId){
var snapshot=currentSnapshot();
if(snapshot===null)return null;
return snapshot.snapshot_id+'|'+String(entryId)+'|'+String(rootId);
}
function loadSubflow(){
var snapshot=currentSnapshot();
var selectedFunctionId=getViewState().selectedFunctionId;
if(snapshot===null||selectedFunctionId===null){
setSubflow({key:null,state:'empty',payload:null,error:null});
return;
}
var subflowRootId=getUiState().subflowRootId;
var rootId=subflowRootId!==null?subflowRootId:currentEntryId();
var key=subflowKey(selectedFunctionId,rootId);
var existing=getUiState().subflow;
if(existing&&existing.key===key&&(existing.state==='loading'||existing.state==='ready'||existing.state==='empty'||existing.state==='error'))return;
setSubflow({key:key,state:'loading',payload:null,error:null,entryId:selectedFunctionId,rootId:rootId});
var payload={workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,entry:selectedFunctionId};
if(rootId!==null&&rootId!==selectedFunctionId)payload.root=rootId;
request('subflow','view.endToEnd',payload).then(function(result){
if(!result)return;
if(result.kind==='error'){
setSubflow({state:'error',error:result,payload:null});
return;
}
var normalized=normalizeEndToEnd(result.value);
setSubflow({state:normalized.nodes.length>0?'ready':'empty',payload:result.value,error:null});
});
}
function switchDetailsTab(tab){
var nextTab=tab==='subflow'||tab==='resources'?tab:'source';
patchUi({detailsTab:nextTab});
sessionUi.detailsTab=nextTab;
if(nextTab==='subflow'){
if(getUiState().subflowRootId===null){
var rootId=currentEntryId();
patchUi({subflowRootId:rootId});
sessionUi.subflowRootId=rootId;
}
loadSubflow();
}
}
function onCrumbClick(crumb,index){
var snapshot=currentSnapshot();
if(snapshot===null)return;
if(index===0){

patchUi({detailsTab:'source',subflowRootId:null,view:'end_to_end'});
sessionUi.detailsTab='source';
sessionUi.subflowRootId=null;
remembered.view='end_to_end';
setSubflow({key:null,state:'idle',payload:null,error:null,entryId:null,rootId:null});
loadData('end_to_end');
return;
}
patchUi({subflowRootId:crumb.function_id});
sessionUi.subflowRootId=crumb.function_id;
setSubflow({key:null,state:'idle',payload:null,error:null});
loadSubflow();
}
function onSelectSubflowNode(node){
if(node.function_id===null)return;
selectFunctionById(node.function_id,{name:node.label,file:node.file,line:node.line},{jumpFile:false});
}
function setGroupCollapsed(groupId,collapsed){
var map=assign({},getViewState().groupCollapsed);
map[groupId]=collapsed===true;
sessionUi.groupCollapsed=map;
patchView({groupCollapsed:map});
patchUi({focus_group_id:groupId});
sessionUi.focusGroupId=groupId;
}
function setAllGroupsCollapsed(collapsed){
var payload=getViewState().data.end_to_end&&getViewState().data.end_to_end.payload;
var groups=payload?normalizeEndToEnd(payload).groups:[];
var map=assign({},getViewState().groupCollapsed);
for(var index=0;index<groups.length;index+=1)map[groups[index].group_id]=collapsed===true;
sessionUi.groupCollapsed=map;
patchView({groupCollapsed:map});
}
function saveGroupOverride(groupId,label,description){
var overrides=assign({},getViewState().groupOverrides);
overrides[groupId]={label:typeof label==='string'?label:'',description:typeof description==='string'?description:''};
sessionUi.groupOverrides=overrides;
patchView({groupOverrides:overrides});
patchUi({focus_group_id:groupId});
sessionUi.focusGroupId=groupId;
}
function addInterface(candidate){
var map=assign({},getViewState().addedInterfaces);
map[candidate.interface_id]=candidate;
sessionUi.addedInterfaces=map;
patchView({addedInterfaces:map});
patchUi({focus_interface_id:candidate.interface_id});
sessionUi.focusInterfaceId=candidate.interface_id;
}
function removeInterface(candidate){
var map=assign({},getViewState().addedInterfaces);
delete map[candidate.interface_id];
var expanded=assign({},getViewState().blackboxExpanded);
delete expanded[candidate.interface_id];
sessionUi.addedInterfaces=map;
sessionUi.blackboxExpanded=expanded;
patchView({addedInterfaces:map,blackboxExpanded:expanded});
}
function toggleBlackbox(interfaceId){
var expanded=assign({},getViewState().blackboxExpanded);
expanded[interfaceId]=expanded[interfaceId]!==true;
sessionUi.blackboxExpanded=expanded;
patchView({blackboxExpanded:expanded});
patchUi({focus_interface_id:interfaceId});
sessionUi.focusInterfaceId=interfaceId;
}
function loadActiveView(){
var active=getUiState().view;
if(active==='coupling')return;
if(active==='file')prepareFileView();
else loadData(active);
}
function viewDataState(name){
if(name==='file')return fileViewState(getViewState().file);
var snapshot=currentSnapshot();
if(snapshot===null)return 'empty';
var data=getViewState().data[name];
if(!data)return NEEDS_ENTRY[name]!==false&&currentEntryId()===null?'empty':'loading';
return data.state||'loading';
}
function fileViewState(file){
if(file.treeLoading===true||file.readLoading===true)return 'loading';
if(file.treeError!==null||file.readError!==null)return 'error';
if(file.tree===null)return 'loading';
var tree=normalizeFileTree(file.tree);
var fileCount=0;
for(var index=0;index<tree.repos.length;index+=1)fileCount+=tree.repos[index].files.length;
if(fileCount===0)return 'empty';
if(file.selectedPath===null)return 'loading';
return 'ready';
}
function ensureFileTree(){
var snapshot=currentSnapshot();
if(snapshot===null)return Promise.resolve(null);
var file=getViewState().file;
if(file.tree!==null&&file.treeKey===snapshot.snapshot_id)return Promise.resolve(file.tree);
patchFile({treeLoading:true,treeError:null});
return request('fileTree','view.fileTree',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id},undefined,{cache:true}).then(function(result){
if(!result)return null;
if(result.kind==='error'){
patchFile({treeLoading:false,treeError:result});
return null;
}
patchFile({treeLoading:false,treeError:null,tree:result.value,treeKey:snapshot.snapshot_id});
if(getUiState().view==='file'&&getViewState().file.selectedPath===null)chooseDefaultFile(result.value);
return result.value;
});
}
function defaultFileTarget(treePayload){
var snapshot=currentSnapshot();
var repo=snapshot!==null?snapshot.repo_id:null;
if(remembered.file!==null&&copyNullableString(remembered.file.path)!==null)return remembered.file;
var focus=remembered.focus;
if(focus!==null&&copyNullableString(focus.file)!==null)return{repo:repo,path:focus.file,line:focus.line};
var detail=getViewState().entryDetail;
if(detail!==null&&copyNullableString(detail.file)!==null)return{repo:repo,path:detail.file,line:toInteger(detail.line)};
var entry=getViewState().entry;
if(entry!==null&&copyNullableString(entry.file)!==null)return{repo:repo,path:entry.file,line:toInteger(entry.line)};
return null;
}
function chooseDefaultFile(treePayload){
var target=defaultFileTarget(treePayload);
if(target===null){
var tree=normalizeFileTree(treePayload);
for(var ri=0;ri<tree.repos.length&&target===null;ri+=1){
if(tree.repos[ri].files.length>0)target={repo:tree.repos[ri].repo_id,path:tree.repos[ri].files[0].path,line:null};
}
}
if(target!==null)openFile(target.repo,target.path,target.line,true);
}
function prepareFileView(){
ensureFileTree().then(function(treePayload){
if(treePayload===null)return;
if(getViewState().file.selectedPath!==null)return;
chooseDefaultFile(treePayload);
});
}
function loadFileRead(repo,path){
var snapshot=currentSnapshot();
if(snapshot===null||path===null)return;
var key=snapshot.snapshot_id+'|'+String(repo)+'|'+path;
patchFile({readLoading:true,readError:null,read:null,readKey:key});
request('fileRead','view.fileRead',{workspace:snapshot.workspace_id,snapshot:snapshot.snapshot_id,repo:repo,path:path,max_lines:MAX_FILE_LINES},undefined,{cache:true}).then(function(result){
if(!result)return;
if(result.kind==='error'){
patchFile({readLoading:false,readError:result});
return;
}
patchFile({readLoading:false,readError:null,read:result.value,readKey:key});
});
}
function openFile(repo,path,line,silent){
if(copyNullableString(path)===null)return;
patchFile({selectedRepo:repo,selectedPath:path,highlightLine:line===null||line===undefined?null:line});
remembered.file={repo:repo,path:path,line:line===null||line===undefined?null:line};
loadFileRead(repo,path);
if(silent!==true)ensureFileTree();
}
function locateFunctionMeta(functionId){
if(functionId===null)return null;
var current=getViewState();
if(current.entryDetail!==null&&current.entryDetail.entry_id===functionId){
return{name:copyNullableString(current.entryDetail.name),file:copyNullableString(current.entryDetail.file),line:toInteger(current.entryDetail.line)};
}
if(current.entry!==null&&current.entry.entry_id===functionId){
return{name:copyNullableString(current.entry.name),file:copyNullableString(current.entry.file),line:toInteger(current.entry.line)};
}
var couplingEntry=current.data.coupling;
if(couplingEntry&&isRecord(couplingEntry.payload)){
var coupling=normalizeCoupling(couplingEntry.payload);
for(var fi=0;fi<coupling.functions.length;fi+=1){
if(coupling.functions[fi].function_id===functionId){
return{name:coupling.functions[fi].name,file:coupling.functions[fi].file,line:coupling.functions[fi].line};
}
}
}
var treeEntry=current.data.tree;
if(treeEntry&&isRecord(treeEntry.payload)){
var tree=normalizeTree(treeEntry.payload);
for(var ni=0;ni<tree.nodes.length;ni+=1){
if(tree.nodes[ni].symbol.function_id===functionId){
return{name:tree.nodes[ni].symbol.name,file:tree.nodes[ni].symbol.file,line:tree.nodes[ni].symbol.line};
}
}
}
var graphEntry=current.data.end_to_end;
if(graphEntry&&isRecord(graphEntry.payload)){
var graph=normalizeEndToEnd(graphEntry.payload);
for(var gi=0;gi<graph.nodes.length;gi+=1){
if(graph.nodes[gi].function_id===functionId){
return{name:graph.nodes[gi].label,file:graph.nodes[gi].file,line:graph.nodes[gi].line};
}
}
}
return null;
}
function selectFunctionById(functionId,meta,options){
var opts=options||{};
var snapshot=currentSnapshot();
if(snapshot===null||functionId===null)return;
var info=meta||locateFunctionMeta(functionId)||{name:functionId,file:null,line:null};
patchView({selectedFunctionId:functionId,selectedFunctionName:info.name||functionId});
patchUi({
details:{kind:'function',function_id:functionId},
focus_callsite_id:copyNullableString(opts.callsiteId)!==null?opts.callsiteId:null,
});
remembered.details={kind:'function',function_id:functionId};
remembered.callsite_id=copyNullableString(opts.callsiteId)!==null?opts.callsiteId:null;
if(opts.resourceId!==undefined)remembered.resource_id=opts.resourceId;
remembered.focus={function_id:functionId,name:info.name||null,file:info.file,line:info.line};
loadEntryData(functionId);
if(getUiState().detailsTab==='subflow'){
setSubflow({key:null,state:'idle',payload:null,error:null,entryId:functionId,rootId:getUiState().subflowRootId});
loadSubflow();
}
if(opts.jumpFile===true&&copyNullableString(info.file)!==null){
patchUi({view:'file'});
remembered.view='file';
openFile(snapshot.repo_id,info.file,info.line,true);
ensureFileTree();
}
}
function selectResource(resource,options){
var opts=options||{};
var snapshot=currentSnapshot();
if(resource===null)return;
patchUi({focus_resource_id:resource.resource_id,focus_callsite_id:null});
remembered.resource_id=resource.resource_id;
remembered.callsite_id=null;
if(copyNullableString(resource.file)!==null){
remembered.file={repo:snapshot!==null?snapshot.repo_id:null,path:resource.file,line:resource.line};
}
if(opts.openDetails===true){
patchUi({details:{kind:'resource',resource_id:resource.resource_id}});
remembered.details={kind:'resource',resource_id:resource.resource_id};
}
if(opts.ensureCoupling===true&&getUiState().view!=='coupling')switchView('coupling');
}
function switchView(name){
if(VIEW_KEYS.indexOf(name)<0)return;
patchUi({view:name});
remembered.view=name;
if(name==='file'){
var target=remembered.file;
var currentFile=getViewState().file;
if(target!==null&&copyNullableString(target.path)!==null){
if(currentFile.selectedPath!==target.path)openFile(target.repo,target.path,target.line,true);
else if(currentFile.highlightLine!==target.line)patchFile({highlightLine:target.line});
ensureFileTree();
return;
}
prepareFileView();
return;
}
if(name==='sequence'){
var stubState=getViewState().stub;
if(stubState.ledger.state==='ready'||stubState.latestScenarioId!==null){
if(getUiState().sequenceMode==='observed')loadObservedSequence();
}else{
loadScenarioLedger(false,function(){if(getUiState().sequenceMode==='observed')loadObservedSequence();});
}
}
loadData(name);
}
function onBlankCanvas(){
patchUi({details:null,focus_resource_id:null,focus_callsite_id:null,focus_group_id:null,focus_interface_id:null});
patchView({summary:createInitialSummaryState(),entrySummary:createInitialSummaryState()});
sessionUi.focusGroupId=null;
sessionUi.focusInterfaceId=null;
remembered.details=null;
remembered.resource_id=null;
remembered.callsite_id=null;
patchView({selectedFunctionId:null,selectedFunctionName:null});
}
function onSelectGroup(groupId){
var id=copyNullableString(groupId);
if(id===null)return;
patchUi({details:{kind:'group',group_id:id},focus_group_id:id,focus_interface_id:null});
sessionUi.focusGroupId=id;
remembered.details={kind:'group',group_id:id};
patchView({notice:''});
}
function onSelectInterface(interfaceId,candidate){
patchUi({focus_interface_id:interfaceId});
sessionUi.focusInterfaceId=interfaceId;
if(candidate&&candidate.function_id!==null){
selectFunctionById(candidate.function_id,{name:candidate.name,file:candidate.file,line:candidate.line},{jumpFile:false});
}else{
patchView({notice:'接口 '+candidate.name+'（黑盒摘要）'});
}
}
function onSelectMessage(message){
var snapshot=currentSnapshot();
if(snapshot===null)return;
if(message.observed===true||message.call_id!==null){
var scenario=observedSequenceScenario();
setScenarioFocus(scenario!==null?scenario.scenario_id:getUiState().focus_scenario_id,scenario!==null?scenario.generation:getUiState().focus_run_generation,message.call_id);
if(message.observed===true&&message.source_ref!==null&&copyNullableString(message.source_ref.file)!==null){
patchUi({focus_callsite_id:message.callsite_id});
remembered.callsite_id=message.callsite_id;
var refFunctionId=message.source_ref.function_id;
if(refFunctionId!==null&&locateFunctionMeta(refFunctionId)!==null){
selectFunctionById(refFunctionId,{name:message.label,file:message.source_ref.file,line:message.source_ref.line},{jumpFile:true});
}else{
patchUi({view:'file'});
remembered.view='file';
openFile(snapshot.repo_id,message.source_ref.file,message.source_ref.line,true);
ensureFileTree();
}
return;
}
return;
}
patchUi({focus_callsite_id:message.callsite_id});
remembered.callsite_id=message.callsite_id;
var functionId=message.function_id!==null?message.function_id:currentEntryId();
var meta=locateFunctionMeta(functionId)||locateFunctionMeta(currentEntryId());
selectFunctionById(functionId,meta,{callsiteId:message.callsite_id,jumpFile:true});
}
function onSelectGraphNode(node){
if(node.function_id!==null){
selectFunctionById(node.function_id,{name:node.label,file:node.file,line:node.line},{jumpFile:false});
return;
}
if(node.callsite_id!==null){
patchUi({focus_callsite_id:node.callsite_id});
remembered.callsite_id=node.callsite_id;
}
patchView({notice:'节点 '+node.label+'（'+graphKindLabel(node)+'）',selectedFunctionId:null,selectedFunctionName:null});
}
function onJumpDetailsFile(){
var target=detailsFileTarget();
if(target===null)return;
var snapshot=currentSnapshot();
patchUi({view:'file'});
remembered.view='file';
openFile(snapshot!==null?snapshot.repo_id:null,target.file,target.line,true);
ensureFileTree();
}
function detailsFileTarget(){
var currentUi=getUiState();
var current=getViewState();
if(currentUi.details===null)return null;
if(currentUi.details.kind==='group')return null;
if(currentUi.details.kind==='resource'){
var resource=currentUi.focus_resource_id===null?null:findResourceById(current.data.coupling&&current.data.coupling.payload,currentUi.focus_resource_id);
if(resource!==null&&resource.file!==null)return{file:resource.file,line:resource.line};
return null;
}
if(current.entryDetail!==null&&current.entryDetail.file!==null)return{file:current.entryDetail.file,line:toInteger(current.entryDetail.line)};
if(remembered.focus!==null&&copyNullableString(remembered.focus.file)!==null)return{file:remembered.focus.file,line:remembered.focus.line};
return null;
}
function onReturnToChat(){
try{
rememberCurrent();
ctx.layout.selectPanel(null);
patchView({notice:'已返回聊天。'});
}catch(error){
patchView({actionError:{kind:'error',code:'LAYOUT_UNAVAILABLE',message:safeMessage(error&&error.message)||'无法返回聊天。'}});
}
}
function onRefresh(){
openPanel();
}
useEffect(function(){
aliveRef.current=true;
openPanel();
return function(){
aliveRef.current=false;
cancelPrefetchTimer();
cancelFirstScreen();
var map=seqRef.current;
for(var name in map){
if(Object.prototype.hasOwnProperty.call(map,name))map[name]+=1;
}
};
},[]);
var gaps=collectGaps(view);
var selection=buildSelection(view,ui.focus_resource_id,ui.focus_callsite_id,ui.focus_group_id,ui.focus_interface_id,ui.subflowRootId,ui.focus_scenario_id,ui.focus_run_generation,ui.focus_call_id);
var errors=collectErrors(view);
var activeData=view.data[ui.view]||null;
if(activeData&&activeData.state==='error'&&activeData.error)errors.push(activeData.error);
if(view.interfaces.state==='error'&&view.interfaces.error)errors.push(view.interfaces.error);
if(ui.subflow.state==='error'&&ui.subflow.error)errors.push(ui.subflow.error);
if(view.stub.runError!==null&&view.stub.runError!==undefined)errors.push(view.stub.runError);
if(ui.view==='file'){
if(view.file.treeError)errors.push(view.file.treeError);
if(view.file.readError)errors.push(view.file.readError);
}
errors=errors.slice(0,4);
var overallState=computeState(view);
var activeState=viewDataState(ui.view);
var stubLedger=view.stub.ledger.payload;
var sequenceScenarios=stubLedger!==null&&stubLedger!==undefined&&Array.isArray(stubLedger.scenarios)?stubLedger.scenarios:[];
var stubScenarioAvailable=view.stub.latestScenarioId!==null||sequenceScenarios.length>0;
var couplingViewModel=view.data.coupling&&isRecord(view.data.coupling.payload)?view.data.coupling.payload:null;
var railCoupling=couplingViewModel===null?null:normalizeCoupling(couplingViewModel);
var railResources=railCoupling===null?[]:railCoupling.resources;
var selectedResource=ui.focus_resource_id===null?null:findResourceById(couplingViewModel,ui.focus_resource_id);
var detailsTarget=detailsFileTarget();
var activeSummarySubject=summarySubjectFor(view,ui);
var activeEntrySummarySubject=entrySummarySubjectFor(view,ui);
var activeEntrySummaryKey=activeEntrySummarySubject===null?null:'entry|'+activeEntrySummarySubject.id;
var entrySummaryForPanel=null;
var entrySubjectForPanel=null;
if(activeEntrySummarySubject!==null&&view.entrySummary!==null&&view.entrySummary!==undefined&&view.entrySummary.key===activeEntrySummaryKey){
entrySummaryForPanel=view.entrySummary;
entrySubjectForPanel=activeEntrySummarySubject;
}
var activeGroupInfo=ui.details!==null&&ui.details.kind==='group'?groupInfoForId(view,ui.details.group_id):null;
function renderActiveView(){
if(ui.view==='coupling'){
return el(CouplingView,{
payload:activeData.payload,
focusResourceId:ui.focus_resource_id,
selectedFunctionId:view.selectedFunctionId,
entryId:currentEntryId(),
onSelectFunction:function(node){
selectFunctionById(node.function_id,{name:node.name,file:node.file,line:node.line},{jumpFile:false});
},
onSelectResourceNode:function(resource){selectResource(resource,{openDetails:false});},
onBlank:onBlankCanvas,
});
}
if(ui.view==='tree'){
return el(TreeView,{
payload:activeData.payload,
dataKey:activeData.key||'',
selectedFunctionId:view.selectedFunctionId,
addedInterfaces:view.addedInterfaces,
blackboxExpanded:view.blackboxExpanded,
onExpandBlackbox:function(candidate){toggleBlackbox(candidate.interface_id);},
onSelectNode:function(node,options){
var jump=options&&options.jumpFile===true;
selectFunctionById(node.symbol.function_id,{name:node.symbol.name,file:node.symbol.file,line:node.symbol.line},{jumpFile:jump});
},
});
}
if(ui.view==='end_to_end'){
return el(EndToEndView,{
payload:activeData.payload,
dataKey:activeData.key||'',
selectedFunctionId:view.selectedFunctionId,
groupCollapsed:view.groupCollapsed,
groupOverrides:view.groupOverrides,
addedInterfaces:view.addedInterfaces,
blackboxExpanded:view.blackboxExpanded,
focusGroupId:ui.focus_group_id,
focusInterfaceId:ui.focus_interface_id,
onSelectNode:onSelectGraphNode,
onBlank:onBlankCanvas,
onToggleGroup:function(groupId){setGroupCollapsed(groupId,getViewState().groupCollapsed[groupId]!==true);},
onFocusGroup:function(groupId){patchUi({focus_group_id:groupId});sessionUi.focusGroupId=groupId;},
onSelectGroup:onSelectGroup,
onSaveGroupOverride:saveGroupOverride,
onCollapseAll:function(){setAllGroupsCollapsed(true);},
onExpandAll:function(){setAllGroupsCollapsed(false);},
onToggleBlackbox:toggleBlackbox,
onSelectInterface:onSelectInterface,
});
}
if(ui.view==='sequence'){
return el(SequenceView,{
payload:activeData.payload,
observed:view.data.sequence_observed||{key:null,state:'idle',payload:null,error:null},
mode:ui.sequenceMode,
scenarioAvailable:stubScenarioAvailable,
scenarios:sequenceScenarios,
selectedScenarioId:ui.focus_scenario_id,
focusCallsiteId:ui.focus_callsite_id,
onSelectMode:switchSequenceMode,
onSelectMessage:onSelectMessage,
onSelectScenario:selectObservedScenario,
});
}
if(ui.view==='file'){
return el(FileView,{
treePayload:view.file.tree,
treeLoading:view.file.treeLoading,
treeError:view.file.treeError,
readPayload:view.file.read,
readLoading:view.file.readLoading,
readError:view.file.readError,
selectedPath:view.file.selectedPath,
highlightLine:view.file.highlightLine,
onSelectFile:function(repo,path){openFile(repo,path,null,false);},
onSelectLine:function(line){patchFile({highlightLine:line});if(remembered.file!==null)remembered.file.line=line;},
});
}
return null;
}
function emptyHint(){
if(NEEDS_ENTRY[ui.view]!==false&&currentEntryId()===null)return TEXT.viewEmptyNoEntry;
if(ui.view==='coupling')return TEXT.viewEmptyNoResources;
if(ui.view==='file')return TEXT.viewEmptyNoFiles;
return TEXT.viewEmptyNoData;
}
return el('div',{
className:'dcr-root',
'data-code-view':'panel',
'data-cache-size':String(viewCache.size),
'data-first-screen':view.firstScreen===null||view.firstScreen===undefined?undefined:view.firstScreen,
lang:'zh-CN',
role:'region',
'aria-label':PANEL_LABEL,
},
el('header',{className:'dcr-header'},
el('div',{className:'dcr-brand'},
el(CodeReaderIcon,{size:22}),
el('div',{className:'dcr-brand-text'},
el('h1',{className:'dcr-title'},PANEL_LABEL),
el('p',{className:'dcr-meta'},TEXT.subtitle)
)
),
el('div',{className:'dcr-header-actions'},
el('button',{type:'button',className:'dcr-btn dcr-btn-primary',onClick:onReturnToChat},TEXT.returnChat),
el('button',{type:'button',className:'dcr-btn',onClick:onRefresh,disabled:overallState==='loading'},TEXT.refresh)
)
),
el(StatusBar,{state:overallState,text:statusMessage(view,overallState,gaps.length,errors),gapCount:gaps.length}),
view.notice!==''?el('p',{className:'dcr-notice',role:'note'},view.notice):null,
el(ErrorSection,{errors:errors}),
el('section',{className:'dcr-scope','aria-label':TEXT.scopeTitle},
el('div',{className:'dcr-scope-line'},
el('span',{className:'dcr-scope-label'},TEXT.snapshotsTitle),
el('div',{className:'dcr-scope-body',style:{flex:'1 1 320px',minWidth:'0'}},
el(SnapshotList,{
rows:view.snapshots,
loading:view.snapshots===null&&view.snapshotsError===null&&view.phase==='loading',
error:view.snapshotsError,
selectedId:view.snapshot!==null?view.snapshot.snapshot_id:null,
onSelect:function(row){chooseSnapshotRow(row,{restore:false});},
})
)
),
el('div',{className:'dcr-scope-line'},
el('span',{className:'dcr-scope-label'},TEXT.entriesTitle),
el('div',{className:'dcr-scope-body',style:{flex:'1 1 320px',minWidth:'0'}},
el(EntryList,{
rows:view.entries,
loading:view.entriesLoading,
error:view.entriesError,
selectedEntryId:currentEntryId(),
onSelect:function(row){chooseEntryRow(row,{restore:false});},
onPrefetch:prefetchEntry,
})
)
)
),
el('div',{className:'dcr-tabs-row'},
el(Tabs,{
active:ui.view,
legendOpen:ui.legendOpen,
onSelect:switchView,
onToggleLegend:function(){patchUi({legendOpen:!getUiState().legendOpen});},
}),
el(LegendPanel,{open:ui.legendOpen})
),
el('div',{className:'dcr-layout'},
el(RailPanel,{
mode:ui.rail,
resources:railResources,
entryId:currentEntryId(),
selectedFunctionId:view.selectedFunctionId,
focusResourceId:ui.focus_resource_id,
interfaces:{state:view.interfaces.state,payload:view.interfaces.payload},
libraryOpen:ui.libraryOpen,
addedInterfaces:view.addedInterfaces,
stub:view.stub,
workspaceReady:view.snapshot!==null,
status:view.status,
stubHandlers:{
onSelectProfile:selectStubProfile,
onAddStep:addStubStep,
onRemoveStep:removeStubStep,
onMoveStep:moveStubStep,
onStepInterface:setStubStepInterface,
onStepArg:setStubStepArg,
onToggleStopOnError:toggleStubStopOnError,
onRun:runStub,
onJumpRecord:onJumpStubRecord,
onUndoCount:setUndoCount,
onUndo:runUndoTail,
onTraceInput:setTraceInput,
onTraceImport:runTraceImport,
},
onToggleLibrary:function(){
patchUi({libraryOpen:!getUiState().libraryOpen});
sessionUi.libraryOpen=!getUiState().libraryOpen;
},
onAddInterface:addInterface,
onRemoveInterface:removeInterface,
onSelectMode:function(mode){
var next=mode==='stub'?'stub':'resources';
patchUi({rail:next});
if(next==='stub')ensureStubData();
},
onSelectResource:function(resource){selectResource(resource,{openDetails:true,ensureCoupling:true});},
}),
el('div',{className:'dcr-main'},
el('section',{className:'dcr-view','data-code-view':'view','data-view':ui.view,'data-state':activeState,'data-cache':activeData&&activeData.cached===true?'hit':undefined,'data-first-screen':view.firstScreen===null||view.firstScreen===undefined?undefined:view.firstScreen},
activeState==='loading'
?el('p',{className:'dcr-view-empty',role:'status'},TEXT.viewLoading)
:activeState==='error'
?el('p',{className:'dcr-view-empty'},TEXT.viewFailed)
:activeState==='empty'
?el('p',{className:'dcr-view-empty'},emptyHint())
:renderActiveView()
),
el(DetailsPanel,{
details:ui.details,
entryData:view.entryData,
entryDetail:view.entryDetail,
entryLoading:view.entryLoading,
entryError:view.entryError,
selectedFunctionName:view.selectedFunctionName,
selectedResource:selectedResource,
jumpFile:detailsTarget,
detailsTab:ui.detailsTab,
onSelectTab:switchDetailsTab,
subflow:ui.subflow,
cacheHit:view.entryCached===true,
firstScreen:view.firstScreen,
summary:view.summary,
summarySubject:activeSummarySubject,
entrySummary:entrySummaryForPanel,
entrySubject:entrySubjectForPanel,
groupInfo:activeGroupInfo,
onCrumbClick:onCrumbClick,
onSelectSubflowNode:onSelectSubflowNode,
onJumpFile:onJumpDetailsFile,
onClose:onBlankCanvas,
}),
el(GapList,{gaps:gaps}),
el(SelectionBlock,{selection:selection})
)
)
);
}
function apply(ctx){
var styleNode=ensureStyle();
ctx.effect(function(){
return function(){
removeStyle(styleNode);
};
},'dsh-code-reader: scoped styles');
ctx.effect(function(){
return ctx.slots.inject('main',function(){
return ctx.slots.register({name:'main',key:PANEL_KEY},function CodeReaderMainSlot(){
return el(CodeReaderPanel,{ctx:ctx});
});
});
},'dsh-code-reader: main panel');
ctx.effect(function(){
return ctx.slots.inject('sidebar.panellist',function(){
return ctx.slots.register({
name:'sidebar.panellist',
id:PANEL_KEY,
order:30,
label:function(){return PANEL_LABEL;},
},CodeReaderIcon);
});
},'dsh-code-reader: sidebar entry');
}
ensureStyle();
module.exports={
name:PLUGIN_NAME,
inject:['slots','layout','connection'],
apply:apply,
};
return module.exports;
},
});