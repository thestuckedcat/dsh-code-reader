// CL-UI-R1: the old main-panel DOM assertions are replaced by native-pane
// lifecycle/RPC tests here and real canonical-renderer interactions in
// tools/demo-rebuild-probe.cjs. This tests the shipped bundle, not a duplicate UI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,makeSnapshotsPayload,makeEntriesPayload,makeEntryPayload,makeCouplingPayload,makeEndToEndPayload,makeFileTreePayload,makeFileReadPayload,makeInterfacesPayload,makeStubProfilesPayload,deferred} from './helpers/client-harness.mjs';

function setup() {
  const h=createHarness(),tabs=[],listeners=new Map();
  h.ctx.sidebarRightTabs={register(def){tabs.push(def);return()=>tabs.splice(tabs.indexOf(def),1);}};
  h.ctx.sidebarRight={openTab(){}};
  h.window.addEventListener=(name,fn)=>listeners.set(name,fn);
  h.window.removeEventListener=(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);};
  const fixtures={
    'view.listSnapshots':makeSnapshotsPayload,
    'view.listEntries':makeEntriesPayload,
    'view.getEntry':makeEntryPayload,
    'view.coupling':makeCouplingPayload,
    'view.endToEnd':makeEndToEndPayload,
    'view.fileTree':makeFileTreePayload,
    'view.fileRead':makeFileReadPayload,
    'view.interfaces':makeInterfacesPayload,
  };
  for(const [method,factory]of Object.entries(fixtures))h.rpc.setResponse(method,()=>factory());
  h.mountPane=(session='session-a')=>{
    const entry=h.slots.entriesOfSlot('sidebar.right.pane.tab')[0];
    h.react.mount(entry.component,entry.options.inject(session,{}));
  };
  h.frame=()=>h.find(n=>n.tag==='iframe');
  h.source=()=>h.find(n=>n.tag==='select');
  h.choose=async value=>{await h.source().props.onChange({target:{value}});await h.settle();};
  h.tabs=tabs;h.listeners=listeners;return h;
}
async function boot() {const h=setup();h.apply();h.mountPane();await h.settle();return h;}

