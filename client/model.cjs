'use strict';

// The renderer consumes a small, source-independent model. IDs, not spelling,
// identify symbols. No bus-specific interpretation is applied to Atlas data.
function createModel({entries={}, details=[], coupling={}, flows=[], files=[], interfaces={}}={}) {
  const model={caption:'静态快照 · 未执行', observed:false, functions:{}, variables:{}, files:{}, resources:{}, resourceLinks:{}, resourcePresentation:{}, roles:{}, contracts:{}, basic:[], summariesByFunction:{}, readingSteps:{}, groups:{}, phases:{}, expandedGroups:[], interfaceFields:{}, interfaceLabels:{}, entryPaths:{}, flows:{}, columns:[], resourceOrder:[], gaps:[]};
  const byId=new Map(), detailById=new Map(details.map(d=>[d.entry?.entry_id,d]));
  model.resourceEffects={};
  const sourceByPath=new Map();
  const fileKey=(repo,path)=>`${repo || entries.snapshot?.repo_id || 'repo'}/${path || '(source unavailable)'}`;
  const resolveFile=(path,repo)=>{
    if(Object.hasOwn(model.files,path))return path;
    const preferred=fileKey(repo,path);
    if(Object.hasOwn(model.files,preferred))return preferred;
    const alternatives=sourceByPath.get(path) || [];
    return alternatives.length===1?alternatives[0]:preferred;
  };
  for(const f of files) {
    const key=fileKey(f.repo_id,f.path);
    const lines=Array.from({length:f.total_lines || f.line_end || f.lines?.length || 1},()=> '/* 源码未载入 */');
    for(const row of f.lines || []) lines[row.n-1]=row.text;
    model.files[key]=lines;
    sourceByPath.set(f.path,[...(sourceByPath.get(f.path)||[]),key]);
    if(f.truncated) model.gaps.push(`${key}：源码窗口已截断`);
  }
  function addFunction(row) {
    const id=row.entry_id || row.function_id;
    if(!id) return null;
    if(byId.has(id)) return byId.get(id);
    const key=`f_${byId.size}`;
    byId.set(id,key);
    const d=detailById.get(id), e=d?.entry || row;
    const file=resolveFile(e.file,d?.snapshot?.repo_id || row.repo_id);
    if(!model.files[file]) model.files[file]=row.domain==='library'?['/* 分析域边界：当前快照未提供实现。 */']:[];
    const lines=d?.source?.lines || [];
    for(const l of lines) model.files[file][l.n-1]=l.text;
    const first=e.line || row.line || 1;
    const last=d?.source?.line_end || d?.source?.end_line || lines.at(-1)?.n || first;
    model.functions[key]={id,name:e.name || row.name || id,file,repo:d?.snapshot?.repo_id || row.repo_id || entries.snapshot?.repo_id || 'repo',first,last,signature:e.signature || row.signature || e.name || id,calls:[],globals:[],domain:row.domain || 'kernel',certainty:row.certainty || 'exact',parameters:e.parameters || []};
    model.roles[key]=`${file}:${first}`;
    model.summariesByFunction[key]=(e.summary?.text || (typeof e.summary==='string'?e.summary:null) || '暂无 AI 归纳。源码、静态调用和资源访问证据可供查阅。').slice(0,500);
    return key;
  }
  for(const row of entries.entries || []) addFunction(row);
  for(const d of details) if(d.entry) addFunction(d.entry);
  for(const row of coupling.functions || []) addFunction(row);
  for(const flow of flows) for(const row of flow.nodes || []) {
    if(row.function_id && !byId.has(row.function_id))addFunction({...row,name:row.label,domain:row.domain});
    if(!row.function_id&&row.kind==='external')addFunction({entry_id:`boundary:${flow.entry?.entry_id}:${row.node_id}`,name:row.label,domain:'library',repo_id:'external',certainty:row.certainty});
  }
  for(const d of details) {
    const key=byId.get(d.entry?.entry_id); if(!key) continue;
    const notes=[];
    for(const call of d.calls || []) {
      let to=byId.get(call.target?.entry_id);
      if(!to) {
        const externalId=call.target?.entry_id || `external:${call.callsite_id || call.edge_id}`;
        to=addFunction({entry_id:externalId,name:call.target?.name || call.callsite?.expression || '未知调用',file:call.target?.file,repo_id:'external',line:call.target?.line,certainty:call.certainty,domain:'library'});
      }
      if(!model.functions[key].calls.includes(to)) model.functions[key].calls.push(to);
      notes.push({line:call.callsite?.line || 0,value:[`${call.callsite?.expression || '调用'} · ${call.certainty || 'unknown'} · L${call.callsite?.line || '?'}`,to]});
    }
    for(const line of d.source?.lines || [])if(/\b(if|else|for|while|switch|case|default|return|goto)\b/.test(line.text))notes.push({line:line.n,value:`源码 L${line.n} · ${line.text.trim()}`});
    model.readingSteps[key]=notes.length?notes.sort((a,b)=>a.line-b.line).map(n=>n.value):['没有已解析的直接调用。请查看源码中的局部控制逻辑。'];
    model.contracts[key]=[(d.entry.parameters || []).map(p=>`${p.type} ${p.name}`).join('；') || d.entry.signature || '未解析',d.entry.return_type || '见签名',model.summariesByFunction[key],model.functions[key].calls.map(k=>model.functions[k].name).join(' → ') || '在函数内部完成；见源码','未提供独立校验摘要；请核对源码条件分支'];
  }
  const colors=[['#20436a','#97ccff'],['#553e22','#ffd08a'],['#472e68','#d8b5ff'],['#194d48','#99e9d8'],['#562b4b','#ffafe0'],['#572e31','#ffb3a7'],['#354c24','#cbeea5']];
  const rawResources=(coupling.resources || []).filter(r=>r.lifetime!=='automatic' && r.lifetime!=='thread_local' && !['AUTO','REGISTER'].includes(r.storage)).map(r=>({...r,accesses:[...(r.accesses || [])]}));
  const sourceResources=scanSourceResources(model.files,model.functions);
  for(const r of sourceResources) {
    const existing=rawResources.find(x=>x.name===r.name&&resolveFile(x.file,x.repo_id)===r.file);
    if(existing) {existing.end_line=r.end_line;existing.definition=r.definition;existing.record=r.record;existing.accesses.push(...r.accesses);}
    else rawResources.push(r);
  }
  if(sourceResources.length)model.gaps.push('source_text 补充为源码词法证据，条件编译、宏展开与别名访问需要语义索引复核。');
  for(const [i,r] of rawResources.entries()) {
    const key=`r_${i}`, accesses=r.accesses || [], names=(kind)=>[...new Set(accesses.filter(a=>{
      const aliases={read:['read','rmw'],write:['write','rmw','acquire','release'],init:['init','alloc'],free:['free','deinit']};return (aliases[kind]||[kind]).includes(a.access);
    }).map(a=>byId.get(a.function_id)).filter(Boolean))];
    const intro=r.description || `${r.storage || r.lifetime || '共享'} ${r.type || '资源'}；${names('write').length} 个写入函数、${names('read').length} 个读取函数`;
    model.resources[key]=[r.type || '共享资源',names('init').length?names('init'):r.initializer?'C 静态初始化':[],names('write'),names('free'),r.repo_id || entries.snapshot?.repo_id || 'repo',names('read'),intro];
    const file=resolveFile(r.file,r.repo_id);
    model.variables[key]={name:r.name,file,first:r.line || 1,last:r.end_line || r.line || 1,record:{...r.record,fields:(r.fields || r.record?.fields?.map(field_name=>({field_name})) || []).map(f=>f.field_name)}};
    model.resourcePresentation[key]={name:r.name,colors:colors[i%colors.length],intro,fields:{}};
    const spec={field:(r.fields || []).map(f=>`${r.name}.${f.field_name}`).join(' / ') || r.name,writers:[],readers:[]};
    model.resourceEffects[key]=[];
    for(const a of accesses) {
      const fn=byId.get(a.function_id) || (model.functions[a.function_id]?a.function_id:null); if(!fn) continue;
      model.resourceEffects[key].push({function:fn,resource:key,access:a.access||'unknown',expression:a.expression||a.field_name||r.name,certainty:a.certainty||'unknown',source:{file:resolveFile(a.location?.file||r.file,r.repo_id),line:a.location?.line||null}});
      const label=`${a.expression || a.field_name || r.name} · ${a.certainty || 'unknown'} · ${a.location?.file || r.file}:${a.location?.line || '?'}`;
      const labels={read:'读取',write:'写入',rmw:'读改写',init:'初始化',deinit:'去初始化',alloc:'分配',free:'释放',acquire:'加锁',release:'解锁'};
      const verb=labels[a.access] || `未知访问 ${a.access || ''}`;
      const kinds=a.access==='rmw'?['writers','readers']:[a.access==='read'?'readers':'writers'];
      for(const kind of kinds)spec[kind].push([fn,verb,label,[],a.access]);
      if(!model.functions[fn].globals.includes(key)) model.functions[fn].globals.push(key);
    }
    for(const field of r.fields || r.record?.fields?.map(field_name=>({field_name})) || []) {
      const uses=accesses.filter(a=>a.field_name===field.field_name);
      model.resourcePresentation[key].fields[field.field_name]=[field.description || `字段作用待核实；已发现 ${uses.length} 处访问。`,uses.map(a=>`${a.function_name || a.function_id} ${a.access} · ${a.certainty} · L${a.location?.line || '?'}`).join('；') || '没有字段级证据'];
    }
    model.resourceLinks[key]=spec;
    model.resourceOrder.push(key);
  }
  // Project callee effects to public entrypoints; keep the exact via path on
  // each relation. One entry box even if it both reads and writes a resource.
  const entryKeys=(entries.entries || []).filter(e=>e.is_entry).map(e=>byId.get(e.entry_id)).filter(Boolean);
  const findPath=(root,target,path=[root])=>{
    if(root===target)return path;
    if(path.length>=24)return null;
    for(const c of model.functions[root]?.calls || [])if(!path.includes(c)){const found=findPath(c,target,[...path,c]);if(found)return found;}
    return null;
  };
  for(const spec of Object.values(model.resourceLinks))for(const kind of ['writers','readers']) {
    const projected=[];
    for(const [fn,verb,note,,access]of spec[kind]) {
      const owners=entryKeys.map(entry=>[entry,findPath(entry,fn)]).filter(([,path])=>path);
      for(const [entry,path]of owners.length?owners:[[fn,[fn]]]) {
        const existing=projected.find(([k,v])=>k===entry&&v===verb);
        if(existing){if(!existing[2].includes(note))existing[2]+='；'+note;existing[3]=[...new Set([...existing[3],...path.slice(1)])];}
        else projected.push([entry,verb,note,path.slice(1),access]);
      }
    }
    spec[kind]=projected;
  }
  // One box per function: predominantly writing functions left, readers right.
  const left={},right={}; let li=0,ri=0;
  for(const key of Object.keys(model.functions)) {
    const writer=Object.values(model.resourceLinks).some(s=>s.writers.some(([k])=>k===key));
    const reader=Object.values(model.resourceLinks).some(s=>s.readers.some(([k])=>k===key));
    if(!writer && !reader) continue;
    if(writer) left[key]=40+li++*116; else right[key]=40+ri++*116;
  }
  model.columns=[[32,left],[952,right]];
  for(const row of entries.entries || []) {
    const key=byId.get(row.entry_id); if(!key) continue;
    const f=model.functions[key];
    if(row.is_entry || !(entries.entries || []).some(e=>e.is_entry)) {
      model.interfaceLabels[key]=f.name;
      model.interfaceFields[key]=(f.parameters || []).map(p=>[p.name || 'arg',0,-2147483648,2147483647]);
    }
  }
  // Every function remains a selectable root. The current backend's graph may
  // be partial; use its labels/certainties and never imply native CFG coverage.
  for(const [key,f] of Object.entries(model.functions)) {
    if(entryKeys.length&&!entryKeys.includes(key))continue;
    const graph=flows.find(g=>g.entry?.entry_id===f.id);
    const flow={title:f.name,rootNote:model.roles[key],layout:{},edges:[],nodes:{}};
    if(graph?.nodes?.length) {
      const ids=new Map(); const levels=new Map();
      for(const [i,n] of graph.nodes.entries()) {
        const id=`n_${key}_${i}`; ids.set(n.node_id,id);
        const fn=byId.get(n.function_id) || (n.kind==='external'?byId.get(`boundary:${graph.entry?.entry_id}:${n.node_id}`):key);
        const shape=n.shape==='diamond'?'decision':n.shape==='ellipse'?'terminal':n.shape==='parallelogram'?'io':'process';
        const fullLabel=String(n.label || model.functions[fn]?.name || '');
        const label=shape==='decision'&&fullLabel.length>42?fullLabel.replace(/\s+/g,' ').slice(0,39)+'…':fullLabel;
        flow.nodes[id]={function:fn,label,fullLabel,sublabel:`${n.sublabel || ''} · ${n.certainty || 'unknown'}`,shape,kind:n.kind,role:n.role};
        levels.set(n.node_id,n.kind==='entry'?0:1);
      }
      // Bounded relaxation gives vertical layers; back-edges remain back-edges.
      for(let pass=0;pass<graph.nodes.length;pass++) {
        let changed=false;
        for(const e of graph.edges || []) {
          if(!ids.has(e.from)||!ids.has(e.to)||e.from===e.to) continue;
          const a=levels.get(e.from),b=levels.get(e.to);
          if(b<=a && a<graph.nodes.length-1) {levels.set(e.to,a+1);changed=true;}
        }
        if(!changed) break;
      }
      const rows=new Map();
      for(const n of graph.nodes) {const level=levels.get(n.node_id),col=rows.get(level)||0;rows.set(level,col+1);flow.layout[ids.get(n.node_id)]=[40+col*340,40+level*170];}
      for(const e of graph.edges || []) if(ids.has(e.from)&&ids.has(e.to)) {
        const action=e.kind==='call'?'调用':e.kind==='guard'?'条件':e.kind==='return'?'返回':e.kind==='external'?'外部调用':String(e.label || e.kind).replace(/\s+/g,' ').slice(0,24);
        const edge=[ids.get(e.from),ids.get(e.to),'b','t',`${action} · ${e.certainty || 'unknown'}`];
        if(e.style?.color==='exception')edge.push('error');
        flow.edges.push(edge);
      }
      const groupKeys=new Map();
      for(const g of graph.groups || []) {
        const group=`g_${key}_${Object.keys(model.groups).length}`;
        const members=(g.member_node_ids || []).map(id=>ids.get(id)).filter(Boolean);
        if(!members.length)continue;
        model.groups[group]=members; model.phases[group]=g.label;
        groupKeys.set(g.group_id,group);
        flow.layout[group]=flow.layout[members[0]];
        model.groupSummaries ||= {};
        model.groupSummaries[group]={title:g.label,description:g.description || '结构分组，语义待复核',members};
        if(!g.collapsed_default)model.expandedGroups.push(group);
      }
      for(const g of graph.groups || []) {
        const parent=groupKeys.get(g.parent_group_id),child=groupKeys.get(g.group_id);
        if(!parent||!child)continue;
        model.groups[parent]=model.groups[parent].filter(id=>!model.groups[child].includes(id));
        model.groups[parent].push(child);
      }
      const flatMembers=(id,seen=new Set())=>{if(seen.has(id))return [];seen.add(id);return model.groups[id]?model.groups[id].flatMap(x=>flatMembers(x,seen)):[id];};
      for(const group of groupKeys.values())model.groupSummaries[group].members=flatMembers(group);
      model.gaps.push(...(graph.gaps || []).map(g=>g.reason || g.code));
    } else {
      flow.layout[key]=[40,40];
      for(const [i,callee] of f.calls.entries()) {flow.layout[callee]=[40+i*250,205];flow.edges.push([key,callee,'b','t',model.functions[callee].certainty]);}
    }
    model.flows[key]=flow;
  }
  const roots=Object.keys(model.interfaceLabels);
  model.initialRoot=[...roots].sort((a,b)=>model.functions[b].calls.length-model.functions[a].calls.length)[0] || Object.keys(model.flows)[0];
  for(const root of roots) {
    const visit=(key,path)=>{if(model.entryPaths[key])return;model.entryPaths[key]=path;for(const c of model.functions[key].calls)if(!path.includes(c))visit(c,[...path,c]);};
    visit(root,[root]);
  }
  for(const row of interfaces.candidates || interfaces.interfaces || []) if(row.function_id && byId.has(row.function_id)) {
    const key=byId.get(row.function_id);
    // Automatic classification is a candidate, not a proof of independence.
    if(row.decoupling==='independent')model.basic.push(key);
    if(model.contracts[key]) {
      model.contracts[key][4]=(row.input_guards || []).map(g=>`${g.expression} · ${g.file}:${g.line}`).join('；') || model.contracts[key][4];
      model.contracts[key][3]+=`；基础接口候选 ${row.certainty || 'unknown'}，${row.decoupling || '独立性待复核'}`;
    }
  }
  model.gaps.push(...(coupling.gaps || []).map(g=>g.reason || g.code));
  model.gaps.push('静态调用和字段证据不证明运行时顺序；原生 CFG、锁保护和别名覆盖以快照能力为准。');
  model.gaps=[...new Set(model.gaps)];
  if(entries.truncated)model.gaps.push('函数列表被截断');
  model.caption=`静态快照 · ${entries.snapshot?.workspace_id || ''} · ${entries.snapshot?.snapshot_id || ''}`;
  return model;
}

