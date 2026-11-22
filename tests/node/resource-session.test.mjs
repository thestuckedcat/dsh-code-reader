import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {withSession}=createRequire(import.meta.url)('../../client/document.cjs');

test('恢复/切换来源使用指定镜头，不被旧画布镜头覆盖',()=>{
 const source=readFileSync(new URL('../../demo/code-view/resource-chains.js',import.meta.url),'utf8');
 const load=source.match(/function loadMode\(reset=true\)\{[\s\S]*?(?=\n  function changeSelection)/)[0];
 for(const reset of [false,true]){
  const box={state:{mode:'example',selected:['g_state'],camera:{x:40,y:-20,zoom:.8}},surface:{readCamera:()=>({x:999,y:999,zoom:1})},lockExample:()=>({resources:{g_state:{}},note:'fixture'}),sourceSelect:{},notice:{},renderChoices(){},applyFocus(){}};
  vm.createContext(box);vm.runInContext('function renderGraph(){ captured=surface?.readCamera?.()||state.camera; }'+load+';loadMode('+reset+')',box);
  assert.equal(box.captured.x,reset?14:40);
 }
});

test('真实会话消息携带资源关注、镜头与调用实例',()=>{
 const html=withSession(readFileSync(new URL('../../demo/code-view/index.html',import.meta.url),'utf8'),null,'session');
 const code=html.match(/function remember\(\)\{[\s\S]*?catch\{\}\}/)[0];
 const saved={mode:'source',selected:['r_0'],camera:{x:1,y:2,zoom:.8},selectedInstance:'entry::fn'};
 let posted;
 const box={parent:{postMessage:msg=>posted=msg},bridge:{channel:'session'},focusPath:['entry','fn'],flowRoot:'entry',positions:{},camera:{},canvasSize:'',savedCanvases:new Map(),expandedGroups:new Set(),basic:new Set(),selected:'',selectedPath:[],subflowPath:[],detailTab:'source',history:[],toolsCollapsed:false,scrollY:0,fileCode:{scrollTop:0},byId:()=>({querySelectorAll:()=>[]}),document:{querySelectorAll:()=>[]},window:{ResourceChainUI:{save:()=>saved}}};
 vm.runInNewContext(code+';remember()',box);
 assert.deepEqual(posted.value.resourceChains,saved);
});