test('发布包依赖宿主原生右栏并只需要静态 react 模块',()=>{
 const h=setup();try{assert.equal(h.loadError,null);assert.equal(h.factoryError,null);assert.deepEqual(h.requires,['react']);assert.ok(h.plugin.inject.includes('sidebarRightTabs'));}finally{h.dispose();}
});
test('仅注册原生页面类型及 body/title，不占用聊天主区域或根 rightbar',()=>{
 const h=setup();try{h.apply();assert.equal(h.tabs.length,1);assert.deepEqual(h.slots.entries.map(e=>e.options.name).sort(),['sidebar.right.pane.tab','sidebar.right.pane.tab.title']);assert.equal(h.slots.entriesOfSlot('main').length,0);assert.equal(h.slots.entriesOfSlot('rightbar').length,0);}finally{h.dispose();}
});
test('原生右栏开始页提供代码工作台入口',()=>{
 const h=setup();try{h.apply();const d=h.tabs[0];assert.equal(d.kind,'code-workbench');assert.equal(d.id,'code-workbench');assert.deepEqual(d.patterns,['sidebar://code-workbench']);assert.equal(d.priority,'extension');assert.equal(d.guide[0].title(),'代码工作台');}finally{h.dispose();}
});
test('dispose 注销原生类型及插槽，二次挂载不重复',()=>{
 const h=setup();try{h.apply();h.ctx.dispose();assert.equal(h.tabs.length,0);assert.equal(h.slots.entries.length,0);h.apply();assert.equal(h.tabs.length,1);assert.equal(h.slots.entries.length,2);}finally{h.dispose();}
});
test('缺少原生右栏明确失败，不能偷偷降级成主页面',()=>{
 const h=setup();try{delete h.ctx.sidebarRightTabs;assert.throws(()=>h.apply(),/原生右栏/);assert.equal(h.slots.entries.length,0);}finally{h.dispose();}
});
test('默认内联当前 Demo，样式与五视图完整，隔离 iframe 支持表单模拟',async()=>{
 const h=await boot();try{const f=h.frame();assert.match(f.props.srcDoc,/id="coupling-workspace"/);assert.match(f.props.srcDoc,/id="text-workspace"/);assert.match(f.props.srcDoc,/id="flow-workspace"/);assert.match(f.props.srcDoc,/id="sequence-workspace"/);assert.match(f.props.srcDoc,/id="file-workspace"/);assert.equal(f.props.sandbox,'allow-scripts allow-forms');assert.ok(!f.props.sandbox.includes('allow-same-origin'));assert.equal(h.styleCount(),0);}finally{h.dispose();}
});
test('样例首屏只读取快照目录，不等待 Python 生成图',async()=>{
 const h=await boot();try{assert.deepEqual(h.rpc.endpoints(),['view.listSnapshots']);assert.match(h.frame().props.srcDoc,/WebAssembly.instantiate/);}finally{h.dispose();}
});
test('真实快照列表自动出现在来源选择器',async()=>{
 const h=await boot();try{assert.match(h.text(),/code-view-bus-demo/);assert.equal(h.source().children.length,2);}finally{h.dispose();}
});
test('真实快照使用已有 Host 端点并进入同一个 Demo 渲染器',async()=>{
 const h=await boot();try{const option=h.source().children[1];await h.choose(option.props.value);assert.match(h.frame().props.srcDoc,/window.__CODE_VIEW_MODEL__=/);assert.match(h.frame().props.srcDoc,/静态快照/);assert.ok(h.rpc.callsFor('view.getEntry').length>0);assert.ok(h.rpc.callsFor('view.endToEnd').length>0);for(const call of h.rpc.calls)assert.equal(call.channel,'/code-view');for(const payload of h.rpc.payloadsFor('view.fileRead'))assert.equal(Object.hasOwn(payload,'line'),false);}finally{h.dispose();}
});
test('快照读取错误保留已有画布并展示原因',async()=>{
 const h=await boot();try{const before=h.frame().props.srcDoc;h.rpc.fail('view.listEntries','BROKEN','快照已失效');await h.choose(h.source().children[1].props.value);assert.equal(h.frame().props.srcDoc,before);assert.match(h.text(),/快照已失效/);}finally{h.dispose();}
});
test('列表不可用时样例仍可打开，错误可见',async()=>{
 const h=setup();try{h.rpc.fail('view.listSnapshots','MISSING','Python 不可用');h.apply();h.mountPane();await h.settle();assert.ok(h.frame());assert.match(h.text(),/Python 不可用/);}finally{h.dispose();}
});
test('切换回样例会取消尚未完成的快照，不让迟到结果覆盖',async()=>{
 const h=await boot();try{const blocked=deferred();h.rpc.setResponse('view.listEntries',()=>blocked.promise);const loading=h.source().props.onChange({target:{value:h.source().children[1].props.value}});await h.settle();await h.choose('demo');blocked.resolve(makeEntriesPayload());await loading;await h.settle();assert.equal(h.source().props.value,'demo');assert.ok(!h.frame().props.srcDoc.includes('window.__CODE_VIEW_MODEL__='));}finally{h.dispose();}
});
test('卸载取消请求、移除 message 监听并可重新打开',async()=>{
 const h=await boot();try{assert.ok(h.listeners.has('message'));h.react.unmount();assert.equal(h.listeners.has('message'),false);assert.ok(h.rpc.calls[0].signal.aborted);h.mountPane();await h.settle();assert.ok(h.frame());}finally{h.dispose();}
});
test('跨窗消息须匹配 iframe 和私有 channel；当前函数选择跨重开保留',async()=>{
 const h=await boot();try{const f=h.frame(),sender={};f.props.ref.current={contentWindow:sender};const token=/const bridge=(\{[^\n]+\});/.exec(f.props.srcDoc);assert.ok(token);const channel=JSON.parse(token[1]).channel;const receive=h.listeners.get('message');receive({source:{},data:{type:'selection',channel,value:{path:['bad']}}});receive({source:sender,data:{type:'selection',channel,value:{path:['bus_send','lookup_route'],root:'bus_send',view:'text'}}});h.react.unmount();h.mountPane();await h.settle();assert.match(h.frame().props.srcDoc,/"path":\["bus_send","lookup_route"\]/);}finally{h.dispose();}
});
test('不同宿主会话的选择互不污染',async()=>{
 const h=await boot();try{h.react.unmount();h.mountPane('session-b');await h.settle();assert.match(h.frame().props.srcDoc,/"selection":null/);}finally{h.dispose();}
});

test('沙箱 RPC 只允许当前快照的已知操作并保留准入路径',async()=>{
 const h=await boot();try{
  await h.choose(h.source().children[1].props.value);h.rpc.setResponse('scenario.listProfiles',()=>makeStubProfilesPayload());
  const f=h.frame(),messages=[],sender={postMessage:m=>messages.push(m)};f.props.ref.current={contentWindow:sender};
  const channel=JSON.parse(/const bridge=(\{[^\n]+\});/.exec(f.props.srcDoc)[1]).channel;
  const receive=h.listeners.get('message');
  await receive({source:sender,data:{type:'rpc',channel,id:'rpc_1',method:'scenario.listProfiles',payload:{workspace:'code-view-bus-demo'}}});
  assert.equal(messages[0].value.profiles[0].profile_id,'bus-demo-wasm');
  await receive({source:sender,data:{type:'rpc',channel,id:'rpc_2',method:'scenario.run',payload:{workspace:'other'}}});
  await receive({source:sender,data:{type:'rpc',channel,id:'rpc_3',method:'code_execute',payload:{workspace:'code-view-bus-demo'}}});
  assert.equal(h.rpc.callsFor('scenario.run').length,0);assert.ok(messages[1].error);assert.ok(messages[2].error);
 }finally{h.dispose();}
});
