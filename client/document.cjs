'use strict';
const {installScenario,compatibleScenario}=require('./scenario.cjs');

// Keep the reference document intact in specimen mode. For snapshots, adapt
// its data declarations and the few specimen-specific decisions. Every seam
// must match once, so a changed Demo cannot silently produce a broken bundle.
function createDocument(reference, model) {
  if(!model) return reference;
  let html=reference.replaceAll('\r\n','\n');
  const replace=(from,to)=>{
    const start=html.indexOf(from);
    if(start<0 || html.indexOf(from,start+from.length)>=0)throw Error(`Demo seam drift: ${from.slice(0,80)}`);
    html=html.slice(0,start)+to+html.slice(start+from.length);
  };
  const range=(from,to,body)=>{
    const a=html.indexOf(from),b=html.indexOf(to,a+from.length);
    if(a<0||b<0)throw Error(`Demo range drift: ${from}`);
    html=html.slice(0,a)+body+html.slice(b);
  };
  const object=(name)=>{
    const token=`const ${name} = {`,a=html.indexOf(token);
    if(a<0)throw Error(`Demo object drift: ${name}`);
    let level=0,quote='',escaped=false,b=a+token.length-1;
    for(;b<html.length;b++) {
      const c=html[b];
      if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}
      if(c==='\''||c==='"'||c==='`'){quote=c;continue;}
      if(c==='{')level++;
      if(c==='}'&&!--level)break;
    }
    if(level!==0||html[b+1]!==';')throw Error(`Demo object closure drift: ${name}`);
    html=html.slice(0,a)+`const ${name} = window.__CODE_VIEW_MODEL__.${name};`+html.slice(b+2);
  };
  const json=JSON.stringify(model).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  replace('<script type="application/json" id="bundle">',`<script>window.__CODE_VIEW_MODEL__=${json};</script>\n<script type="application/json" id="bundle">`);
  for(const name of ['resourceLinks','resourcePresentation','readingSteps']) {
    range(`const ${name} = {`,'\n};',`const ${name} = window.__CODE_VIEW_MODEL__.${name}`);
    replace(`const ${name} = window.__CODE_VIEW_MODEL__.${name}\n};`,`const ${name} = window.__CODE_VIEW_MODEL__.${name};`);
  }
  range('const externalTerminals = [','\n];','const externalTerminals = []');
  replace('const externalTerminals = []\n];','const externalTerminals = [];');
  replace("const { functions, variables, events, source, platform, wasm } = JSON.parse(byId('bundle').textContent);","const { functions, variables } = window.__CODE_VIEW_MODEL__; const events = {}; const wasm = ''; const source = ''; const platform = ''; const model = window.__CODE_VIEW_MODEL__;");
  replace("const files = { 'bus.c': source.split('\\n'), 'platform.c': platform.split('\\n') };","const files = model.files;");
  for(const name of ['roles','groups','interfaceFields','contracts','resources','summariesByFunction','interfaceLabels','entryPaths','flows']) {
    object(name);
  }
  replace("const phases = { lookup_route: '路由与校验', dispatch_transfer: '传输准备', submit_buffered: '长包暂存', commit_transfer: '设备提交' };","const phases = model.phases;");
  replace('const summaries = Object.fromEntries(Object.keys(groups).map((id) => [id, groupSummary(id, groups, roles, phases)]));','const summaries = model.groupSummaries || {};');
  replace("const expandedGroups = new Set(['routeGroup', 'transferGroup']);",'const expandedGroups = new Set(model.expandedGroups);');
  range('const basic = new Set(Object.keys(contracts).filter','\n  const resources', 'const basic = new Set(model.basic);');
  object('sendLayout');replace('const sendLayout = window.__CODE_VIEW_MODEL__.sendLayout;','const sendLayout = model.flows[model.initialRoot].layout;');
  replace("let flowRoot = 'bus_send';",'let flowRoot = model.initialRoot;');
  replace('camera = saved?.camera;','camera = saved?.camera || {x:16,y:16,zoom:1};');
  replace("let focusPath = ['bus_send'];",'let focusPath = [model.initialRoot];');
  replace('function defaultPath(name) {','function defaultPath(name) {\n    if(model) return model.entryPaths[name] || [name];');
  replace('function referencePosition(name) {','function referencePosition(name) {\n    if(model) return Object.hasOwn(flows[flowRoot].layout,name) || Object.values(flows[flowRoot].nodes || {}).some(n=>n.function===name) ? null : [320,40];');
  range('const columns = [','    for (const [x, slots]','const columns = model.columns;\n');
  replace("const resourceOrder = ['route_defaults', 'routes', 'transfer_lock', 'staged_lengths', 'irq_count', 'platform_status', 'simulated_doorbell'];",'const resourceOrder = model.resourceOrder;');
  replace("release: ['去初始化', '#f0a29b'], lock: ['进入 / 退出', '#edc27e'], external: ['外部调用', '#b8c4d4'],", "release: ['去初始化 / 释放', '#f0a29b'], lock: ['加锁 / 解锁', '#edc27e'], external: ['外部调用', '#b8c4d4'], unknown: ['未知访问', '#aab6c6'],");
  replace('[symbol, verb, note, via]] of writers.entries()', '[symbol, verb, note, via, access]] of writers.entries()');
  replace("const kind = verb === '初始化' ? 'init' : verb === '去初始化' ? 'release' : name === 'transfer_lock' ? 'lock' : 'write';", "const kind = ['init','alloc'].includes(access) ? 'init' : ['deinit','free'].includes(access) ? 'release' : ['acquire','release'].includes(access) ? 'lock' : ['write','rmw'].includes(access) ? 'write' : 'unknown';");
  replace("connect(name + '-write-' + index, symbol, name, kind, verb,", "connect(name + '-write-' + index, symbol, name, kind, verb + ' · ' + resourceLinks[name].field.replaceAll(resourcePresentation[name].name + '.', ''),");
  replace("connect(name + '-read-' + index, name, symbol, 'read', verb,", "connect(name + '-read-' + index, name, symbol, 'read', verb + ' · ' + resourceLinks[name].field.replaceAll(resourcePresentation[name].name + '.', ''),");
  replace("functions[symbol].repo === 'platform'","functions[symbol].domain === 'library'");
  replace("resource.append(el('strong', 'node-symbol', name)","resource.append(el('strong', 'node-symbol', resourcePresentation[name].name || name)");
  replace("el('summary', '', name);","el('summary', '', resourcePresentation[name].name || name);");
  replace("byId('resource-definition-title').textContent = name;","byId('resource-definition-title').textContent = resourcePresentation[name].name || name;");
  replace('if (record) {','if (record?.first) {');
  replace("`${label} · ${name}()`","`${label} · ${functions[name]?.name || name}()`");
  // The shared renderer uses function keys for identity and display names for text.
  html=html.replaceAll('`${name}()`','`${functions[name]?.name || name}()`')
    .replaceAll('`${symbol}()`','`${functions[symbol]?.name || symbol}()`')
    .replaceAll('`${functionName}()`','`${functions[functionName]?.name || functionName}()`')
    .replaceAll('`${selected}()`','`${functions[selected]?.name || selected}()`')
    .replaceAll('`${flowRoot}()`','`${functions[flowRoot]?.name || flowRoot}()`');
  range('function readingNode(path) {','  function reflectReadingSelection',SNAPSHOT_TREE);
  replace("const nodes = [...byId('text-tree').querySelectorAll('[data-path]')];",`let cursor=byId('text-tree').querySelector('[data-path="'+focusPath[0]+'"]');
    for(let i=1;cursor&&i<focusPath.length;i++){cursor.open=true;cursor.dispatchEvent(new Event('toggle'));cursor=cursor.querySelector('[data-path="'+focusPath.slice(0,i+1).join('/')+'"]');}
    const nodes = [...byId('text-tree').querySelectorAll('[data-path]')];`);
  replace("byId('text-tree').append(...Object.keys(flows).map", "byId('text-tree').append(...Object.keys(interfaceLabels).map");
  // Render CFG nodes individually: control diamonds are source conditions, not
  // function boxes masquerading as guards. Clicking them opens their owner.
  replace('const boundary = boundaries[key];\n      if (boundary) {',`const boundary = boundaries[key];
      const spec = flows[flowRoot].nodes?.[key];
      if (spec) {
        const box = card(spec.function, spec.sublabel, false, pathFromEntry(flowRoot,spec.function));
        box.querySelector('.node-symbol').textContent = spec.label || functions[spec.function].name;
        box.title=spec.fullLabel || spec.label;
        box.dataset.shape = spec.shape;
        box.dataset.domain = functions[spec.function].domain || 'kernel';
        if (spec.role === 'error') {box.classList.add('reject');box.style.background='var(--error-bg)';box.style.borderColor='var(--error-border)';}
        if (spec.kind === 'external' || box.dataset.domain === 'library') box.classList.add('library-node');
        if (spec.shape === 'decision') box.classList.add('decision');
        nodes[key] = box;
      } else if (boundary) {`);
  replace('if (key === located) nodes[key].classList.add(\'located\');',"if (key === located || flows[flowRoot].nodes?.[key]?.function === located) nodes[key].classList.add('located');");
  html=html.replaceAll('summary.members.includes(name)',"summary.members.some(id=>id===name||flows[flowRoot].nodes?.[id]?.function===name)");
  replace('subflowPath.includes(member)', 'subflowPath.includes(flows[flowRoot].nodes?.[member]?.function || member)');
  replace("for (const key of ['stagingGroup', 'routeGroup', 'transferGroup', 'commitGroup']) {",`const frameOrder=[],visitedGroups=new Set();
      const visitGroup=key=>{if(visitedGroups.has(key))return;visitedGroups.add(key);for(const child of groups[key]||[])if(groups[child])visitGroup(child);frameOrder.push(key);};
      Object.keys(frames).forEach(visitGroup);
      for (const key of frameOrder) {`);
  replace("button.dataset.domain = functions[key].repo === 'driver' ? 'kernel' : 'library';","button.dataset.domain = functions[key].domain || 'kernel';");
  replace("if (functions[key].repo === 'platform') button.classList.add('library-node');","if (functions[key].domain === 'library') button.classList.add('library-node');");
  replace("const owner = Object.keys(flows).find((entry) => Object.hasOwn(flows[entry].layout, name));","const owner = Object.keys(flows).find((entry) => Object.hasOwn(flows[entry].layout, name) || Object.values(flows[entry].nodes || {}).some(n=>n.function===name));");
  html=html.replaceAll("detail: name }));","detail: Object.entries(flows[flowRoot].nodes || {}).find(([,n])=>n.function===name)?.[0] || name }));");
  replace("const query = byId('function-search').value.trim().toLowerCase();","const query = byId('function-search').value.trim().toLowerCase();");
  replace("name.toLowerCase().includes(query)","(functions[name].name || name).toLowerCase().includes(query)");
  replace("`${name} · ${functions[name].repo}`","`${functions[name].name || name} · ${functions[name].repo}`");
  replace("byId('flow-result').textContent = latest ?", "byId('flow-result').textContent = model ? latest ? '最近一次返回 '+(latest.status??'void')+' · 台账事件见执行记录；尚未投影到源码分支' : '静态关系 · 不代表实际执行顺序' : latest ?");
  replace("el('dt', '', '基于样例源码 · 离线预生成')","el('dt', '', 'AI 归纳 · 依据当前快照')");
  range("const rows = [\n        ['调用链锁保护'",'      for (const [title, value] of rows)',`const rows = [
        ['调用链锁保护', '待验证：当前快照没有可用的路径敏感锁分析'],
        ['资源申请 / 释放', '待验证：请核对当前函数源码和调用边'],
        ['直接访问的共享资源', direct.map(k=>resourcePresentation[k]?.name || k).join('、') || '当前快照无访问证据'],
        ['临界变量', '待验证：没有锁覆盖和别名证据时不推定临界区'],
      ];\n`);
  range("instantiateFixture((...args) => trace.push(args)).then",'\n</script>',`run = {entries: [], byEntry: new Map()};
  byId('run').disabled = true;
  byId('run').textContent = '无匹配的执行配置';
  byId('undo').disabled = true;
  byId('scenario').addEventListener('submit', e=>{e.preventDefault();e.stopImmediatePropagation();}, true);
  byId('flow-caption').textContent = model.caption;
  document.querySelector('.controls h2').textContent = '代码工作台';
  document.querySelector('.sample').hidden = true;
  const notice = el('details','sub');
  notice.append(el('summary','', '静态证据与覆盖范围 · '+model.gaps.length+' 项说明'));
  for(const gap of model.gaps)notice.append(el('p','',gap));
  notice.style.cssText = 'padding:6px 28px;max-width:1420px;margin:auto'; document.querySelector('header').after(notice);
  camera={x:16,y:16,zoom:1};
  // The first render below must keep readable scale. Mount can measure the
  // new viewport; its initial-size guard preserves this explicit camera.
  window.__snapshotReadableCamera=true;
  render();
`);
  replace('if (!state.camera || size !== state.size) fit(false, fitWidth);',`if (window.__snapshotReadableCamera && state.camera && state.size===undefined) {redraw();showCamera();}
      else if (!state.camera || size !== state.size) fit(false, fitWidth);`);
  range("const bend = Math.min(95, Math.max(14, Math.hypot(b.x - a.x, b.y - a.y) / 2));",'    if (label) {',`const vertical = ['t','b'].includes(start) && ['t','b'].includes(end);
    const middleX = (a.x + b.x)/2, middleY = (a.y + b.y)/2;
    path.setAttribute('d', vertical ? 'M'+a.x+' '+a.y+' V'+middleY+' H'+b.x+' V'+b.y : 'M'+a.x+' '+a.y+' H'+middleX+' V'+b.y+' H'+b.x);
`);
  html=html.replace('.edge{fill:none;stroke:#627183;stroke-width:1.5;stroke-dasharray:5 4}', '.edge{fill:none;stroke:#627183;stroke-width:1.5;stroke-dasharray:none}');
  // The snapshot has no executable module. Multi-interface order is an explicit
  // static scenario; show a static timeline instead of manufacturing events.
  range('function initSequenceView() {','initSequenceView();',STATIC_SEQUENCE);
  html=html.replaceAll('样例的 IRQ 由独立入口触发。样例未启动持续监控线程或进程。','特殊机制和持续线程仅在有源码证据时标识。')
    .replaceAll('通信驱动样例 · <code>bus_send()</code>','静态快照')
    .replaceAll('基于本次 C 执行事件','基于静态调用证据');
  return html;
}

