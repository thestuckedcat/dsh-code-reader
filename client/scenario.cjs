'use strict';
function compatibleScenario(data,scope,profile) {
  return data?.snapshot_id===scope.snapshot && (!profile || data.profile_id===profile.profile_id);
}

// This function is serialized into the sandbox document. It uses only the
// narrow parent RPC bridge; executable bytes, plans and ledger writes stay Host-owned.
function installScenario() {
  if(!window.__CODE_VIEW_MODEL__)return;
  const api=window.__codeHostRpc,scope=model.scope;
  if(!api||!scope)return;
  let profile=null,latest=null,generation=0,busy=false,steps=[];
  const byName=name=>Object.keys(functions).find(k=>functions[k].name===name);
  const unpack=data=>data.scenario?{...data.scenario,records:data.records,imported:data.scenario.imported||data.imported}:data;
  const validateLedger=data=>{const value=unpack(data);if(!compatibleScenario(value,scope,profile))throw Error('该台账属于其他快照或运行配置');return value;};
  const status=el('p','sub','正在读取运行配置…');status.setAttribute('role','status');
  byId('simulation').prepend(status);
  const clone=id=>{const old=byId(id),node=old.cloneNode(true);old.replaceWith(node);return node;};
  const form=clone('scenario'),undo=clone('undo');
  byId('interface').addEventListener('change',renderFields);
  const profileLabel=el('label','','隔离运行配置'),profiles=el('select','');profileLabel.append(profiles);form.prepend(profileLabel);
  const ledger=el('details','side-item');ledger.append(el('summary','','Host 执行记录 / 观测导入'));
  const ledgerRows=el('div','side-list');ledger.append(ledgerRows);
  const input=el('input','');input.placeholder='可信 inbox 中的轨迹文件名';input.setAttribute('aria-label','观测轨迹文件名');
  const importButton=el('button','','导入观测');importButton.type='button';ledger.append(input,importButton);byId('simulation').append(ledger);
  function setBusy(value){busy=value;form.inert=value;ledgerRows.inert=value;undo.disabled=value||!latest||latest.imported;byId('run').disabled=value||!profile||latest?.imported;importButton.disabled=value;}
  function showRecords(records) {
    run={entries:[],byEntry:new Map()};history.splice(0);
    const rows=[];
    for(const record of records || []) {
      const key=byName(record.interface),row=el('details','side-item');
      row.append(el('summary','',`${record.step_index+1}. ${record.interface}(${record.args.join(', ')}) → ${record.result ?? record.status}`));
      for(const event of record.execution_events || [])row.append(el('p','sub',`${event.event || event.code} · L${event.line}: ${event.a}, ${event.b}, ${event.c}`));
      for(const resource of record.affected_resources || [])row.append(el('p','sub',`${resource.access} ${resource.name || resource.resource_id}`));
      if(key){run.byEntry.set(key,{status:record.result,entries:[]});history.push({name:key,args:record.args});}
      rows.push(row);
    }
    byId('history').replaceChildren(...rows.reverse());
    render();
    window.dispatchEvent(new Event('code-workbench-state'));
  }
  async function loadLedger() {
    const data=await api('scenario.list',{workspace:scope.workspace});
    const compatible=(data.scenarios || []).filter(s=>compatibleScenario(s,scope,profile));
    generation=Math.max(0,...compatible.filter(s=>!s.imported).map(s=>s.generation||0));
    ledgerRows.replaceChildren(...compatible.map(s=>{
      const b=el('button','inline-action',`${s.label || s.scenario_id} · generation ${s.generation}${s.imported?' · 导入观测':''}`);b.type='button';
      b.onclick=async()=>{if(busy)return;setBusy(true);try{const result=validateLedger(await api('scenario.get',{workspace:scope.workspace,scenario:s.scenario_id}));latest={...s,...result};window.__hostScenario=latest.scenario_id;steps=(result.records || []).filter(r=>r.status!=='skipped').map(r=>({interface:r.interface,args:r.args}));showRecords(result.records);await drawObserved();}catch(e){status.textContent=e.message;}finally{setBusy(false);}};
      return b;
    }));
    return data;
  }
  async function execute(requestSteps) {
    if(!profile)throw Error('当前快照没有匹配的隔离运行配置');
    if(requestSteps.length>20)throw Error('一个场景最多 20 个接口；可回退末尾记录后继续');
    const payload={...scope,profile:profile.profile_id,scenario:{generation:0,stop_on_error:false,steps:requestSteps}};
    // Preview is the concrete, reviewable signed plan; only Host then executes.
    let plan;
    try{plan=await api('scenario.preview',payload);}catch(error){if(error.code!=='STATE_CONFLICT'||!Number.isInteger(error.currentGeneration))throw error;payload.scenario.generation=error.currentGeneration;plan=await api('scenario.preview',payload);}
    payload.scenario.generation=plan.generation;
    const result=await api('scenario.run',{...payload,expected_generation:plan.generation});
    latest={...unpack(result),imported:false};generation=latest.generation;
    window.__hostScenario=latest.scenario_id;steps=requestSteps;showRecords(result.records);
    status.textContent=`隔离模拟完成 · generation ${generation} · ${result.records.length} 条记录；非真实设备运行`;
    await loadLedger();return result;
  }
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(busy)return;setBusy(true);
    try {
      const key=byId('interface').value;
      const args=interfaceFields[key].map(([field])=>byId(`arg-${field}`).valueAsNumber);
      if(args.some(v=>!Number.isSafeInteger(v)))throw Error('入参必须是有效整数');
      await execute([...steps,{interface:functions[key].name,args}]);
    } catch(err){status.textContent=`执行失败：${err.message}`;}
    finally{setBusy(false);}
  });
  undo.onclick=async()=>{
    if(busy||!latest)return;const count=byId('undo-count').valueAsNumber;if(!Number.isInteger(count)||count<1||count>steps.length){status.textContent='请输入有效的末尾回退条数';return;}
    setBusy(true);try{
      const result=await api('scenario.undoTail',{workspace:scope.workspace,scenario:latest.scenario_id,count,expected_generation:latest.generation});
      latest=result;generation=result.generation;steps=(result.records || []).map(r=>({interface:r.interface,args:r.args}));window.__hostScenario=result.scenario_id;showRecords(result.records);await loadLedger();status.textContent=`已回退末尾 ${count} 条；Host 已校验前缀重放状态`;
    }catch(err){status.textContent=`回退失败：${err.message}`;}finally{setBusy(false);}
  };
  importButton.onclick=async()=>{
    setBusy(true);try{const result=validateLedger(await api('trace.import',{...scope,input:input.value.trim()}));latest={...result,imported:true};steps=[];window.__hostScenario=result.scenario_id;showRecords(result.records);await loadLedger();await drawObserved();status.textContent='已导入观测；导入数据未经本机执行，不能回退重放。新建执行场景后可继续模拟。';}catch(err){status.textContent=`导入失败：${err.message}`;}finally{setBusy(false);}
  };
  function selectProfile() {
    profile=window.__hostProfiles.find(p=>p.profile_id===profiles.value);steps=[];latest=null;window.__hostScenario=null;
    byId('interface').replaceChildren();
    for(const iface of profile?.interfaces || []) {
      const key=byName(iface.name);if(!key)continue;
      interfaceFields[key]=(iface.params || []).map(p=>[p.name,p.min>0?p.min:0,p.min??-2147483648,p.max??4294967295]);
      const option=el('option','',`${iface.role==='stub_control'?'边界打桩 · ':''}${iface.name}()`);option.value=key;byId('interface').append(option);
    }
    if(byId('interface').options.length)renderFields();byId('run').disabled=!profile;byId('run').textContent='执行接口';
    status.textContent=profile?'使用 Host 隔离 Wasm；结果写入不可变台账':'当前快照没有匹配的运行配置';
  }
  async function drawObserved() {
    if(!latest)return;
    const data=await api('view.sequence',{workspace:scope.workspace,mode:'observed',scenario:latest.scenario_id});
    const ns='http://www.w3.org/2000/svg',svg=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
    const participants=data.participants || [],columns=new Map(participants.map((p,i)=>[p.participant_id,100+i*250]));
    const width=Math.max(850,participants.length*250),height=90+(data.messages || []).length*40;
    const chart=svg('svg',{class:'sequence-svg',width,height,viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':'Host 台账观测时序图'});
    for(const p of participants){const x=columns.get(p.participant_id);chart.append(svg('line',{class:'sequence-lane',x1:x,x2:x,y1:40,y2:height}),svg('text',{x,y:24,'text-anchor':'middle'},p.label));}
    for(const [i,m]of (data.messages || []).entries()) {
      const a=columns.get(m.from),b=columns.get(m.to),y=75+i*40;if(a===undefined||b===undefined)continue;
      const line=a===b?`M${a} ${y}h45v14h-45`:`M${a} ${y}H${b}`;
      if(m.async===true)chart.append(svg('rect',{x:8,y:y-25,width:width-16,height:38,rx:4,fill:'#392852',stroke:'#bb9cf4'}));
      chart.append(svg('path',{class:`sequence-arrow ${m.kind==='return'?'return':m.kind==='error'?'error':''}`,d:line,...(m.async===true?{style:'stroke:#bb9cf4;stroke-dasharray:5 4'}:{})}),svg('text',{x:Math.min(a,b)+8,y:y-5},`${m.async===true?'异步边界 · ':''}${m.label}`));
    }
    byId('sequence-chart').replaceChildren(chart);byId('sequence-status').textContent=data.warning || `Host 台账观测 · ${latest.scenario_id} · 不证明真实设备行为`;
  }
  const sequenceForm=byId('sequence-form');
  document.querySelector('[data-view="sequence"]').addEventListener('click',()=>{if(latest)drawObserved().catch(e=>byId('sequence-status').textContent=e.message);});
  sequenceForm.addEventListener('submit',async e=>{
    if(!profile)return;e.preventDefault();e.stopImmediatePropagation();if(busy)return;setBusy(true);
    try{const order=[...byId('sequence-steps').children].map(row=>{const key=row.querySelector('select').value;return {interface:functions[key].name,args:[...row.querySelectorAll('.sequence-args input')].map(i=>i.valueAsNumber)};});await execute(order);await drawObserved();}catch(err){byId('sequence-status').textContent=err.message;}finally{setBusy(false);}
  },true);
  profiles.onchange=()=>{selectProfile();loadLedger().catch(e=>status.textContent=e.message);};
  const fresh=el('button','inline-action','新建执行场景');fresh.type='button';fresh.onclick=()=>{selectProfile();showRecords([]);setBusy(false);};profileLabel.append(fresh);
  const summaries=new Map();
  byId('summary-tab').addEventListener('click',async()=>{
    const key=selected;if(!functions[key]?.id)return;
    try{if(!summaries.has(key))summaries.set(key,await api('view.summary',{...scope,subject_type:'function',subject_id:functions[key].id}));
      const record=summaries.get(key).summaries?.[0];
      if(record)summariesByFunction[key]=record.stale?'归纳已失效，请基于当前快照重新生成。':String(record.text || '').slice(0,500);
      if(selected===key&&detailTab==='summary')renderCode();
    }catch(error){if(selected===key&&detailTab==='summary')byId('detail-data').append(el('p','sub',`归纳读取失败：${error.message}`));}
  });
  Promise.all([api('scenario.listProfiles',{workspace:scope.workspace}),loadLedger()]).then(async([data])=>{
    window.__hostProfiles=(data.profiles || []).filter(p=>p.binding?.snapshot_id===scope.snapshot);
    const id=window.__hostScenario;
    for(const p of window.__hostProfiles){const o=el('option','',p.label || p.profile_id);o.value=p.profile_id;profiles.append(o);}selectProfile();await loadLedger();
    if(id){const result=validateLedger(await api('scenario.get',{workspace:scope.workspace,scenario:id}));latest=result;window.__hostScenario=id;steps=(result.records || []).map(r=>({interface:r.interface,args:r.args}));showRecords(result.records);}
    setBusy(false);
  }).catch(err=>{status.textContent=`运行配置不可用：${err.message}`;setBusy(false);});
}
module.exports={installScenario,compatibleScenario};
