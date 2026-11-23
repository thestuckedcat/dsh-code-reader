(function(root){
  'use strict';
  function create(host,data,{el,graphSurface,bindCanvas,canvasPort}){
    const {buildContextGraph,relationDetail,contextAccessEdge}=root.ResourceContextModel;
    const initial=data.relations.find(r=>data.defaultResources.includes(r.resource))||data.relations[0];
    const state={view:'relations',resources:[...data.defaultResources],relation:initial?.id,context:initial?.contextIds[0],detail:'effect',positions:{},camera:null};
    const pane=el('section','rcx');pane.hidden=true;
    const intro=el('div','rcx-intro');intro.append(el('span','rcx-eyebrow','源码案例 · 非运行观测'),el('h2','',data.title),el('p','',data.intro));
    const stamp=el('p','sub',data.scope+' · '+data.commit.slice(0,12));intro.append(stamp);
    const bar=el('div','rcx-bar'),views=el('div','rcx-views'),choices=el('div','rcx-choices');
    for(const [view,label]of [['relations','资源关系总览'],['path','当前调用路径']]){const b=el('button','',label);b.type='button';b.dataset.contextView=view;b.onclick=()=>{state.view=view;state.camera=null;draw();};views.append(b);}
    for(const [key,r]of Object.entries(data.resources)){const label=el('label',''),check=el('input','');check.type='checkbox';check.checked=state.resources.includes(key);check.dataset.contextResource=key;check.onchange=()=>{state.resources=check.checked?[...state.resources,key]:state.resources.filter(k=>k!==key);draw();};label.append(check,r.name);choices.append(label);}
    bar.append(views,choices);
    const legend=el('p','rcx-legend','实线＋注释：发布/更新、读取、移除登记 · 绿色：关注资源 · 灰淡：背景 · 紫色：业务锁源码可见 · 琥珀：保护未知');
    const body=el('div','rcx-body'),canvas=el('div','rcx-canvas'),inspector=el('aside','rcx-inspector');inspector.setAttribute('aria-label','资源关系与访问上下文');
    const foot=el('details','rcx-limits');foot.append(el('summary','','来源、范围与许可'));
    foot.append(el('p','sub',data.limitations.join('；')),el('p','sub',data.sourceUrl+' @ '+data.commit+' · '+data.license));
    const license=el('pre','',data.licenseText);foot.append(license);
    body.append(canvas,inspector);pane.append(intro,bar,legend,body,foot);host.append(pane);
    let surface,layout={},binding;
    const button=(label,action,cls='')=>{const b=el('button',cls,label);b.type='button';b.onclick=action;return b;};
    const fnLabel=id=>data.functions[id]?.label||id;
    const domain=id=>({user:'用户态',kernel:'内核态',library:'库边界'}[data.functions[id]?.domain]||'执行域未知');
    function closeButton(header){header.append(button('关闭详情',()=>inspector.hidden=true,'rcx-close'));}
    function evidence(key,hit){
      const source=data.evidence[key];if(!source)return el('p','sub','该证据尚未加载');
      const box=el('section','rcx-source');box.dataset.evidence=key;
      box.append(el('p','sub',source.file+':'+source.line+'–'+source.last+' · 人工源码核对'));
      const pre=el('pre','');const highlighted=root.CHighlight?.highlightC(source.text);
      for(const [i,text]of source.text.split('\n').entries()){
        const n=source.line+i,row=el('span','line'+(n===hit?' hit':''));row.dataset.sourceLine=n;row.append(el('span','line-no',n));
        if(highlighted)for(const token of highlighted[i]||[]){const span=el('span','syntax-'+token.kind,token.text);row.append(span);}else row.append(document.createTextNode(text));pre.append(row);
      }
      box.append(pre,el('small','sub','文件 SHA-256 '+source.fileSha256));return box;
    }
    function protection(context){
      const section=el('section','rcx-protection');
      for(const [key,label]of [['business','业务流程保护'],['internal','容器内部保护']]){
        const p=context.protection[key],row=el('div','rcx-lock '+(p.status==='source-scoped'?'known':'unknown'));
        row.append(el('strong','',label+' · '+(p.status==='source-scoped'?'源码范围可见':'未知')),el('p','',p.label),el('p','sub',p.detail||'没有足够的范围证据，不能据此判定无锁。'));
        for(const ref of p.evidence||[])row.append(button('查看 '+ref,()=>{state.detail='source';showEvidence([ref],null);}));section.append(row);
      }
      return section;
    }
    function chooseContext(id,path=false){
      const relation=data.relations.find(r=>r.contextIds.includes(id));if(!relation)return;
      state.relation=relation.id;state.context=id;state.detail='effect';if(path){state.view='path';state.camera=null;}draw();
    }
    function contextCard(context,active=false){
      const card=el('section','rcx-context'+(active?' active':''));card.dataset.accessContext=context.id;
      const p=context.protection.business;card.append(el('strong','',fnLabel(context.entry)+' → '+fnLabel(context.function)),el('p','',context.effect));
      card.append(el('span','rcx-badge '+(p.status==='source-scoped'?'known':'unknown'),p.status==='source-scoped'?'业务锁范围可见':'外层保护未知'));
      const where=data.evidence[context.callsite];card.append(el('p','sub',where.file.split('/').at(-1)+':'+context.callLine));
      const actions=el('div','rcx-card-actions');actions.append(button('定位调用路径',()=>chooseContext(context.id,true)),button('查看条件与保护',()=>{chooseContext(context.id);state.detail='locks';inspect();}));card.append(actions);return card;
    }
    function showEvidence(keys,hit){
      const content=inspector.querySelector('.rcx-content');if(!content)return;content.replaceChildren(...keys.map(key=>evidence(key,hit)));
    }
    function inspect(){
      const detail=relationDetail(data,state.relation);if(!detail)return;
      const context=[...detail.contexts,...detail.relatedContexts].find(c=>c.id===state.context)||detail.contexts[0];if(!context)return;
      inspector.hidden=false;
      const resource=data.resources[detail.resource];inspector.replaceChildren();
      const header=el('div','rcx-detail-head');closeButton(header);header.append(el('span','rcx-eyebrow','资源效果 → 调用差异 → 源码依据'),el('h3','',fnLabel(detail.function)+' → '+resource.name),el('p','',detail.summary));
      header.append(el('p','sub','范围：当前人工核对的访问切片；不代表全部调用者或全部路径。'));
      const tabs=el('div','rcx-detail-tabs');
      for(const [key,label]of [['effect','效果与调用'],['locks','条件与锁'],['source','源码证据']]){const b=button(label,()=>{state.detail=key;inspect();});b.setAttribute('aria-pressed',String(state.detail===key));tabs.append(b);}
      const content=el('div','rcx-content');inspector.append(header,tabs,content);
      if(state.detail==='effect'){
        content.append(el('p','rcx-effect-summary',context.effect),el('p','sub','实例键：'+resource.keys));
        const candidates=detail.relatedContexts.length?detail.relatedContexts:detail.contexts;
        const confirmed=candidates.filter(c=>c.protection.business.status==='source-scoped').length;
        content.append(el('h3','',candidates.length>1?'共用实现的调用差异':'本关系的访问上下文'),el('p','sub',`已核对 ${candidates.length} 个上下文 · ${confirmed} 处业务锁范围可见 · ${candidates.length-confirmed} 处外层保护未知`));
        for(const c of candidates)content.append(contextCard(c,c.id===context.id));
        for(const gap of detail.gaps)content.append(el('p','sub',gap));
      }else if(state.detail==='locks'){
        content.append(el('h3','','当前调用：'+fnLabel(context.entry)),el('p','rcx-path-text',context.path.map(fnLabel).join(' › ')));
        const list=el('ul','');for(const condition of context.conditions)list.append(el('li','',condition));content.append(el('h3','','访问条件'),list,protection(context));
        content.append(button('在图中定位这条路径',()=>chooseContext(context.id,true)));
      }else showEvidence(context.evidence,context.callLine);
    }
    function inspectResource(key){
      inspector.hidden=false;const r=data.resources[key];inspector.replaceChildren(el('div','rcx-detail-head'));
      const head=inspector.firstChild;closeButton(head);head.append(el('span','rcx-eyebrow','共享资源定义与字段'),el('h3','',r.name),el('p','',r.intro),el('code','',r.symbol),el('p','sub',r.keys));
      const content=el('div','rcx-content');for(const [name,note]of r.fields){const section=el('div','rcx-field');section.append(el('code','',name),el('p','',note));content.append(section);}
      content.append(evidence(r.definition),el('p','sub','上方为共享账本单例/容器入口；字段解释由当前访问切片归纳，未宣称完整结构体分析。'));inspector.append(content);
    }
    function draw(){
      const savedCamera=surface?.readCamera?.();if(savedCamera&&state.camera)state.camera=savedCamera;
      for(const b of views.children)b.setAttribute('aria-pressed',String(b.dataset.contextView===state.view));
      const graph=buildContextGraph(data,state.resources),detail=relationDetail(data,state.relation),context=detail?.contexts.find(c=>c.id===state.context)||detail?.contexts[0];
      surface=graphSurface('resource-context','管控面资源与调用画布',[['write','#8ce7c3'],['read','#9dcaff'],['remove','#f0b589']]);
      surface.shell.classList.add('rcx-surface');surface.links.removeAttribute('aria-hidden');const {world,links,svg}=surface;
      layout={};const cards={},labels=[],edges=[];const width=240,height=150;
      function add(id,card,x,y){card.dataset.node=id;card.classList.add('node','rcx-node');layout[id]=[x,y];cards[id]=card;world.append(card);}
      if(state.view==='relations'){
        const counts={left:0,right:0,resource:0};
        for(const n of graph.nodes){
          const resource=n.type==='resource',side=resource?'resource':n.side;
          const card=button('',()=>resource?inspectResource(n.key):selectFunction(n.key));card.classList.add(resource?'rcx-resource':'rcx-function');if(!n.focused)card.classList.add('rcx-dim');
          card.style.setProperty('--rcx-accent',n.color||'#9dcaff');
          card.append(el('span','rcx-kicker',resource?n.kind:domain(n.key)+' · '+(n.role||'接口')),el('strong','',n.name||n.label),el('span','sub',resource?n.symbol:n.role));
          card.dataset[resource?'caseResource':'caseFunction']=n.key;
          const x=resource?520:side==='left'?16:1024,y=(resource?150:40)+counts[side]++*(resource?350:260);add(n.id,card,x,y);
        }
        for(const e of graph.edges){
          const color=e.action==='read'?'read':e.action==='remove'?'remove':'write',path=svg('path',{class:'rcx-edge'+(e.focused?'':' rcx-dim'),'marker-end':surface.marker(color),stroke:{read:'#9dcaff',remove:'#f0b589',write:'#8ce7c3'}[color]});links.append(path);
          const label=button(e.label,()=>{state.relation=e.id;state.context=e.contextIds[0];state.detail='effect';inspect();mark();},'rcx-edge-label');label.dataset.relation=e.id;label.classList.toggle('rcx-dim',!e.focused);label.setAttribute('aria-label',fnLabel(e.function)+'：'+e.label+' → '+data.resources[e.resource].name);world.append(label);labels.push({edge:e,label});edges.push({...e,path});
        }
      }else if(context){
        const resource=data.resources[context.resource],card=button('',()=>inspectResource(context.resource));card.classList.add('rcx-resource');card.style.setProperty('--rcx-accent',resource.color);card.append(el('span','rcx-kicker','关注资源'),el('strong','',resource.name),el('span','sub',context.effect));add('res:'+context.resource,card,390,35);
        context.path.forEach((id,i)=>{const fn=data.functions[id],card=button('',()=>{state.detail='source';inspect();showEvidence([fn.source],data.evidence[fn.source]?.line);});card.classList.add('rcx-function');if(id!==context.function)card.classList.add('rcx-dim');card.append(el('span','rcx-kicker',(i===0?'所选分析起点':'已核对关键步骤')+' · '+domain(id)),el('strong','',fn.label),el('span','sub',fn.role));add('call:'+i,card,48,35+i*220);if(i)edges.push({from:'call:'+(i-1),to:'call:'+i,path:svg('path',{class:'rcx-edge',stroke:'#7b8999','marker-end':surface.marker('inactive')})});});
        for(const edge of edges)links.append(edge.path);
        const access=contextAccessEdge(context,detail.action);edges.push({...access,path:svg('path',{class:'rcx-edge',stroke:detail.action==='read'?'#9dcaff':resource.color,'marker-end':surface.marker(access.marker)})});links.append(edges.at(-1).path);
        const tag=el('div','rcx-path-note');tag.append(el('strong','',context.protection.business.status==='source-scoped'?'业务锁：源码作用域可见':'业务锁：外层保护未知'),el('p','sub',context.protection.business.label),el('p','sub','仅展示已核对关键步骤，非完整调用树；容器内部锁见右侧详情。'));tag.classList.add(context.protection.business.status==='source-scoped'?'known':'unknown');tag.style.cssText='position:absolute;left:390px;top:235px;width:240px';world.append(tag);
      }
      const defaults=structuredClone(layout),positions=state.positions[state.view]||{};for(const [id,p]of Object.entries(positions))if(layout[id])layout[id]=p;
      const camera={camera:state.camera};surface.readCamera=()=>camera.camera&&({...camera.camera});
      const redraw=()=>{
        for(const [id,card]of Object.entries(cards)){card.style.left=layout[id][0]+'px';card.style.top=layout[id][1]+'px';}
        for(const edge of edges){const vertical=state.view==='path'&&edge.from.startsWith('call:')&&edge.to.startsWith('call:');const a=canvasPort(layout[edge.from],edge.start||(vertical?'b':'r'),width,height),b=canvasPort(layout[edge.to],edge.end||(vertical?'t':'l'),width,height);const mid=(a.x+b.x)/2;edge.path.setAttribute('d',vertical?`M${a.x} ${a.y}V${(a.y+b.y)/2}H${b.x}V${b.y}`:`M${a.x} ${a.y}H${mid}V${b.y}H${b.x}`);}
        for(const {edge,label}of labels){const a=layout[edge.from],b=layout[edge.to];label.style.left=((a[0]+b[0]+width)/2-88)+'px';label.style.top=((a[1]+b[1]+height)/2-22)+'px';}
      };
      const maxX=Math.max(700,...Object.values(layout).map(p=>p[0]+width+30)),maxY=Math.max(680,...Object.values(layout).map(p=>p[1]+height+30));world.style.width=maxX+'px';world.style.height=maxY+'px';links.setAttribute('width',maxX);links.setAttribute('height',maxY);
      binding=bindCanvas(surface,{state:camera,ids:Object.keys(layout),positionOf:id=>layout[id],nodeWidth:width,nodeHeight:height,move(id,p){layout[id]=p;(state.positions[state.view]||={})[id]=p;},reset(){state.positions[state.view]={};for(const [id,p]of Object.entries(defaults))layout[id]=p.slice();},redraw,onBlank(){inspector.hidden=true;}});
      canvas.replaceChildren(surface.shell);surface.mountReadable=()=>{binding.mount();state.camera=camera.camera;};if(!pane.hidden)surface.mountReadable();inspector.hidden=false;inspect();mark();
    }
    function mark(){for(const button of pane.querySelectorAll('[data-relation]'))button.setAttribute('aria-current',String(button.dataset.relation===state.relation));}
    function selectFunction(key){const relation=data.relations.find(r=>r.function===key&&state.resources.includes(r.resource))||data.relations.find(r=>r.function===key);if(relation){state.relation=relation.id;state.context=relation.contextIds[0];state.detail='effect';inspector.hidden=false;inspect();mark();}}
    function restore(value){if(!value||typeof value!=='object')return;state.resources=Array.isArray(value.resources)?value.resources.filter(r=>data.resources[r]):[...data.defaultResources];if(['relations','path'].includes(value.view))state.view=value.view;if(data.relations.some(r=>r.id===value.relation))state.relation=value.relation;if(data.contexts.some(c=>c.id===value.context))state.context=value.context;state.camera=null;for(const c of choices.querySelectorAll('input'))c.checked=state.resources.includes(c.dataset.contextResource);draw();}
    return {show(){pane.hidden=false;draw();},hide(){pane.hidden=true;},mount(){surface?.mountReadable();},save(){return {view:state.view,resources:[...state.resources],relation:state.relation,context:state.context};},restore,get state(){return state;}};
  }
  root.ResourceContextView={create};
})(window);
