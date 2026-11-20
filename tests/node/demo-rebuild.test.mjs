import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {makeEntriesPayload, makeEntryPayload, makeCouplingPayload, makeEndToEndPayload, makeFileReadPayload} from './helpers/client-harness.mjs';

const require = createRequire(import.meta.url);
const {createDocument} = require('../../client/document.cjs');
const {createModel} = require('../../client/model.cjs');
const {compatibleScenario} = require('../../client/scenario.cjs');
const demo = readFileSync(new URL('../../demo/code-view/index.html', import.meta.url), 'utf8');

test('默认右栏文档完整复用当前 Demo 字节', () => {
  assert.equal(createDocument(demo), demo);
});

test('发布产物以 LF 规范化 Demo，跨 Windows/Linux 检查不受 checkout 换行影响',()=>{
 const bundle=readFileSync(new URL('../../bundle/client.js',import.meta.url),'utf8');
 const hash=createHash('sha256').update(demo.replaceAll('\r\n','\n')).digest('hex');
 assert.ok(bundle.includes(`Canonical Demo SHA256: ${hash}`));
});

test('真实模型保持来源和字段证据、不带样例资源', () => {
  const model = createModel({entries: makeEntriesPayload(), details: [makeEntryPayload()], coupling: makeCouplingPayload(), flows: [makeEndToEndPayload()], files: [makeFileReadPayload()]});
  assert.ok(Object.values(model.functions).some(f => f.name === 'bus_send'));
  assert.equal(Object.keys(model.resources).length, 1);
  assert.ok(!Object.hasOwn(model.resources, 'simulated_doorbell'));
  assert.ok(JSON.stringify(model.resourceLinks).includes('may'));
  assert.equal(model.observed, false);
  const html = createDocument(demo, model);
  assert.ok(html.includes('window.__CODE_VIEW_MODEL__='));
  assert.ok(html.includes('静态快照'));
  for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});

test('模型中的代码不能闭合 script 标签', () => {
  const model = createModel({entries: makeEntriesPayload(), details: [makeEntryPayload()], coupling: makeCouplingPayload(), flows: [], files: []});
  model.caption = '</script><script>window.pwned=true</script>';
  const html = createDocument(demo, model);
  assert.ok(!html.includes('window.__CODE_VIEW_MODEL__={"caption":"</script>'));
  assert.ok(html.includes('\\u003c/script>'));
});

test('同名跨仓符号保持不同 ID，资源和函数标识不冲突', () => {
  const a = makeEntryPayload();
  const b = makeEntryPayload();
  b.entry = {...b.entry, entry_id:'f_other', name:'bus_send', file:'other.c'};
  const model = createModel({entries:makeEntriesPayload({entries:[a.entry,b.entry]}), details:[a,b], coupling:makeCouplingPayload(), flows:[], files:[]});
  assert.equal(new Set(Object.keys(model.functions)).size, Object.keys(model.functions).length);
  assert.equal(Object.values(model.functions).filter(f=>f.name==='bus_send').length,2);
  assert.equal(new Set([...Object.keys(model.functions),...Object.keys(model.resources)]).size,Object.keys(model.functions).length+Object.keys(model.resources).length);
});

test('自动存储期的局部对象不进入全局资源图，普通边没有异常标记', () => {
  const coupling=makeCouplingPayload();
  coupling.resources.push({...coupling.resources[0],resource_id:'s_local',name:'channel',storage:'NONE',lifetime:'automatic'});
  const model=createModel({entries:makeEntriesPayload(),details:[makeEntryPayload()],coupling,flows:[makeEndToEndPayload()],files:[]});
  assert.equal(Object.keys(model.resources).length,1);
  const edges=Object.values(model.flows).flatMap(f=>f.edges);
  assert.ok(edges.some(e=>e.length===5));
  assert.ok(edges.some(e=>e[5]==='error'));
});

test('字段快照缺少标量时，以标明 source_text 的声明补全；不收局部 static', () => {
  const lines=['static unsigned flag;','static unsigned counts[4];','void start(void)','{','    static unsigned local;','    flag = 1;','    counts[0]++;','}'];
  const entry={entry_id:'start-id',name:'start',file:'a.c',line:3,is_entry:true};
  const model=createModel({entries:{snapshot:{repo_id:'a'},entries:[entry]},details:[{entry,source:{lines:lines.slice(2).map((text,i)=>({n:i+3,text})),line_end:8}}],coupling:{resources:[]},files:[{repo_id:'a',path:'a.c',total_lines:lines.length,lines:lines.map((text,i)=>({n:i+1,text}))}]});
  assert.deepEqual(Object.values(model.variables).map(v=>v.name).sort(),['counts','flag']);
  assert.match(JSON.stringify(model.resourceLinks),/source_text/);
  assert.ok(model.gaps.some(g=>g.includes('条件编译')));
});

test('外部边界有独立身份，不能展示入口的源码',()=>{
 const model=createModel({entries:makeEntriesPayload(),details:[makeEntryPayload()],coupling:makeCouplingPayload(),flows:[makeEndToEndPayload()],files:[]});
 const external=Object.values(model.flows).flatMap(f=>Object.values(f.nodes)).find(n=>n.kind==='external');
 assert.ok(external);
 assert.equal(model.functions[external.function].domain,'library');
 assert.notEqual(model.functions[external.function].name,'bus_send');
});

test('跨仓同路径资源优先当前仓，保留锁和生命周期访问含义',()=>{
 const resources=[{resource_id:'r',name:'flag',file:'shared.c',storage:'STATIC',lifetime:'static',accesses:['acquire','release','alloc','free','init','deinit','rmw','unknown'].map((access,i)=>({access,function_id:'f',function_name:'run',certainty:'exact',location:{file:'shared.c',line:i+1}}))}];
 const model=createModel({entries:{snapshot:{repo_id:'primary'},entries:[{entry_id:'f',name:'run',file:'shared.c',line:2,is_entry:true}]},details:[],coupling:{resources},files:[{repo_id:'primary',path:'shared.c',total_lines:1,lines:[{n:1,text:'static unsigned flag;'}]},{repo_id:'other',path:'shared.c',total_lines:1,lines:[{n:1,text:'static unsigned other_flag;'}]}]});
 const flag=Object.values(model.variables).find(v=>v.name==='flag');
 assert.equal(flag.file,'primary/shared.c');
 assert.equal(Object.values(model.variables).filter(v=>v.name==='flag').length,1);
 const text=JSON.stringify(model.resourceLinks);
 for(const verb of ['加锁','解锁','分配','释放','初始化','去初始化','读改写'])assert.ok(text.includes(verb),verb);
 const actions=Object.values(model.resourceEffects).flat();
 for(const access of ['acquire','release','alloc','free','init','deinit','rmw','unknown'])assert.ok(actions.some(e=>e.access===access),access);
 assert.ok(actions.every(e=>model.functions[e.function]&&e.source.file==='primary/shared.c'&&e.certainty==='exact'));
});

test('同名接口的其他快照/其他运行配置台账不得混入当前阅读',()=>{
 const scope={snapshot:'current'},profile={profile_id:'profile'};
 assert.equal(compatibleScenario({snapshot_id:'current',profile_id:'profile'},scope,profile),true);
 assert.equal(compatibleScenario({snapshot_id:'older',profile_id:'profile'},scope,profile),false);
 assert.equal(compatibleScenario({snapshot_id:'current',profile_id:'other'},scope,profile),false);
});