// Deliberately bounded source fallback, rather than a second C parser. Only
// simple file-scope static declarations are admitted, with source_text labels.
function scanSourceResources(files,functions) {
  const found=[];
  const clean=s=>s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,m=>m.replace(/[^\n]/g,' '));
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const [file,lines]of Object.entries(files)) {
    const code=clean(lines.join('\n')),depth=[];let level=0;
    for(let i=0;i<code.length;i++){depth[i]=level;if(code[i]==='{')level++;else if(code[i]==='}')level--;}
    for(const match of code.matchAll(/^[ \t]*static[ \t]+([^;]+);/gm)) {
      if(depth[match.index]!==0)continue;
      const declaration=match[1].split('=')[0].trim();
      if(/[(),{}]/.test(declaration))continue;
      const symbol=/^(.*?)\b([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)$/.exec(declaration);
      if(!symbol || !symbol[1].trim())continue;
      const name=symbol[2],type=(symbol[1]+symbol[3]).trim();
      const line=code.slice(0,match.index).split('\n').length;
      const end=line+match[0].split('\n').length-1;
      const resource={name,file,line,end_line:end,type,storage:'STATIC',lifetime:'static',accesses:[],fields:[],initializer:match[1].includes('=')};
      const struct=/\bstruct\s+(\w+)/.exec(type);
      if(struct) {
        const def=new RegExp('\\bstruct\\s+'+escape(struct[1])+'\\s*\\{([\\s\\S]*?)\\}\\s*;').exec(code);
        if(def) {
          const first=code.slice(0,def.index).split('\n').length;
          resource.record={first,last:first+def[0].split('\n').length-1,fields:[]};
          for(const field of def[1].matchAll(/\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g))resource.record.fields.push(field[1]);
          resource.fields=resource.record.fields.map(field_name=>({field_name}));
        }
      }
      for(const [key,f]of Object.entries(functions))if(f.file===file) {
        for(let n=f.first;n<=f.last;n++) {
          const text=clean(lines[n-1] || '');
          const ref=new RegExp('\\b'+escape(name)+'\\b(?:\\s*\\[[^\\]]*\\])?(?:\\s*\\.\\s*(\\w+))?','g');
          for(const access of text.matchAll(ref)) {
            const after=text.slice(access.index+access[0].length),before=text.slice(0,access.index);
            const writes=/^\s*(?:=(?!=)|[+\-*/|&^]=|\+\+|--)/.test(after)||/(?:\+\+|--)\s*$/.test(before);
            const reads=!writes||/^\s*(?:[+\-*/|&^]=|\+\+|--)/.test(after);
            for(const accessKind of [...(writes?['write']:[]),...(reads?['read']:[])])resource.accesses.push({access:accessKind,certainty:'source_text',function_id:f.id || key,function_name:f.name,field_name:access[1]||null,expression:access[0],location:{file,line:n}});
          }
        }
      }
      found.push(resource);
    }
  }
  return found;
}

