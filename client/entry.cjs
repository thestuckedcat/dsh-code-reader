'use strict';

// Native right-pane owner. Rendering stays in the canonical Demo document;
// this shell owns only admission-backed reads, lifecycle and pane-local state.
function createPlugin(React,documents,models,reference) {
  const h=React.createElement;
  const KIND='code-workbench',ID='code-workbench';
  const stores=new Map();
  function service(ctx,name){try{return ctx.get?.(name) || ctx[name];}catch{return ctx[name];}}
  function Workbench({ctx,sessionId='unbound'}) {
    if(!stores.has(sessionId))stores.set(sessionId,{mode:'demo',model:null,selection:null});
    const store=stores.get(sessionId);
    const [state,setState]=React.useState(()=>({...store,options:[],status:'',error:''}));
    const frame=React.useRef(null),generation=React.useRef(0),abort=React.useRef(null);
    const token=React.useRef(null);
    if(!token.current)token.current=globalThis.crypto?.randomUUID?.() || `pane-${Date.now()}-${Math.random()}`;
    const [documentState,setDocument]=React.useState(()=>documents.withSession(documents.createDocument(reference,store.model),store.selection,token.current));
    async function rpc(method,payload,signal) {
      const result=await service(ctx,'connection').rpc.call('/code-view',method,payload,signal);
      if(!result?.ok){const e=Error(result?.error?.message || '请求失败');e.code=result?.error?.code;throw e;}
      if(result.value?.ok===false || result.value?.error){const error=result.value.error||{};const e=Error(error.message || error.code || '快照读取失败');e.code=error.code;e.currentGeneration=error.details?.current_generation;throw e;}
      return result.value;
    }
    async function refresh() {
      try {
        const result=await rpc('view.listSnapshots',{},abort.current?.signal);
        const options=[];
        for(const w of result.workspaces || [])for(const s of w.snapshots || []) {
          if(s.snapshot_id)options.push({value:`${w.workspace_id}/${s.snapshot_id}`,label:`${w.workspace_id} · ${s.snapshot_id.slice(0,12)}`,scope:{workspace:w.workspace_id,snapshot:s.snapshot_id}});
        }
        setState(s=>({...s,options,error:''}));
      } catch(e) {if(e.name!=='AbortError')setState(s=>({...s,error:`真实快照未载入：${e.message}`}));}
    }
    React.useEffect(()=>{
      abort.current=new AbortController();refresh();
      const receive=async e=>{
        if(e.source!==frame.current?.contentWindow || e.data?.channel!==token.current)return;
        if(e.data.type==='rpc') {
          const {id,method,payload}=e.data;
          const allowed=['scenario.listProfiles','scenario.list','scenario.get','scenario.preview','scenario.run','scenario.undoTail','trace.import','view.sequence','view.summary'];
          const respond=value=>{try{e.source.postMessage({type:'rpc-result',channel:token.current,id,...value},'*');}catch{}};
          if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id||'')||!allowed.includes(method)||!store.model?.scope||payload?.workspace!==store.model.scope.workspace||payload.snapshot&&payload.snapshot!==store.model.scope.snapshot||JSON.stringify(payload).length>12288){respond({error:'当前来源不允许这个请求'});return;}
          try{respond({value:await rpc(method,payload,abort.current.signal)});}catch(error){respond({error:error.message,code:error.code,currentGeneration:Number.isInteger(error.currentGeneration)?error.currentGeneration:undefined});}
          return;
        }
        if(e.data.type!=='selection')return;
        const value=e.data.value;
        if(!value || !Array.isArray(value.path) || value.path.length>50 || !value.path.every(x=>typeof x==='string'&&x.length<512) || JSON.stringify(value).length>512*1024)return;
        store.selection=value;
      };
      window.addEventListener('message',receive);
      return()=>{generation.current++;abort.current?.abort();window.removeEventListener('message',receive);};
    },[]);
    async function select(value) {
      const ticket=++generation.current;
      abort.current?.abort();abort.current=new AbortController();
      if(value==='demo') {
        Object.assign(store,{mode:'demo',model:null,selection:null});
        setState(s=>({...s,...store,status:'',error:''}));
        setDocument(documents.withSession(reference,null,token.current));return;
      }
      const option=state.options.find(o=>o.value===value);if(!option)return;
      const signal=abort.current.signal;
      setState(s=>({...s,status:'正在读取快照…',error:''}));
      try {
        const model=await models.loadModel((method,payload)=>rpc(method,payload,signal),option.scope,text=>{if(ticket===generation.current)setState(s=>({...s,status:text}));});
        if(ticket!==generation.current)return;
        const doc=documents.createDocument(reference,model);
        Object.assign(store,{mode:value,model,selection:null});
        setDocument(documents.withSession(doc,null,token.current));
        setState(s=>({...s,...store,status:'',error:''}));
      } catch(e) {if(ticket===generation.current&&e.name!=='AbortError')setState(s=>({...s,status:'',error:`快照加载失败：${e.message}`}));}
    }
    return h('section',{'data-code-workbench':'right-pane',style:{height:'100%',minHeight:0,display:'flex',flexDirection:'column',background:'#10141b',color:'#edf1f7',fontFamily:'Inter,"Microsoft YaHei",system-ui,sans-serif'}},
      h('div',{style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',padding:'7px 12px',borderBottom:'1px solid #303b49',fontSize:12}},
        h('label',null,'来源 ',h('select',{'aria-label':'工作台数据来源',value:state.mode,onChange:e=>select(e.target.value),style:{maxWidth:260,background:'#171d26',color:'inherit',border:'1px solid #536579',borderRadius:5,padding:4}},
          h('option',{value:'demo'},'当前 Demo · 内置 C / Wasm 样例'),...state.options.map(o=>h('option',{key:o.value,value:o.value},o.label)))),
        h('button',{type:'button',onClick:refresh,style:{background:'#202a37',color:'inherit',border:'1px solid #536579',borderRadius:5}},'刷新快照'),
        h('span',{role:'status'},state.status),state.error?h('span',{role:'alert',style:{color:'#ffc28c'}},state.error):null),
      h('iframe',{ref:frame,title:'C 代码工作台',sandbox:'allow-scripts allow-forms',srcDoc:documentState,'data-workbench-frame':true,style:{border:0,width:'100%',flex:1,minHeight:360,display:'block',background:'#10141b'}}));
  }
  function apply(ctx) {
    const tabs=service(ctx,'sidebarRightTabs');
    if(!tabs?.register)throw Error('代码工作台需要宿主原生右栏 sidebarRightTabs 服务');
    ctx.effect(()=>tabs.register({id:ID,kind:KIND,multiple:false,priority:'extension',patterns:[`sidebar://${KIND}`],title:()=> '代码工作台',guide:[{id:'open-code-workbench',order:30,title:()=> '代码工作台',description:()=> '六视图阅读 C 代码、共享资源变更与接口模拟'}]}),'code-workbench: native tab');
    ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:ID,inject:(sessionId,actions)=>({ctx,sessionId,actions})},Workbench)),'code-workbench: native body');
    ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:ID},()=>h('span',null,'代码工作台'))),'code-workbench: native title');
  }
  return {name:'dsh-code-reader',inject:['slots','connection','sidebarRightTabs','sidebarRight'],apply};
}
module.exports={createPlugin};