const SNAPSHOT_TREE=`function readingNode(path) {
  const name=path.at(-1),fn=functions[name];
  const node=el('details',path.length===1?'reading-node reading-root':'reading-node');
  node.dataset.path=path.join('/');
  const heading=el('summary','');
  heading.append(el('code','',(fn.name||name)+'()'),el('span','reading-role',path.length===1?flows[name]?.title:roles[name]||fn.repo));
  heading.addEventListener('click',()=>chooseReadingPath(path,'text'));node.append(heading);
  const body=el('div','reading-body');node.append(body);let built=false;
  node.addEventListener('toggle',()=>{
    if(!node.open||built)return;built=true;
    if(basic.has(name)) {
      const facts=contracts[name]||[];body.append(el('p','sub','基础接口 · 内部实现按需查看'));
      for(const [i,label]of ['入参','出参','功能','实现','校验'].entries())body.append(el('p','',label+'：'+(facts[i]||'待归纳')));
    } else {
      const steps=el('ol','reading-steps');
      for(const note of readingSteps[name]||[summariesByFunction[name]]) {
        const [description,callee]=Array.isArray(note)?note:[note];const step=el('li','reading-step',description);
        if(callee&&functions[callee]) {
          if(path.includes(callee)||path.length>=14)step.append(el('span','sub',' · 递归 / 深层调用，停止展开'));
          else step.append(readingNode([...path,callee]));
        }
        steps.append(step);
      }
      body.append(steps);
    }
    const sourceDetails=el('details','reading-source');
    sourceDetails.append(el('summary','', '源码 · '+fn.file+':'+fn.first+'–'+fn.last),el('pre','',(files[fn.file]||[]).slice(fn.first-1,fn.last).join('\\n')));body.append(sourceDetails);
  });
  return node;
}

`;

