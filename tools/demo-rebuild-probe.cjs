// Real Chromium probe; runs in an isolated Electron profile. Does not touch
// the user's desktop host. Assertions operate on the shipped document.
const {app,BrowserWindow}=require('electron');
const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {join,resolve}=require('node:path');
const root=process.env.WB_ROOT || resolve(__dirname,'..');
const out=process.env.WB_OUT || join(root,'scratch','demo-rebuild');
const url=process.env.WB_URL || JSON.parse(readFileSync(join(root,'scratch','rebuild-host.json'),'utf8')).url;
mkdirSync(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={ok:false,started_at_utc:new Date().toISOString(),checks:[],console:[]};
function check(name,value,detail){report.checks.push({name,ok:!!value,detail});if(!value)throw Error(name+': '+JSON.stringify(detail));}
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1600,height:1060,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(_e,level,message)=>{report.console.push({level,message});});
 win.setOpacity(0);win.showInactive();
 const evaluate=code=>win.webContents.executeJavaScript(code);
 try {
  await win.loadURL(url);await sleep(2600);
  // Host-only preview/onboarding dismissal.
  for(let i=0;i<6;i++) {
   const done=await evaluate(`(()=>{const d=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find(e=>e.getBoundingClientRect().width);if(!d)return true;const b=[...d.querySelectorAll('button')].find(e=>/稍后|跳过|继续|关闭/.test((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')));if(b)b.click();return false;})()`);
   if(done)break;await sleep(250);
  }
  await evaluate(`document.querySelector('button[aria-label="打开右侧边栏"]')?.click()`);await sleep(400);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.startsWith('代码工作台'));b?.click();})()`);await sleep(1400);
  await evaluate(`document.querySelector('button[aria-label="退出全屏"]')?.click()`);await sleep(150);
  writeFileSync(join(out,'host-dom.json'),JSON.stringify(await evaluate(`({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(e=>({text:e.textContent,aria:e.getAttribute('aria-label'),title:e.getAttribute('title')}))})`),null,2));
  writeFileSync(join(out,'host-before.png'),(await win.webContents.capturePage()).toPNG());
  report.frames=win.webContents.mainFrame.framesInSubtree.map(f=>({url:f.url,name:f.name}));
  if(process.env.WB_INSPECT==='1')return;
  let frame=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
  check('native-right-pane-mounted',!!frame);
  const rect=await evaluate(`(()=>{const r=document.querySelector('[data-code-workbench="right-pane"]').getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,bodyWidth:innerWidth};})()`);
  check('right-pane-keeps-chat',rect.left>350&&rect.right<=rect.bodyWidth+1,rect);
  const run=code=>frame.executeJavaScript(code);
  check('sample-boot',await run(`Boolean(run && c && document.querySelector('#graph .viewport'))`));
  await run(`(()=>{const b=document.querySelector('button[aria-label="折叠或展开工具区"]');if(b.getAttribute('aria-expanded')==='true')b.click();})()`);
  check('narrow-tools-collapse',await run(`document.querySelector('button[aria-label="折叠或展开工具区"]').getAttribute('aria-expanded')==='false'&&byId('simulation').hidden`));
  await run(`document.querySelector('button[aria-label="折叠或展开工具区"]').click()`);
  check('narrow-tools-expand',await run(`!byId('simulation').hidden`));
  await evaluate(`document.querySelector('button[aria-label="全屏"]')?.click()`);await sleep(350);
  const dimensions=await run(`({width:innerWidth,height:innerHeight})`);
  const reference=new BrowserWindow({show:false,width:dimensions.width+40,height:dimensions.height+40,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  reference.setOpacity(0);reference.showInactive();await reference.loadURL('about:blank');
  await reference.webContents.executeJavaScript(`document.body.style.margin='0';document.body.style.overflow='hidden';const f=document.createElement('iframe');f.style.cssText='display:block;border:0;width:${dimensions.width}px;height:${dimensions.height}px';f.srcdoc=${JSON.stringify(readFileSync(join(root,'demo','code-view','index.html'),'utf8'))};document.body.append(f);`);await sleep(350);
  const referenceFrame=reference.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
  const geometry=`(()=>({width:innerWidth,height:innerHeight,nodes:[...document.querySelectorAll('#graph [data-node]')].map(n=>({id:n.dataset.node,shape:n.dataset.shape,left:n.style.left,top:n.style.top,color:getComputedStyle(n).backgroundColor})),views:[...document.querySelectorAll('.view-switch button')].map(n=>n.textContent)}))()`;
  const actual=await run(geometry);
  const baseline=await referenceFrame.executeJavaScript(geometry);
  const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  check('same-viewport-demo-geometry',stable(baseline)===stable(actual),{reference:{width:baseline.width,height:baseline.height,nodes:baseline.nodes.length},plugin:{width:actual.width,height:actual.height,nodes:actual.nodes.length}});
  writeFileSync(join(out,'reference-same-viewport.png'),(await reference.webContents.capturePage({x:0,y:0,width:dimensions.width,height:dimensions.height})).toPNG());
  const clip=await evaluate(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)};})()`);
  writeFileSync(join(out,'plugin-same-viewport.png'),(await win.webContents.capturePage(clip)).toPNG());
  reference.destroy();
  writeFileSync(join(out,'demo-end-to-end.png'),(await win.webContents.capturePage()).toPNG());
  const views=['coupling','text','flow','sequence','files'];
  for(const v of views) {
    await run(`document.querySelector('[data-view="${v}"]').click()`);await sleep(100);
    check('view-'+v,await run(`!document.getElementById('${v==='files'?'file':v}-workspace').hidden`));
    writeFileSync(join(out,`demo-${v}.png`),(await win.webContents.capturePage()).toPNG());
  }
  await run(`document.querySelector('[data-view="flow"]').click();byId('interface').value='bus_register';renderFields();byId('scenario').requestSubmit();byId('interface').value='bus_send';renderFields();byId('arg-length').value=48;byId('scenario').requestSubmit();`);
  check('sample-c-returns-zero-and-register',await run(`run.byEntry.get('bus_send').status===0 && byId('register').textContent==='0x00020030'`));
  await run(`byId('arg-length').value=65;byId('scenario').requestSubmit();`);
  check('sample-c-length-error',await run(`run.byEntry.get('bus_send').status===-90`));
  await run(`byId('undo-count').value=1;byId('undo').click();`);
  check('tail-undo-replays-state',await run(`history.length===2&&run.byEntry.get('bus_send').status===0`));
  await run(`document.querySelector('[data-function="bus_send"]').click();`);
  check('source-panel',await run(`!byId('implementation').hidden&&byId('source').textContent.includes('int bus_send')`));
  await run(`byId('resource-tab').click()`);check('resource-tab',await run(`byId('detail-data').textContent.includes('transfer_lock')`));
  await run(`byId('summary-tab').click()`);check('summary-tab',await run(`byId('detail-data').textContent.includes('查运行时路由')`));
  await run(`byId('close-code').click();document.querySelector('[data-view="coupling"]').click();document.querySelector('[data-coupling-resource="routes"]').click()`);
  check('resource-definition-and-field-notes',await run(`!byId('resource-definition').hidden&&byId('resource-definition-body').textContent.includes('max_len')`));
  check('unique-resource-and-function-boxes',await run(`document.querySelectorAll('[data-coupling-resource="routes"]').length===1&&document.querySelectorAll('#coupling-graph [data-node="bus_send"]').length===1`));
  await run(`closeResourceDefinition();document.querySelector('[data-view="flow"]').click();openFunction('commit_transfer');`);
  await run(`byId('toggle-basic').click()`);
  check('basic-interface-blackbox',await run(`basic.has('commit_transfer')&&detailTab==='contract'&&byId('detail-data').textContent.includes('入参校验')`));
  await run(`byId('toggle-basic').click()`);
  check('remove-basic-interface',await run(`!basic.has('commit_transfer')&&detailTab==='source'`));
  await run(`gotoSubflow(['bus_send','dispatch_transfer'])`);
  check('subflow-and-breadcrumb',await run(`byId('breadcrumb').textContent.includes('dispatch_transfer')&&byId('graph').querySelectorAll('.subflow [data-function]').length>=2`));
  await run(`gotoSubflow([]);setFlowRoot('bus_send');expandedGroups.delete('routeGroup');render();`);
  check('collapsed-group-is-process',await run(`byId('graph').querySelector('[data-group="routeGroup"]').dataset.shape==='process'`));
  await run(`byId('graph').querySelector('[data-group="routeGroup"]').click();openFunction('bus_send');`);
  // Real pointer events, through the frame, must drag without opening source.
  await run(`byId('close-code').click();byId('graph').scrollIntoView({block:'start'});`);await sleep(100);
  const beforeDrag=await run(`JSON.stringify(positions.bus_send)`);
  const point=await run(`(()=>{const r=byId('graph').querySelector('[data-function="bus_send"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const frameRect=await evaluate(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y};})()`);
  const x=Math.round(frameRect.x+point.x),y=Math.round(frameRect.y+point.y);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+70,y:y+35,button:'left',buttons:1});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+70,y:y+35,button:'left',buttons:0,clickCount:1});
  win.webContents.debugger.detach();await sleep(100);
  check('drag-node',await run(`JSON.stringify(positions.bus_send)!==${JSON.stringify(beforeDrag)}`),{point,frameRect,before:beforeDrag,after:await run('JSON.stringify(positions.bus_send)')});
  check('drag-does-not-open-source',await run(`byId('implementation').hidden`));
  const readingState=await run(`JSON.stringify({positions,camera,expandedGroups:[...expandedGroups]})`);
  await run(`document.dispatchEvent(new Event('pointerup'))`);await sleep(100);
  await evaluate(`document.querySelector('button[aria-label="关闭"]')?.click()`);await sleep(150);
  check('native-tab-close',!await evaluate(`Boolean(document.querySelector('[data-workbench-frame]'))`));
  await evaluate(`document.querySelector('button[aria-label="打开右侧边栏"]')?.click();document.querySelector('button[aria-label="新标签页"]')?.click();`);await sleep(200);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.startsWith('代码工作台'));b?.click();})()`);await sleep(700);
  frame=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
  const restored=await run(`({positions,camera,expandedGroups:[...expandedGroups]})`);
  check('reopen-restores-drag-zoom-groups',stable(restored)===stable(JSON.parse(readingState)),{before:JSON.parse(readingState),after:restored});
  await evaluate(`document.querySelector('button[aria-label="全屏"]')?.click()`);await sleep(150);
  await run(`[...byId('graph').querySelectorAll('.zoom-buttons button')].find(b=>b.textContent==='规整').click()`);
  check('arrange-restores-layout',await run(`JSON.stringify(positions.bus_send)===JSON.stringify(sendLayout.bus_send)`));
  await run(`openFunction('bus_send');byId('graph').querySelector('.viewport').click()`);
  check('blank-closes-source',await run(`byId('implementation').hidden`));
  await run(`document.querySelector('[data-view="text"]').click();chooseReadingPath(['bus_send','lookup_route'],'text');document.querySelector('[data-view="flow"]').click()`);
  check('cross-view-selection',await run(`focusPath.at(-1)==='lookup_route'&&byId('graph').querySelector('[data-function="lookup_route"]').getAttribute('aria-current')==='true'`));
  await run(`document.querySelector('[data-view="sequence"]').click();byId('sequence-form').requestSubmit()`);await sleep(250);
  check('sequence-multiple-calls',await run(`byId('sequence-chart').querySelector('svg')&&byId('sequence-status').textContent.includes('2 个接口')`));
  // Actual Atlas/Python source, through the same admitted Host API.
  const options=await evaluate(`Array.from(document.querySelector('select[aria-label="工作台数据来源"]').options).map(o=>o.value)`);
  check('real-snapshot-listed',options.length>1,options);
  await evaluate(`(()=>{const s=document.querySelector('select[aria-label="工作台数据来源"]');s.value=${JSON.stringify(options[1])};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for(let i=0;i<180;i++) {
    await sleep(250);frame=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
    if(await frame?.executeJavaScript(`Boolean(window.__CODE_VIEW_MODEL__&&document.querySelector('#graph .viewport'))`).catch(()=>false))break;
    const error=await evaluate(`document.querySelector('[role="alert"]')?.textContent`);if(error)throw Error(error);
  }
  check('real-snapshot-rendered',await run(`Boolean(window.__CODE_VIEW_MODEL__&&run&&document.querySelector('#graph .viewport'))`));
  for(const v of views) {
    await run(`document.querySelector('[data-view="${v}"]').click()`);await sleep(100);
    check('snapshot-view-'+v,await run(`!document.getElementById('${v==='files'?'file':v}-workspace').hidden`));
    writeFileSync(join(out,`snapshot-${v}.png`),(await win.webContents.capturePage()).toPNG());
  }
  report.model=await run(`({caption:model.caption,functions:Object.keys(functions).length,resources:Object.keys(resources).length,gaps:model.gaps})`);
  check('scalar-static-resources-included',report.model.resources===7,report.model);
  await run(`document.querySelector('[data-view="text"]').click();const root=byId('text-tree').firstElementChild;root.open=true;root.dispatchEvent(new Event('toggle'));`);
  check('snapshot-tree-lazy-detail',await run(`byId('text-tree').querySelector('.reading-body').childElementCount>0`));
  await run(`document.querySelector('[data-view="flow"]').click();const candidate=Object.entries(summaries).find(([id,s])=>s.members.some(n=>flows[flowRoot].nodes?.[n]));if(candidate){const [id,s]=candidate;expandedGroups.delete(id);render();const member=s.members.find(n=>flows[flowRoot].nodes?.[n]);openFunction(flows[flowRoot].nodes[member].function);window.__testedGroup=id;}`);
  check('snapshot-group-locate-and-frame',await run(`!window.__testedGroup||expandedGroups.has(window.__testedGroup)&&[...byId('graph').querySelectorAll('.group-frame')].every(n=>parseFloat(n.style.width)>0&&parseFloat(n.style.height)>0)`));
  // Preserve the existing Host-owned simulator and immutable ledger in the
  // real-source mode, in addition to the canonical specimen's browser Wasm.
  for(let i=0;i<60;i++){if(await run(`Boolean(window.__hostProfiles?.length)`))break;await sleep(150);}
  check('snapshot-host-profile',await run(`Boolean(window.__hostProfiles?.length)`));
  await run(`document.querySelector('[data-view="flow"]').click();document.querySelector('[data-side="simulation"]').click();byId('interface').value=Object.keys(functions).find(k=>functions[k].name==='bus_register');renderFields();byId('arg-channel').value=1;byId('scenario').requestSubmit();`);
  for(let i=0;i<100;i++){if(await run(`!byId('scenario').inert&&byId('history').textContent.includes('bus_register(1)')`))break;await sleep(150);}
  check('snapshot-host-execution',await run(`byId('history').textContent.includes('bus_register(1)')`),await run(`byId('simulation').innerText.slice(0,600)`));
  await run(`byId('interface').value=Object.keys(functions).find(k=>functions[k].name==='bus_send');renderFields();byId('arg-channel').value=1;byId('arg-length').value=48;byId('scenario').requestSubmit();`);
  for(let i=0;i<100;i++){if(await run(`!byId('scenario').inert&&byId('history').textContent.includes('bus_send(1, 48)')`))break;await sleep(150);}
  check('snapshot-host-send-and-ledger',await run(`byId('history').textContent.includes('bus_send(1, 48)')&&byId('history').textContent.includes('131120')`),await run(`byId('simulation').innerText.slice(0,900)`));
  const lastScenario=await run(`window.__hostScenario`);
  await evaluate(`document.querySelector('button[aria-label="关闭"]')?.click()`);await sleep(100);
  await evaluate(`document.querySelector('button[aria-label="打开右侧边栏"]')?.click();document.querySelector('button[aria-label="新标签页"]')?.click();`);await sleep(150);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.startsWith('代码工作台'));b?.click();})()`);await sleep(500);
  frame=win.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
  for(let i=0;i<80;i++){if(await run(`byId('history').textContent.includes('bus_send(1, 48)')`))break;await sleep(150);}
  check('completed-host-run-restored-after-direct-close',await run(`window.__hostScenario===${JSON.stringify(lastScenario)}&&byId('history').textContent.includes('bus_send(1, 48)')`));
  await run(`byId('undo-count').value=1;byId('undo').click()`);
  for(let i=0;i<100;i++){if(await run(`byId('simulation').innerText.includes('Host 已校验前缀重放状态')`))break;await sleep(150);}
  check('snapshot-host-undo-tail',await run(`history.length===1&&byId('simulation').innerText.includes('Host 已校验前缀重放状态')`),await run(`byId('simulation').innerText.slice(0,900)`));
  await run(`byId('simulation').querySelector('input[aria-label="观测轨迹文件名"]').value='trace-bus-send.json';[...byId('simulation').querySelectorAll('button')].find(b=>b.textContent==='导入观测').click();`);
  for(let i=0;i<100;i++){if(await run(`byId('simulation').innerText.includes('已导入观测')`))break;await sleep(150);}
  check('snapshot-import-observed-sequence',await run(`byId('simulation').innerText.includes('已导入观测')&&byId('sequence-chart').querySelector('svg')&&byId('undo').disabled`),await run(`byId('simulation').innerText.slice(0,900)`));
  await run(`[...byId('simulation').querySelectorAll('button')].find(b=>b.textContent==='新建执行场景').click();document.querySelector('[data-view="sequence"]').click();
    const assign=(index,name,args)=>{const key=Object.keys(functions).find(k=>functions[k].name===name);let row=byId('sequence-steps').children[index];row.querySelector('select').value=key;row.querySelector('select').dispatchEvent(new Event('change'));row=byId('sequence-steps').children[index];[...row.querySelectorAll('input')].forEach((input,i)=>{input.value=args[i];input.dispatchEvent(new Event('input'));});};
    assign(0,'bus_register',[1]);assign(1,'bus_send',[1,48]);byId('sequence-form').requestSubmit();`);
  for(let i=0;i<100;i++){if(await run(`byId('sequence-status').textContent.includes('Host 台账观测')`))break;await sleep(150);}
  check('snapshot-ordered-interfaces-generate-observed-sequence',await run(`history.length===2&&byId('sequence-status').textContent.includes('Host 台账观测')`),await run(`byId('sequence-status').textContent`));
  check('no-renderer-errors',!report.console.some(l=>l.level>=3),report.console.filter(l=>l.level>=3));
  report.ok=true;
 } catch(e){report.error=e.stack;}
 finally {report.finished_at_utc=new Date().toISOString();report.duration_ms=Date.parse(report.finished_at_utc)-Date.parse(report.started_at_utc);writeFileSync(join(out,'probe.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);}
}).catch(e=>{writeFileSync(join(out,'probe.json'),JSON.stringify({error:e.stack}));app.exit(1);});
