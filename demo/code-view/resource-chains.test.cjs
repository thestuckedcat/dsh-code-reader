const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');

// The fixture is source-annotated presentation data, never runtime evidence.
function api(){const box={module:{exports:{}}};vm.runInNewContext(readFileSync(`${__dirname}/resource-chains-model.js`,'utf8'),box);return box.module.exports;}

test('共享实现保留两个入口上下文，持锁与未知分开',()=>{
 const {makeResourceSlice,lockExample}=api();const data=lockExample();const graph=makeResourceSlice(data,['g_state']);
 const nodes=graph.nodes.filter(n=>n.function==='update_state');
 assert.equal(nodes.length,2);
 assert.deepEqual(new Set(nodes.map(n=>n.lockStatus)),new Set(['example-held','unknown']));
 assert.ok(nodes.every(n=>n.effects.some(e=>e.resource==='g_state'&&e.access==='write')));
});

test('资源多选是并集，资源定义节点唯一，未关注动作不被丢弃',()=>{
 const {makeResourceSlice,lockExample}=api();const data=lockExample();const graph=makeResourceSlice(data,['g_state','error_count']);
 assert.equal(graph.resources.filter(r=>r.key==='g_state').length,1);
 assert.ok(graph.entries.includes('reject_job'));
 const g=makeResourceSlice(data,['state_lock']);assert.ok(!g.entries.includes('maintenance_update'));
});

test('共享下游保留全部调用边，递归不会无限展开',()=>{
 const {makeResourceSlice}=api();
 const data={resources:{x:{name:'x'}},functions:{a:{calls:['b','c'],effects:[]},b:{calls:['d'],effects:[]},c:{calls:['d'],effects:[]},d:{calls:['b'],effects:[{resource:'x',access:'write',expression:'x = 1'}]}},entries:['a']};
 const graph=makeResourceSlice(data,['x']);
 assert.equal(graph.nodes.length,4);assert.equal(graph.edges.length,5);assert.equal(graph.truncated,false);
});

test('布局预算明确标记截断，不声称已显示全部',()=>{
 const {makeResourceSlice,lockExample}=api();const graph=makeResourceSlice(lockExample(),['g_state'],{maxNodes:2});assert.equal(graph.truncated,true);assert.ok(graph.totalNodes>graph.nodes.length);
});
