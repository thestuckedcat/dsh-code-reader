const {test}=require('node:test');
const assert=require('node:assert/strict');
const {existsSync,readFileSync}=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const file=path.join(__dirname,'resource-context-model.js');
const box={module:{exports:{}}};if(existsSync(file))vm.runInNewContext(readFileSync(file,'utf8'),box);const api=box.module.exports;
const fixture=()=>({resources:{r:{name:'state'}},functions:{a:{label:'entry'},f:{label:'shared'},g:{label:'reader'}},relations:[{id:'w',function:'a',resource:'r',action:'write',contextIds:['one','two']},{id:'r',function:'g',resource:'r',action:'read',contextIds:[]}],contexts:[{id:'one',function:'f',path:['a','f'],conditions:['ready'],protection:{business:{status:'source-scoped',label:'keyed lock'},internal:{status:'source-scoped',label:'container mutex'}}},{id:'two',function:'f',path:['a','f'],conditions:['nonempty'],protection:{business:{status:'unknown',label:'caller scope unknown'},internal:{status:'source-scoped',label:'container mutex'}}}]});

test('同一实现的两个调用上下文不合并，业务锁与内部锁分开',()=>{
 assert.equal(typeof api.relationDetail,'function','relation detail model is required');
 const detail=api.relationDetail(fixture(),'w');
 assert.equal(detail.contexts.length,2);assert.equal(detail.contexts[0].function,detail.contexts[1].function);
 assert.equal(detail.protection.confirmed,1);assert.equal(detail.protection.unknown,1);
 assert.equal(detail.contexts[1].protection.business.status,'unknown');
 assert.equal(detail.contexts[1].protection.internal.status,'source-scoped');
 assert.equal(JSON.stringify(detail.contexts[1].conditions),'["nonempty"]');
});
test('总览函数与资源唯一，多关系不复制实体，读写方向分开',()=>{
 assert.equal(typeof api.buildContextGraph,'function','context graph model is required');
 const data=fixture();data.relations.push({id:'w2',function:'a',resource:'r',action:'read',contextIds:[]});
 const graph=api.buildContextGraph(data,['r']);
 assert.equal(graph.nodes.filter(n=>n.type==='function'&&n.key==='a').length,1);
 assert.equal(graph.nodes.filter(n=>n.type==='resource').length,1);assert.equal(graph.edges.length,3);
 assert.equal(graph.edges.find(e=>e.id==='w').from,'fn:a');
 assert.equal(graph.edges.find(e=>e.id==='w2').from,'res:r');
});
test('没有保护数据保持未知，不默认为无锁，也不因内部锁推断业务锁',()=>{
 assert.equal(typeof api.relationDetail,'function','relation detail model is required');
 const data=fixture();delete data.contexts[0].protection;
 const detail=api.relationDetail(data,'w');assert.equal(detail.protection.confirmed,0);assert.equal(detail.protection.unknown,2);
 assert.equal(detail.contexts[0].protection.business.status,'unknown');
});
test('关系过滤保留背景资源；失效引用如实给出缺口，不拼接路径',()=>{
 assert.equal(typeof api.relationDetail,'function','relation detail model is required');
 const data=fixture();data.resources.other={name:'other'};data.relations[0].contextIds.push('missing');
 const detail=api.relationDetail(data,'w');assert.equal(detail.contexts.length,2);assert.ok(detail.gaps.length);
 assert.equal(JSON.stringify(detail.contexts.map(c=>c.path)),'[["a","f"],["a","f"]]');
 const graph=api.buildContextGraph(data,['r']);assert.equal(graph.nodes.find(n=>n.id==='res:other').focused,false);
 assert.equal(api.relationDetail(data,'missing'),null);
});
test('源码案例保留共用实现的对比、独立容器锁、原始行号和完整许可头',()=>{
 const data=JSON.parse(readFileSync(path.join(__dirname,'control-plane-case.json'),'utf8'));
 const detail=api.relationDetail(data,'borrow-write');assert.equal(detail.contexts.length,1);assert.equal(detail.relatedContexts.length,2);
 assert.equal(detail.relatedContexts.find(c=>c.id==='update-export').protection.business.status,'unknown');
 assert.equal(data.observed,false);assert.equal(data.provenance,'source_reviewed');
 for(const source of Object.values(data.evidence)){assert.equal(source.text.split('\n').length,source.last-source.line+1);assert.match(source.fileSha256,/^[a-f0-9]{64}$/);}
 for(const header of Object.values(data.copyrightHeaders)){assert.match(header,/Copyright/);assert.ok(header.endsWith('*/'));}
 assert.match(data.licenseText,/Mulan|木兰/);
});
test('替换仓库实体名称和关系ID仍按同一模型渲染，不依赖样例命名',()=>{
 const source=fixture(),data=JSON.parse(JSON.stringify(source).replaceAll('state','table').replaceAll('"w"','"changed"'));
 const detail=api.relationDetail(data,'changed');assert.equal(detail.contexts.length,2);
 assert.equal(api.buildContextGraph(data,['r']).nodes.find(n=>n.id==='res:r').name,'table');
});
test('读取路径的末端边从资源指向调用，写入路径方向相反',()=>{
 assert.equal(typeof api.contextAccessEdge,'function','path access direction is required');
 const context={path:['entry','callee'],resource:'table'};
 const read=api.contextAccessEdge(context,'read'),write=api.contextAccessEdge(context,'write');
 assert.equal(read.from,'res:table');assert.equal(read.to,'call:1');assert.equal(read.marker,'read');
 assert.equal(write.from,'call:1');assert.equal(write.to,'res:table');assert.equal(write.marker,'write');
});
test('业务骨架只保留主阶段和关键实现，支撑细节不进入主图',()=>{
 assert.equal(typeof api.businessOutline,'function','business outline is required');
 const data={outline:{goal:'complete a request',steps:[{id:'receive',title:'接收',role:'business',functions:['a']},{id:'guard',title:'校验',role:'support',functions:['check']},{id:'publish',title:'登记',role:'business',functions:['b']}]}};
 const outline=api.businessOutline(data);assert.equal(outline.goal,'complete a request');
 assert.equal(JSON.stringify(outline.steps.map(s=>s.id)),'["receive","publish"]');
 assert.equal(outline.edges.length,1);assert.equal(outline.edges[0].kind,'business_sequence');
 assert.equal(JSON.stringify(outline.steps[0].functions),'["a"]');
});
