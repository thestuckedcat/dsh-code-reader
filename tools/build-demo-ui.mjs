// Rebuild only the Demo UI, preserving the previously compiled C/Wasm payload.
import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../demo/code-view/',import.meta.url);
const read=name=>readFileSync(new URL(name,root),'utf8').replaceAll('\r\n','\n');
const previous=read('index.html');
const bundle=previous.match(/<script type="application\/json" id="bundle">([\s\S]*?)<\/script>/)?.[1];
if(!bundle)throw Error('compiled Demo bundle missing; run demo/code-view/build.py first');
JSON.parse(bundle);
let page=read('page.html');
page=page.replace('%%C_HIGHLIGHT%%',()=>read('c-highlight.js'));
for(const [token,file]of [['GRAPH_MODEL','graph-model.cjs'],['READING_MODEL','reading-model.js'],['SEQUENCE_VIEW','sequence-view.js'],['RESOURCE_CHAIN_MODEL','resource-chains-model.js'],['RESOURCE_CONTEXT_MODEL','resource-context-model.js'],['RESOURCE_CONTEXT_VIEW','resource-context-view.js'],['RESOURCE_CHAINS','resource-chains.js']])page=page.replace('%%'+token+'%%',()=>read(file));
page=page.replace('%%CONTROL_PLANE_CASE%%',()=>JSON.stringify(JSON.parse(read('control-plane-case.json'))).replaceAll('<','\\u003c'));
page=page.replace('%%RESOURCE_CONTEXT_CSS%%',()=>read('resource-context.css'));
page=page.replace('%%BUNDLE%%',()=>bundle);
if(process.argv.includes('--check')){if(page!==previous)throw Error('Demo UI is stale; run node tools/build-demo-ui.mjs');console.log('Demo UI current');}
else{writeFileSync(new URL('index.html',root),page);console.log('rebuilt Demo UI; compiled C/Wasm payload preserved');}
