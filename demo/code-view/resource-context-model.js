(function(root){
  'use strict';
  const writes=new Set(['write','rmw','init','deinit','alloc','free','acquire','release','register','remove']);
  const normalized=context=>({...context,path:[...(context.path||[])],conditions:[...(context.conditions||[])],protection:{business:{status:'unknown',label:'外层保护未知',...context.protection?.business},internal:{status:'unknown',label:'内部保护未知',...context.protection?.internal}}});
  function relationDetail(data,id){
    const relation=(data.relations||[]).find(r=>r.id===id);if(!relation)return null;
    const byId=new Map((data.contexts||[]).map(c=>[c.id,c])),gaps=[];
    const contexts=(relation.contextIds||[]).flatMap(key=>{if(!byId.has(key)){gaps.push('调用上下文未加载：'+key);return [];}return [normalized(byId.get(key))];});
    const implementations=new Set(contexts.map(c=>c.function));
    const relatedContexts=(data.contexts||[]).filter(c=>implementations.has(c.function)&&c.resource===relation.resource).map(normalized);
    return {...relation,contexts,relatedContexts,gaps,protection:{confirmed:contexts.filter(c=>c.protection.business.status==='source-scoped').length,unknown:contexts.filter(c=>c.protection.business.status!=='source-scoped').length}};
  }
  function buildContextGraph(data,selection=[]){
    const selected=new Set(selection),relations=data.relations||[],functions=new Set(relations.map(r=>r.function)),nodes=[];
    for(const key of functions){if(!data.functions[key])continue;const related=relations.filter(r=>r.function===key);nodes.push({id:'fn:'+key,key,type:'function',side:related.some(r=>writes.has(r.action))?'left':'right',...data.functions[key],focused:related.some(r=>selected.has(r.resource))});}
    for(const [key,value]of Object.entries(data.resources||{}))nodes.push({id:'res:'+key,key,type:'resource',...value,focused:selected.has(key)});
    const known=new Set(nodes.map(n=>n.id));
    const edges=relations.map(r=>({...r,from:(writes.has(r.action)?'fn:':'res:')+(writes.has(r.action)?r.function:r.resource),to:(writes.has(r.action)?'res:':'fn:')+(writes.has(r.action)?r.resource:r.function),focused:selected.has(r.resource)})).filter(e=>known.has(e.from)&&known.has(e.to));
    return {nodes,edges};
  }
  function contextAccessEdge(context,action){
    const node='call:'+(context.path.length-1),resource='res:'+context.resource,read=action==='read';
    return {from:read?resource:node,to:read?node:resource,start:read?'l':'r',end:read?'r':'l',marker:read?'read':action==='remove'?'remove':'write'};
  }
  function businessOutline(data){
    const steps=(data.outline?.steps||[]).filter(step=>step.role==='business').map(step=>({...step,functions:[...(step.functions||[])]}));
    return {goal:data.outline?.goal||'',steps,edges:steps.slice(1).map((step,i)=>({from:steps[i].id,to:step.id,kind:'business_sequence',async:!!step.asyncEntry}))};
  }
  const api={relationDetail,buildContextGraph,contextAccessEdge,businessOutline};if(typeof module!=='undefined')module.exports=api;else root.ResourceContextModel=api;
})(typeof window!=='undefined'?window:globalThis);
