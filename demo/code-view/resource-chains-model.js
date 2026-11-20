(function(root){
  'use strict';
  function makeResourceSlice(data,selection,{maxNodes=320,onlyChanges=false}={}) {
    const selected=new Set(selection),functions=data.functions||{};
    const changes=new Set(['write','rmw','init','deinit','alloc','free','acquire','release']);
    const allowed=e=>selected.has(e.resource)&&(!onlyChanges||changes.has(e.access));
    const reverse=new Map();
    for(const [name,fn]of Object.entries(functions))for(const target of fn.calls||[]){if(!reverse.has(target))reverse.set(target,[]);reverse.get(target).push(name);}
    const relevant=new Set(Object.entries(functions).filter(([,fn])=>(fn.effects||[]).some(allowed)).map(([name])=>name));
    const queue=[...relevant];for(let i=0;i<queue.length;i++)for(const parent of reverse.get(queue[i])||[])if(!relevant.has(parent)){relevant.add(parent);queue.push(parent);}
    const entries=(data.entries||[]).filter(e=>relevant.has(e)),nodes=[],edges=[];
    for(const entry of entries) {
      const visited=new Set(),work=[{name:entry,depth:0}];
      for(let i=0;i<work.length;i++) {
        const {name,depth}=work[i];if(visited.has(name)||!functions[name])continue;visited.add(name);
        const fn=functions[name],span=(data.lockSpans||[]).find(s=>s.entry===entry&&s.functions.includes(name));
        nodes.push({id:entry+'::'+name,entry,function:name,depth,label:fn.label||name,source:fn.source,domain:fn.domain||'kernel',effects:fn.effects||[],focusEffects:(fn.effects||[]).filter(allowed),lockStatus:span?.status||'unknown',lock:span?.lock||null,span});
        for(const target of fn.calls||[])if(functions[target]){edges.push({from:entry+'::'+name,to:entry+'::'+target,entry});if(!visited.has(target))work.push({name:target,depth:depth+1});}
      }
    }
    const totalNodes=nodes.length,visible=nodes.slice(0,maxNodes),ids=new Set(visible.map(n=>n.id));
    return {entries,nodes:visible,edges:edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),resources:Object.entries(data.resources||{}).map(([key,r])=>({key,...r,selected:selected.has(key)})),totalNodes,truncated:totalNodes>maxNodes,selected:[...selected],lockSpans:data.lockSpans||[]};
  }

  const source=`/* Presentation fixture. Not compiled or executed by this Demo.
 * lock()/unlock() follow the example's declared mutual-exclusion contract.
 * The public entry's caller context is otherwise unknown. */
typedef struct { unsigned opaque; } Lock;
enum { IDLE, READY };
struct State { unsigned phase; unsigned pending; };
static struct State g_state;
static Lock state_lock;
static unsigned error_count;
extern void lock(Lock *);
extern void unlock(Lock *);
extern int validate_request(void);

static void update_state(unsigned phase)
{
    g_state.phase = phase;
    g_state.pending += 1;
}

void submit_job(void)
{
    if (!validate_request()) return;
    lock(&state_lock);
    update_state(READY);
    unlock(&state_lock);
}

void maintenance_update(void)
{
    update_state(IDLE); /* no local lock; caller's lock context unknown */
}

static unsigned inspect_state(void)
{
    return g_state.phase + g_state.pending;
}

unsigned read_status(void)
{
    lock(&state_lock);
    unsigned result = inspect_state();
    unlock(&state_lock);
    return result;
}

void reject_job(void)
{
    error_count += 1;
}
`;
  function lockExample() {
    const lines=source.split('\n'),location=(needle)=>({file:'resource-lock-demo.c',line:lines.findIndex(l=>l.includes(needle))+1,text:source});
    const effect=(resource,access,expression,needle)=>({resource,access,expression,certainty:'示例标注',source:location(needle)});
    return {
      id:'lock-example',label:'锁上下文示意 C',note:'演示数据 · 人工标注 · 未编译、未执行；不代表插件已完成锁分析',source,
      resources:{
        g_state:{name:'g_state',kind:'共享结构体',intro:'两个字段共同维护任务状态',fields:[['phase','状态字段；update_state() 用入参覆盖'],['pending','累计更新次数；更新时加一，查询时读取']],colors:['#174d43','#8ce7c3'],definition:'struct State { unsigned phase; unsigned pending; };\nstatic struct State g_state;'},
        state_lock:{name:'state_lock',kind:'示例锁',intro:'只对示例中明确包围的调用标注范围',fields:[],colors:['#3c2858','#c5a2ff'],definition:'typedef struct { unsigned opaque; } Lock;\nstatic Lock state_lock;\n/* lock/unlock 按此示例的互斥合同解释 */'},
        error_count:{name:'error_count',kind:'静态计数器',intro:'拒绝入口独立维护的错误计数',fields:[],colors:['#503921','#f2c180'],definition:'static unsigned error_count;'}
      },
      functions:{
        submit_job:{label:'submit_job()',calls:['validate_request','update_state'],source:location('void submit_job'),effects:[effect('state_lock','acquire','获取 state_lock','lock(&state_lock)'),effect('state_lock','release','释放 state_lock','unlock(&state_lock)')]},
        validate_request:{label:'validate_request()',calls:[],domain:'library',source:{file:'外部接口',line:null,text:'/* 此示例未提供 validate_request 的实现。 */'},effects:[]},
        maintenance_update:{label:'maintenance_update()',calls:['update_state'],source:location('void maintenance_update'),effects:[]},
        update_state:{label:'update_state(phase)',calls:[],source:location('static void update_state'),effects:[effect('g_state','write','phase ← phase（入参）','g_state.phase = phase'),effect('g_state','rmw','pending += 1','g_state.pending += 1')]},
        read_status:{label:'read_status()',calls:['inspect_state'],source:location('unsigned read_status'),effects:[effect('state_lock','acquire','获取 state_lock','lock(&state_lock)'),effect('state_lock','release','释放 state_lock','unlock(&state_lock)')]},
        inspect_state:{label:'inspect_state()',calls:[],source:location('static unsigned inspect_state'),effects:[effect('g_state','read','读取 phase / pending','return g_state.phase')]},
        reject_job:{label:'reject_job()',calls:[],source:location('void reject_job'),effects:[effect('error_count','rmw','error_count += 1','error_count += 1')]}
      },
      entries:['submit_job','maintenance_update','read_status','reject_job'],
      entryNotes:{submit_job:'传入 READY · 示例中获取锁后调用',maintenance_update:'传入 IDLE · 无局部加锁，调用者持锁未知',read_status:'获取锁后读取两个字段',reject_job:'独立修改错误计数'},
      lockSpans:[
        {entry:'submit_job',lock:'state_lock',functions:['update_state'],status:'example-held',label:'state_lock · 示例标注的持锁范围',acquire:'submit_job: lock(&state_lock)',release:'submit_job: unlock(&state_lock)'},
        {entry:'read_status',lock:'state_lock',functions:['inspect_state'],status:'example-held',label:'state_lock · 示例标注的持锁范围',acquire:'read_status: lock(&state_lock)',release:'read_status: unlock(&state_lock)'}
      ]
    };
  }
  const api={makeResourceSlice,lockExample};
  if(typeof module!=='undefined')module.exports=api;else root.ResourceChainModel=api;
})(typeof window!=='undefined'?window:globalThis);