const STATIC_SEQUENCE=`function initSequenceView() {
  const form=byId('sequence-form'), list=byId('sequence-steps'), chart=byId('sequence-chart'), status=byId('sequence-status');
  const names=Object.keys(interfaceLabels); const makeStep=key=>({key,args:(interfaceFields[key]||[]).map(([,value])=>value)}); const steps=names.slice(0,2).map(makeStep);
  function renderSteps() {
    list.replaceChildren(...steps.map((step,i)=>{
      const name=step.key;
      const row=el('div','sequence-step'),select=el('select','');
      for(const key of names){const opt=el('option','',functions[key].name);opt.value=key;opt.selected=key===name;select.append(opt);}
      select.onchange=()=>{steps[i]=makeStep(select.value);renderSteps();status.textContent='顺序已修改，请重新生成';};row.append(select);
      const args=el('div','sequence-args');for(const [p,[field,,min,max]]of (interfaceFields[name]||[]).entries()){const label=el('label','',field),input=el('input','');Object.assign(input,{type:'number',min,max,value:step.args[p]});input.oninput=()=>{step.args[p]=input.valueAsNumber;};label.append(input);args.append(label);}row.append(args);
      const actions=el('div','side-actions');
      for(const [label,to] of [['上移',i-1],['下移',i+1],['移除',-1]]){const b=el('button','',label);b.type='button';b.disabled=label!=='移除'&&(to<0||to>=steps.length);b.onclick=()=>{if(label==='移除')steps.splice(i,1);else [steps[i],steps[to]]=[steps[to],steps[i]];renderSteps();};actions.append(b);}
      row.append(actions);return row;
    }));
    byId('sequence-run').disabled=!steps.length;
  }
  byId('sequence-add').onclick=()=>{if(names.length)steps.push(makeStep(names[0]));renderSteps();};
  form.onsubmit=e=>{
    e.preventDefault();const ns='http://www.w3.org/2000/svg';
    const svg=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
    const rows=[];for(const {key,args} of steps){rows.push({key,label:functions[key].name+'('+args.join(', ')+')'});for(const call of functions[key].calls)rows.push({key:call,label:'调用 '+functions[call].name+' · '+functions[call].certainty});}
    const height=90+rows.length*46, s=svg('svg',{class:'sequence-svg',viewBox:'0 0 950 '+height,width:950,height,role:'img','aria-label':'静态接口场景时序图'});
    for(const [i,t]of ['调用方','接口 / 业务函数','库边界'].entries()){const x=110+i*350;s.append(svg('line',{class:'sequence-lane',x1:x,x2:x,y1:45,y2:height}),svg('text',{x,y:27,'text-anchor':'middle'},t));}
    rows.forEach(({key,label},i)=>{const y=75+i*46,to=functions[key].domain==='library'?810:460;s.append(svg('path',{class:'sequence-arrow',d:'M110 '+y+'H'+to+'l-8 -4m8 4l-8 4'}),svg('text',{x:130,y:y-6},label));});
    chart.replaceChildren(s);status.textContent='静态场景：所选接口顺序由你指定；内部调用为静态证据，分支是否可达和运行取值待验证。';
  };
  status.textContent='静态场景 · 当前快照没有匹配的运行配置';renderSteps();
}

`;
function withSession(html,selection,channel) {
  html=html.replaceAll('\r\n','\n');
  const couplingHook=`const positionOf = (id) => positions[id];
    const couplingState={};
    window.__couplingRead=()=>({positions,camera:couplingState.camera,size:couplingState.size});
    window.__couplingRestore=s=>{if(!s)return;positions=s.positions||positions;couplingState.camera=s.camera;couplingState.size=s.size;const v=byId('coupling-graph').querySelector('.viewport');if(v?.clientWidth){couplingState.size=v.clientWidth+':'+v.clientHeight;couplingCanvas.mount();}};
    couplingCanvas = bindCanvas(surface, {
      state: couplingState, ids:`;
  const couplingSeam='const positionOf = (id) => positions[id];\n    couplingCanvas = bindCanvas(surface, {\n      state: {}, ids:';
  if(!html.includes(couplingSeam))throw Error('Demo coupling state seam drift');
  html=html.replace(couplingSeam,couplingHook);
  const data=JSON.stringify({selection,channel}).replaceAll('<','\\u003c');
  const script=`<script>(()=>{
    const bridge=${data};
    const compatibleScenario=${compatibleScenario.toString()};
    let toolsCollapsed=bridge.selection?.toolsCollapsed??matchMedia('(max-width:760px)').matches;
    let rpcSerial=0;const pending=new Map();
    window.__codeHostRpc=(method,payload)=>new Promise((resolve,reject)=>{const id='rpc_'+(++rpcSerial);const timer=setTimeout(()=>{pending.delete(id);reject(Error('Host 请求超时，执行结果待核对台账'));},45000);pending.set(id,{resolve,reject,timer});parent.postMessage({type:'rpc',channel:bridge.channel,id,method,payload},'*');});
    window.addEventListener('message',e=>{if(e.source!==parent||e.data?.channel!==bridge.channel||e.data?.type!=='rpc-result')return;const request=pending.get(e.data.id);if(!request)return;pending.delete(e.data.id);clearTimeout(request.timer);if(e.data.error){const error=Error(e.data.error);error.code=e.data.code;error.currentGeneration=e.data.currentGeneration;request.reject(error);}else request.resolve(e.data.value);});
    function remember(){try{parent.postMessage({type:'selection',channel:bridge.channel,value:{path:focusPath,root:flowRoot,view:[...document.querySelectorAll('.view-switch button')].find(b=>b.getAttribute('aria-pressed')==='true')?.dataset.view,positions,camera,canvasSize,savedCanvases:[...savedCanvases],expandedGroups:[...expandedGroups],basic:[...basic],selected,selectedPath,subflowPath,detailTab,history,coupling:window.__couplingRead?.(),toolsCollapsed,openTextPaths:[...byId('text-tree').querySelectorAll('details[data-path][open]')].map(n=>n.dataset.path),scrollY,fileScroll:fileCode.scrollTop,hostScenario:window.__hostScenario||null}},'*');}catch{}}
    function restore(){const s=bridge.selection;if(!s)return;try{
      if(s.root&&flows[s.root])setFlowRoot(s.root);
      if(s.path?.length&&functions[s.path.at(-1)])focusPath=s.path;
      if(s.expandedGroups){expandedGroups.clear();for(const key of s.expandedGroups)if(groups[key])expandedGroups.add(key);}
      if(s.basic){basic.clear();for(const key of s.basic)if(functions[key])basic.add(key);}
      if(s.savedCanvases){savedCanvases.clear();for(const [key,value]of s.savedCanvases)if(flows[key])savedCanvases.set(key,value);}
      if(s.positions)positions=s.positions;camera=s.camera;canvasSize=s.canvasSize;
      const viewport=byId('graph').querySelector('.viewport');if(s.camera&&viewport)canvasSize=viewport.clientWidth+':'+viewport.clientHeight;
      selected=functions[s.selected]?s.selected:'';selectedPath=s.selectedPath||[];subflowPath=s.subflowPath||[];detailTab=s.detailTab||'source';
      if(!window.__CODE_VIEW_MODEL__&&s.history){history.splice(0,history.length,...s.history);replay();}else render();
      window.__hostScenario=s.hostScenario;
      document.querySelector('[data-view="'+s.view+'"]')?.click();
      window.__couplingRestore?.(s.coupling);
      for(const path of (s.openTextPaths||[]).sort((a,b)=>a.length-b.length)){const n=byId('text-tree').querySelector('[data-path="'+path+'"]');if(n){n.open=true;n.dispatchEvent(new Event('toggle'));}}
      if(s.scrollY)window.scrollTo(0,s.scrollY);if(s.fileScroll)fileCode.scrollTop=s.fileScroll;
    }catch{}}
    const observer=new MutationObserver(()=>{if(typeof run!=='undefined'&&run){observer.disconnect();restore();}});
    if(typeof run!=='undefined'&&run)restore();else observer.observe(document.getElementById('graph'),{childList:true});
    document.addEventListener('click',()=>requestAnimationFrame(remember));
    document.addEventListener('pointerup',()=>requestAnimationFrame(remember));
    document.addEventListener('wheel',()=>requestAnimationFrame(remember),{passive:true});
    document.addEventListener('keydown',()=>requestAnimationFrame(remember));
    window.addEventListener('code-workbench-state',()=>requestAnimationFrame(remember));
    document.addEventListener('click',e=>{if(e.target.closest('[data-view="files"]'))requestAnimationFrame(()=>{const fn=functions[focusPath.at(-1)];if(!fn)return;showFile(fn.repo,fn.file);for(const row of byId('file-code').querySelectorAll('.line')){const n=Number(row.querySelector('.line-no')?.textContent);row.classList.toggle('hit',n>=fn.first&&n<=fn.last);if(n===fn.first)row.scrollIntoView({block:'center'});}});});
    window.addEventListener('beforeunload',remember);
    const controls=document.querySelector('.controls'),toggle=el('button','inline-action','');toggle.type='button';toggle.setAttribute('aria-label','折叠或展开工具区');controls.prepend(toggle);
    const narrow=matchMedia('(max-width:760px)');
    function updateTools(){toggle.hidden=!narrow.matches;toggle.textContent=toolsCollapsed?'展开工具区':'收起工具区';toggle.setAttribute('aria-expanded',String(!toolsCollapsed));const compact=narrow.matches&&toolsCollapsed;for(const child of controls.children){if(child===toggle||child.tagName==='H2')continue;if(child.id==='simulation'||child.id==='resources'){child.hidden=compact||!document.querySelector('[data-side="'+child.id+'"][aria-pressed="true"]');}else child.hidden=compact;}}
    toggle.onclick=()=>{toolsCollapsed=!toolsCollapsed;updateTools();};narrow.addEventListener('change',updateTools);updateTools();
    (${installScenario.toString()})();
  })();</script>`;
  return html.replace('</html>',script+'\n</html>');
}
module.exports={createDocument,withSession};