async function loadModel(rpc,scope,onProgress=()=>{}) {
  const entries=await rpc('view.listEntries',scope);
  const rows=(entries.entries || []).slice(0,100);
  if(!rows.length)throw Error('这个快照没有可展示的函数');
  const [coupling,fileTree,interfaces]=await Promise.all([rpc('view.coupling',scope),rpc('view.fileTree',scope),rpc('view.interfaces',scope)]);
  const details=[],files=[],flows=[];
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{
    while(cursor<rows.length) {const row=rows[cursor++];details.push(await rpc('view.getEntry',{...scope,entry:row.entry_id}));onProgress(`读取函数 ${details.length}/${rows.length}`);}
  }));
  for(const repo of fileTree.repos || []) for(const f of (repo.files || []).slice(0,100)) {
    files.push(await rpc('view.fileRead',{...scope,repo:repo.repo_id,path:f.path,max_lines:2000}));
  }
  const roots=rows.filter(r=>r.is_entry).slice(0,24);
  await Promise.all((roots.length?roots:rows.slice(0,1)).map(async row=>flows.push(await rpc('view.endToEnd',{...scope,entry:row.entry_id}))));
  const model=createModel({entries,details,coupling,flows,files,interfaces});
  if(rows.length<(entries.entries || []).length)model.gaps.push('当前加载上限为 100 个函数；其余函数尚未载入');
  model.scope=scope;
  return model;
}
module.exports={createModel,loadModel,scanSourceResources};
