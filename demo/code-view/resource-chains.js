(function(){
  'use strict';
  const {makeResourceSlice,lockExample,normalizeResourceState}=window.ResourceChainModel;
  const labels={read:'R · 读取',write:'W · 写入',rmw:'RMW · 读改写',init:'初始化',deinit:'去初始化',alloc:'申请',free:'释放',acquire:'获取锁',release:'释放锁'};
  const state={mode:window.__CODE_VIEW_MODEL__?'source':'example',selected:['g_state'],onlyChanges:false,camera:{x:14,y:14,zoom:1},positions:{}};
  let data,graph,surface,binding;
  const main=el('main','workspace analysis-workspace');main.id='changes-workspace';main.hidden=true;
  const panel=el('section','panel rc-panel');
  const head=el('div','analysis-head');
  const heading=el('div','');heading.append(el('h2','','资源变更链'),el('p','sub','选资源看状态变化；调用过程作为背景，按入口区分上下文。'));
  const sourceLabel=el('label','rc-source-label','数据来源 '),sourceSelect=el('select','');sourceSelect.setAttribute('aria-label','资源变更链数据来源');
  if(!window.__CODE_VIEW_MODEL__){const option=el('option','','锁上下文示意 C · 未执行');option.value='example';sourceSelect.append(option);}
  const sourceOption=el('option','',window.__CODE_VIEW_MODEL__?'当前静态快照':'当前通信驱动 C');sourceOption.value='source';sourceSelect.append(sourceOption);sourceSelect.value=state.mode;sourceLabel.append(sourceSelect);head.append(heading,sourceLabel);
  const caseData=JSON.parse(document.getElementById('resource-context-case').textContent);
  if(!window.__CODE_VIEW_MODEL__){const option=el('option','',caseData.title+' · 源码案例');option.value='reviewed';sourceSelect.append(option);}
  const notice=el('p','rc-provenance');notice.id='resource-chain-provenance';
  const choices=el('div','rc-choices');choices.setAttribute('aria-label','关注资源多选');
  const choiceToggle=el('button','rc-choice-toggle','');choiceToggle.type='button';choiceToggle.setAttribute('aria-controls','resource-chain-choices');choices.id='resource-chain-choices';
  state.choicesCollapsed=matchMedia('(max-width:760px)').matches;state.selectedInstance='';
  const current=el('p','rc-current');current.setAttribute('aria-live','polite');
  choiceToggle.onclick=()=>{state.choicesCollapsed=!state.choicesCollapsed;renderChoices();window.dispatchEvent(new Event('code-workbench-state'));};
  const tools=el('div','rc-actions');
  const presets=el('div','side-actions');
  const focusState=el('button','','关注共享状态'),focusLocks=el('button','','关注锁 / 标志'),all=el('button','','全部资源'),clear=el('button','','清空');
  for(const button of [focusState,focusLocks,all,clear]){button.type='button';presets.append(button);}
  const filterLabel=el('label','rc-filter'),filter=el('input','');filter.type='checkbox';filterLabel.append(filter,'只看修改与生命周期');
  const search=el('input','');search.placeholder='定位函数 / 字段，按 Enter';search.setAttribute('aria-label','资源链函数或字段搜索');
  const coverage=el('span','sub');coverage.id='resource-chain-coverage';tools.append(presets,filterLabel,search,coverage);
  const hint=el('div','rc-legend');hint.append(el('span','rc-dot selected','关注资源 / 字段动作'),el('span','rc-dot context','灰色：调用背景'),el('span','rc-dot held','紫带：示例持锁 / 模拟区间'),el('span','rc-dot unknown','琥珀徽标：保护未知'));
  const canvas=el('div','');canvas.id='resource-chain-canvas';
  panel.append(head,notice,choiceToggle,choices,tools,current,hint,canvas);main.append(panel);document.querySelector('header').after(main);
  const caseView=window.ResourceContextView.create(panel,caseData,{el,graphSurface,bindCanvas,canvasPort});
  function showReviewed(open){
    for(const node of [choiceToggle,choices,tools,current,hint,canvas])node.hidden=open||(node===choices&&state.choicesCollapsed);
    if(open){notice.textContent='固定源码 '+caseData.commit.slice(0,12)+' · 人工核对 · 未构建、未运行；与真实快照来源隔离';caseView.show();}else caseView.hide();
  }
  const tab=el('button','','资源变更链');tab.type='button';tab.dataset.view='changes';tab.setAttribute('aria-pressed','false');tab.setAttribute('aria-controls','changes-workspace');document.querySelector('.view-switch').append(tab);
  const inspector=el('section','code-panel rc-inspector');inspector.id='resource-chain-detail';inspector.hidden=true;
  inspector.setAttribute('aria-label','资源链源码与上下文');const inspectorHead=el('div','code-head');const inspectorTitle=el('h2','');const close=el('button','','关闭');close.type='button';close.onclick=()=>inspector.hidden=true;inspectorHead.append(inspectorTitle,close);
  const inspectorBody=el('div','rc-detail-body');inspector.append(inspectorHead,inspectorBody);document.body.append(inspector);

  function sourceData(){
    const catalog={},fns={},entryNames=Object.keys(interfaceLabels);
    for(const [key,spec]of Object.entries(resources)) {
      const v=variables[key],presentation=resourcePresentation[key]||{},name=presentation.name||v?.name||key;
      catalog[key]={name,kind:spec[0],intro:presentation.intro||spec[6],colors:presentation.colors||['#20436a','#97ccff'],fields:Object.entries(presentation.fields||presentation.bits||{}).map(([field,note])=>[field,note[0]]),definition:v?(files[v.file]||[]).slice(v.first-1,v.last).join('\n'):'当前没有已加载的定义'};
    }
    for(const [key,fn]of Object.entries(functions)) {
      const text=(files[fn.file]||[]).join('\n'),body=(files[fn.file]||[]).slice(fn.first-1,fn.last),effects=[];
      for(const [resource,spec]of Object.entries(resources)) {
        if(window.__CODE_VIEW_MODEL__){for(const effect of window.__CODE_VIEW_MODEL__.resourceEffects?.[resource]||[])if(effect.function===key)effects.push({...effect,source:{...effect.source,text:(files[effect.source.file]||[]).join('\n')}});continue;}
        const name=catalog[resource].name;
        for(const [kind,list]of [['init',Array.isArray(spec[1])?spec[1]:[]],['write',spec[2]],['deinit',spec[3]],['read',spec[5]]])if((list||[]).includes(key)) {
          const matching=body.map((line,i)=>({text:line||'',line:fn.first+i})).filter(row=>row.text.includes(name));
          const assignments=kind==='write'?matching.filter(row=>/=(?!=)|\+\+|--/.test(row.text)&&row.text.split(/=(?!=)|\+\+|--/)[0].includes(name)):[];
          if(assignments.length)for(const row of assignments)effects.push({resource,access:/\+=|-=|\+\+|--/.test(row.text)?'rmw':kind,expression:row.text.trim().replace(/;\s*$/,''),certainty:'源码表达式；动作分类来自已有注解',source:{file:fn.file,line:row.line,text}});
          else effects.push({resource,access:kind,expression:`${name}（已有注解；访问点待核验）`,certainty:'已有资源注解，不代表已定位直接访问或实际分配/释放',source:{file:fn.file,line:fn.first,text}});
        }
      }
      fns[key]={label:(fn.name||key)+'()',calls:fn.calls.filter(c=>functions[c]),domain:fn.domain|| (fn.repo==='platform'?'library':'kernel'),effects,source:{file:fn.file,line:fn.first,last:fn.last,text}};
    }
    const spans=[];
    if(!window.__CODE_VIEW_MODEL__&&functions.dispatch_transfer){const descendants=new Set();const visit=k=>{if(descendants.has(k))return;descendants.add(k);for(const c of functions[k]?.calls||[])visit(c);};visit('dispatch_transfer');spans.push({entry:'bus_send',lock:'transfer_lock',functions:[...descendants],status:'simulated',label:'transfer_lock = 1 … 0 · 模拟区间，非互斥锁',acquire:'bus_send: transfer_lock = 1',release:'bus_send: transfer_lock = 0'});}
    return {id:'source',label:window.__CODE_VIEW_MODEL__?'当前静态快照':'当前通信驱动 C',note:window.__CODE_VIEW_MODEL__?'已加载静态函数/资源范围内的调用关系；调用点可能合并，真实锁保护仍未知。':'当前 bus.c / platform.c 的源码与样例注解；transfer_lock 仅为模拟标志。',resources:catalog,functions:fns,entries:entryNames,entryNotes:{},lockSpans:spans};
  }
  function loadMode(reset=true){
    data=state.mode==='example'?lockExample():sourceData();
    if(reset){state.selected=state.mode==='example'?['g_state']:[...Object.keys(data.resources).filter(k=>/routes|staged_lengths/.test(data.resources[k].name)).slice(0,1)];state.positions={};state.camera={x:14,y:14,zoom:1};}
    state.selected=state.selected.filter(k=>data.resources[k]);sourceSelect.value=state.mode;notice.textContent=data.note;surface=undefined;renderChoices();renderGraph();applyFocus();
  }
  function changeSelection(keys){state.selected=[...new Set(keys)].filter(k=>data.resources[k]);state.positions={};renderChoices();renderGraph();applyFocus();window.dispatchEvent(new Event('code-workbench-state'));}
  function renderChoices(){
    choices.hidden=state.choicesCollapsed;choiceToggle.setAttribute('aria-expanded',String(!state.choicesCollapsed));choiceToggle.textContent=(state.choicesCollapsed?'展开资源选择':'收起资源选择')+' · '+state.selected.length+' 个关注资源';
    choices.replaceChildren(...Object.entries(data.resources).map(([key,r])=>{
      const label=el('label','rc-choice'+(state.selected.includes(key)?' checked':''));label.style.setProperty('--rc-accent',r.colors[1]);
      const check=el('input','');check.type='checkbox';check.checked=state.selected.includes(key);check.dataset.resourceChoice=key;check.onchange=()=>changeSelection(check.checked?[...state.selected,key]:state.selected.filter(k=>k!==key));
      const text=el('span','');text.append(el('code','',r.name),el('small','',r.kind));label.append(check,text);return label;
    }));
  }
  function inspectResource(key){
    const r=data.resources[key];inspectorTitle.textContent=r.name+' · '+r.kind;const definition=el('pre','',r.definition||'定义待加载'),notes=el('dl','');
    for(const [field,note]of r.fields||[])notes.append(el('dt','',field),el('dd','',note));inspectorBody.replaceChildren(el('p','',r.intro),definition,notes);inspector.hidden=false;
  }
  function inspectNode(n){
    state.selectedInstance=n.id;
    if(state.mode==='source'&&functions[n.function])locateResourceFunction(n.function,pathFromEntry(n.entry,n.function));
    reflectFunction(false);window.dispatchEvent(new Event('code-workbench-state'));
    inspectorTitle.textContent=n.label+' · '+(data.functions[n.entry]?.label||n.entry);
    const info=n.lockStatus==='example-held'?'此调用实例处于示例标注的持锁范围；不是自动锁分析结果。':n.lockStatus==='simulated'?'此调用位于 transfer_lock 的模拟标志区间，不证明互斥。':'该调用上下文的锁保护未知；不据此判定无锁或竞态。';
    const rows=n.effects.map(e=>el('p','',`${labels[e.access]||e.access} ${data.resources[e.resource]?.name||e.resource} · ${e.expression}`));
    const code=el('pre','');for(const [i,line]of (n.source?.text||'/* 源码未加载 */').split('\n').entries()) {const row=el('span','line'+(i+1===(n.source?.line)?' hit':''));row.append(el('span','line-no',i+1),document.createTextNode(line));code.append(row);}
    const where=el('p','sub',`${n.source?.file||'未知来源'}:${n.source?.line||'?'} · ${data.id==='lock-example'?'示意 C，未执行':'静态源码 / 注解'}`);inspectorBody.replaceChildren(el('p','',info),where,...rows,code);inspector.hidden=false;
    requestAnimationFrame(()=>code.querySelector('.hit')?.scrollIntoView({block:'center'}));
  }
  function renderGraph(){
    graph=makeResourceSlice(data,state.selected,{maxNodes:320,onlyChanges:state.onlyChanges});
    coverage.textContent=state.selected.length?`${state.selected.length} 个关注资源 · ${graph.entries.length} 个相关入口 · ${graph.nodes.length}/${graph.totalNodes} 个调用实例${graph.truncated?' · 已截断':''}`:'尚未选择资源';
    const previous=surface?.readCamera?.()||state.camera;
    surface=graphSurface('resource-chain','资源变更链画布');surface.shell.classList.add('resource-focus-canvas');const {world,links,svg}=surface;
    const width=238,height=142,layout={},boxes={},decorations=[],connectors=[];
    const nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
    let laneX=16;
    const shared=new Map();for(const n of graph.nodes)shared.set(n.function,(shared.get(n.function)||0)+1);
    const add=(id,node,x,y)=>{node.dataset.node=id;node.classList.add('rc-graph-node');layout[id]=[x,y];boxes[id]=node;world.append(node);};
    for(const [i,r]of graph.resources.entries()) {
      const card=el('button','node rc-resource'+(r.selected?' rc-resource-selected':' rc-dim'));card.type='button';card.dataset.chainResource=r.key;card.style.setProperty('--rc-accent',r.colors[1]);card.style.setProperty('--rc-resource-bg',r.colors[0]);
      card.append(el('span','rc-kicker',r.selected?'关注资源':'背景资源'),el('strong','node-symbol',r.name),el('span','node-label',r.intro));
      const actions=el('span','rc-card-actions');const focus=el('span','',r.selected?'✓ 已关注':'点选关注');actions.append(focus,el('span','','查看定义 ↗'));card.append(actions);
      card.onclick=e=>{if(e.ctrlKey||e.metaKey)changeSelection(state.selected.includes(r.key)?state.selected.filter(k=>k!==r.key):[...state.selected,r.key]);else{if(!state.selected.includes(r.key))changeSelection([r.key]);inspectResource(r.key);}};card.title='单击查看定义并关注；Ctrl/⌘ 多选';add('resource:'+r.key,card,16+i*(width+20),16);
    }
    const resourceRowBottom=205;
    for(const entry of graph.entries) {
      const nodes=graph.nodes.filter(n=>n.entry===entry),rows=new Map();for(const n of nodes){if(!rows.has(n.depth))rows.set(n.depth,[]);rows.get(n.depth).push(n);}
      const columns=Math.max(1,...[...rows.values()].map(row=>row.length)),laneWidth=columns*(width+20)+20;
      const lane=el('div','rc-lane');lane.style.width=laneWidth+'px';lane.append(el('strong','',data.functions[entry]?.label||entry),el('small','',data.entryNotes?.[entry]||'静态调用层级 · 不代表执行时序'));world.insertBefore(lane,links);decorations.push({type:'lane',node:lane,entry,x:laneX,width:laneWidth});
      for(const n of nodes){
        const col=rows.get(n.depth).indexOf(n),x=laneX+10+col*(width+20),y=resourceRowBottom+74+n.depth*224;
        const card=el('button','node rc-call'+(n.focusEffects.length?' rc-has-effects':' rc-dim'));card.type='button';card.dataset.chainFunction=n.function;card.dataset.chainEntry=entry;
        const top=el('div','rc-function-head');top.append(el('strong','node-symbol',n.label));if(shared.get(n.function)>1)top.append(el('span','rc-shared','共用实现'));
        card.append(top,el('span','rc-location',`${n.source?.file||'未知边界'}:${n.source?.line||'?'} · ${n.domain==='library'?'库边界':'内核态 / 示例'}`));
        const effectList=el('div','rc-effects');
        const ordered=[...n.effects].sort((a,b)=>Number(state.selected.includes(b.resource))-Number(state.selected.includes(a.resource)));
        for(const e of ordered.slice(0,2)){const r=data.resources[e.resource],active=state.selected.includes(e.resource),pill=el('span','rc-effect'+(active?'':' muted'));pill.style.setProperty('--rc-accent',r.colors[1]);pill.dataset.effectResource=e.resource;pill.append(el('b','',labels[e.access]||e.access),el('span','',e.expression));pill.title=(r.name||e.resource)+' · '+e.expression+' · '+(e.certainty||'unknown');effectList.append(pill);}
        if(ordered.length>2){const focused=ordered.slice(2).filter(e=>state.selected.includes(e.resource)).length;const more=el('span','rc-more',`+${ordered.length-2} 项${focused?' · '+focused+' 关注':''}`);more.title='点开查看全部动作';card.append(more);}
        if(!n.effects.length)effectList.append(el('span','rc-no-effect','调用背景 · 无已标注关注资源访问'));
        card.append(effectList);
        if(n.focusEffects.some(e=>!['acquire','release'].includes(e.access))){const badge=el('span','rc-protection '+(n.lockStatus==='unknown'?'unknown':'held'),n.lockStatus==='unknown'?'保护上下文未知':n.lockStatus==='simulated'?'模拟区间 · 非互斥':'示例标注 · state_lock');card.append(badge);}
        card.onclick=()=>inspectNode(n);add(n.id,card,x,y);
      }
      laneX+=laneWidth+26;
    }
    for(const span of graph.lockSpans) {
      const members=graph.nodes.filter(n=>n.entry===span.entry&&span.functions.includes(n.function));if(!members.length)continue;
      const frame=el('div','rc-lock-span'+(span.status==='simulated'?' simulated':''));frame.append(el('span','rc-lock-title',span.label),el('small','rc-lock-release','↳ '+span.release));world.insertBefore(frame,links);decorations.push({type:'lock',node:frame,members:members.map(n=>n.id)});
    }
    for(const edge of graph.edges) {
      const path=svg('path',{class:'rc-call-edge','marker-end':surface.marker('inactive')});const title=svg('title',{});title.textContent='静态调用关系；并列不代表并发或执行顺序';path.append(title);links.append(path);connectors.push({...edge,path,start:'b',end:'t'});
    }
    if(!graph.entries.length){const empty=el('p','empty',state.selected.length?'当前范围没有匹配的已标注访问链。':'先在上方勾选一个或多个资源。');empty.style.cssText='position:absolute;left:24px;top:220px';world.append(empty);}
    const maxBottom=Math.max(500,...Object.values(layout).map(([,y])=>y+height+60)),maxRight=Math.max(1100,laneX,...Object.values(layout).map(([x])=>x+width+30));
    Object.assign(world.style,{width:maxRight+'px',height:maxBottom+'px'});links.setAttribute('width',maxRight);links.setAttribute('height',maxBottom);
    const initialLayout=structuredClone(layout);
    for(const [id,position]of Object.entries(state.positions))if(layout[id])layout[id]=position;
    const camera={camera:previous||{x:14,y:14,zoom:1}};
    surface.readCamera=()=>({...camera.camera});
    const redraw=()=>{
      for(const [id,card]of Object.entries(boxes)){const [x,y]=layout[id];card.style.left=x+'px';card.style.top=y+'px';}
      for(const d of decorations) {
        if(d.type==='lane'){const members=graph.nodes.filter(n=>n.entry===d.entry).map(n=>layout[n.id]);const top=resourceRowBottom;const bottom=Math.max(top+200,...members.map(([,y])=>y+height+44));Object.assign(d.node.style,{left:d.x+'px',top:top+'px',height:(bottom-top)+'px'});}
        else{const positions=d.members.map(id=>layout[id]);const x=Math.min(...positions.map(p=>p[0]))-8,y=Math.min(...positions.map(p=>p[1]))-37,right=Math.max(...positions.map(p=>p[0]))+width+8,bottom=Math.max(...positions.map(p=>p[1]))+height+30;Object.assign(d.node.style,{left:x+'px',top:y+'px',width:(right-x)+'px',height:(bottom-y)+'px'});}
      }
      for(const c of connectors){const a=canvasPort(layout[c.from],'b',width,height),b=canvasPort(layout[c.to],'t',width,height);const y=(a.y+b.y)/2;c.path.setAttribute('d',a.y<b.y?`M${a.x} ${a.y}V${y}H${b.x}V${b.y}`:`M${a.x} ${a.y}H${a.x+width/2+24}V${b.y-15}H${b.x}V${b.y}`);}
    };
    binding=bindCanvas(surface,{state:camera,ids:Object.keys(layout),positionOf:id=>layout[id],nodeWidth:width,nodeHeight:height,move(id,next){layout[id]=next;state.positions[id]=next;},reset(){state.positions={};for(const [id,position]of Object.entries(initialLayout))layout[id]=position.slice();},redraw,onBlank:()=>inspector.hidden=true});
    canvas.replaceChildren(surface.shell);reflectFunction(false);
    const mount=()=>{camera.size=surface.viewport.clientWidth+':'+surface.viewport.clientHeight;binding.mount();state.camera=camera.camera;};
    surface.viewport.addEventListener('pointerup',()=>{state.camera=camera.camera;});surface.viewport.addEventListener('wheel',()=>{state.camera=camera.camera;},{passive:true});surface.controls.addEventListener('click',()=>{state.camera=camera.camera;});
    if(!main.hidden)mount();surface.mountReadable=mount;
  }
  function applyFocus(){
    const active=state.mode==='source'&&state.selected.length>0;
    for(const card of byId('coupling-graph').querySelectorAll('[data-node]')){const resource=card.dataset.couplingResource;card.classList.toggle('rc-focus-muted',Boolean(active&&(!resource||!state.selected.includes(resource))));card.classList.toggle('rc-focus-selected',Boolean(active&&resource&&state.selected.includes(resource)));}
    for(const edge of byId('coupling-graph').querySelectorAll('.edge')){const related=state.selected.some(key=>(edge.dataset.edge||'').startsWith(key+'-'));edge.classList.toggle('rc-focus-muted-edge',Boolean(active&&!related));}
    for(const item of byId('resource-list').querySelectorAll('[data-resource]'))item.classList.toggle('rc-focus-selected',Boolean(active&&state.selected.includes(item.dataset.resource)));
  }
  function reflectFunction(reveal){
    if(!surface||!graph)return;
    if(state.mode==='source'){
      const symbol=focusPath.at(-1),entry=focusPath[0];
      const n=graph.nodes.find(n=>n.function===symbol&&n.entry===entry)||graph.nodes.find(n=>n.function===symbol);
      state.selectedInstance=n?.id||'';
    }
    const n=graph.nodes.find(n=>n.id===state.selectedInstance);
    current.textContent=n?'当前调用：'+(data.functions[n.entry]?.label||n.entry)+' › '+n.label:state.mode==='source'&&focusPath.length?'当前函数：'+(functions[focusPath.at(-1)]?.name||focusPath.at(-1))+' · 未出现在当前资源关注链中':'点击调用卡查看实现与保护上下文';
    for(const card of surface.world.querySelectorAll('[data-chain-function]'))card.setAttribute('aria-current',String(card.dataset.node===n?.id));
    if(reveal&&n)surface.shell.dispatchEvent(new CustomEvent('center-node',{detail:n.id}));
  }
  sourceSelect.onchange=()=>{state.mode=sourceSelect.value;inspector.hidden=true;showReviewed(state.mode==='reviewed');if(state.mode==='reviewed')return;loadMode();};filter.onchange=()=>{state.onlyChanges=filter.checked;state.positions={};renderGraph();};
  focusState.onclick=()=>changeSelection(Object.keys(data.resources).filter(k=>!/锁|标志/.test(data.resources[k].kind)).slice(0,1));focusLocks.onclick=()=>changeSelection(Object.keys(data.resources).filter(k=>/锁|标志/.test(data.resources[k].kind)));all.onclick=()=>changeSelection(Object.keys(data.resources));clear.onclick=()=>changeSelection([]);
  search.onkeydown=e=>{if(e.key!=='Enter')return;e.preventDefault();const query=search.value.trim().toLowerCase();const node=graph.nodes.find(n=>n.label.toLowerCase().includes(query)||n.effects.some(e=>e.expression.toLowerCase().includes(query)));if(!query||!node)return;for(const box of surface.world.querySelectorAll('.located'))box.classList.remove('located');const target=[...surface.world.querySelectorAll('[data-node]')].find(b=>b.dataset.node===node.id);target?.classList.add('located');surface.shell.dispatchEvent(new CustomEvent('center-node',{detail:node.id}));};
  for(const button of document.querySelectorAll('.view-switch button'))button.addEventListener('click',()=>{
    const open=button.dataset.view==='changes';main.hidden=!open;
    if(open){for(const id of ['flow','coupling','text','sequence','file'])byId(id+'-workspace').hidden=true;byId('flow-caption').hidden=true;byId('legend').hidden=false;for(const other of document.querySelectorAll('.view-switch button'))other.setAttribute('aria-pressed',String(other===button));if(state.mode==='reviewed')caseView.mount();else{surface.mountReadable();reflectFunction(true);}}
    else{tab.setAttribute('aria-pressed','false');inspector.hidden=true;}applyFocus();
  });
  document.addEventListener('click',event=>{const card=event.target.closest?.('[data-coupling-resource]');if(card){showReviewed(false);state.mode='source';data=sourceData();const key=card.dataset.couplingResource;changeSelection(event.ctrlKey||event.metaKey?[...state.selected.filter(k=>data.resources[k]),key]:[key]);sourceSelect.value='source';notice.textContent=data.note;}queueMicrotask(applyFocus);});
  window.ResourceChainUI={save:()=>({mode:state.mode,selected:[...state.selected],onlyChanges:state.onlyChanges,camera:surface?.readCamera?.()||{...state.camera},positions:structuredClone(state.positions),selectedInstance:state.selectedInstance,choicesCollapsed:state.choicesCollapsed,contextCase:caseView.save()}),restore:s=>{if(!s)return;if(!window.__CODE_VIEW_MODEL__&&s.mode==='reviewed'){state.mode='reviewed';sourceSelect.value='reviewed';showReviewed(true);caseView.restore(s.contextCase);return;}showReviewed(false);state.mode=window.__CODE_VIEW_MODEL__||s.mode==='source'?'source':'example';data=state.mode==='example'?lockExample():sourceData();Object.assign(state,normalizeResourceState(data,s));filter.checked=state.onlyChanges;loadMode(false);},get graph(){return graph;},get state(){return state;}};
  loadMode();if(location.hash==='#resource-changes'||location.hash==='#control-plane'){tab.click();if(location.hash==='#control-plane'&&!window.__CODE_VIEW_MODEL__){sourceSelect.value='reviewed';sourceSelect.dispatchEvent(new Event('change'));}}
})();
