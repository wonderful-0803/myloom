/** Built-artifact smoke: real hub + two connectors + the actual MCP child. No user sessions/model accounts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SyncDatabase, SyncHub, syncServer, DeviceSync } from '../lib/sync-core.js';
const dir=mkdtempSync(join(tmpdir(),'loom-sync-smoke-')),bootstrap='isolated-smoke-bootstrap-01234567890123456789';
const data=[],controllers=[],servers=[];
let child;
async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
function store(name){const db=new SyncDatabase(join(dir,name+'.sqlite'));data.push(db);return db;}
function connector(name,read){const controller=new AbortController();controllers.push(controller);return {controller,client:new DeviceSync(store(name),{owner:()=> 'owner',paused:()=>false,lifetime:controller.signal,read})};}
try {
  const address=await listen(syncServer(new SyncHub(store('hub'),bootstrap)));
  const nativeId='11111111-1111-4111-8111-111111111111';
  const home=connector('home',async(_signal,run)=>run({call:async(method,params)=>{
    if(method==='thread/list')return {data:params.archived?[]:[{id:nativeId,cwd:'/project',source:'cli',name:'退款方案'}],nextCursor:null};
    if(method==='thread/read')return {thread:{id:nativeId,cwd:'/project',source:'cli',name:'退款方案'}};
    return {data:[{item:{id:'m1',type:'userMessage',content:[{type:'text',text:'方案A：成功回调只处理一次。'}]},turnId:'t1',startedAtMs:Date.now()}],nextCursor:null};
  }}));
  await home.client.handle('owner','POST',['connect'],{url:address,mode:'create',name:'Smoke',deviceName:'Home',bootstrap});
  const p=await home.client.handle('owner','POST',['projects'],{name:'退款方案'});
  await home.client.handle('owner','PUT',['projects',p.id,'mapping'],{cwd:'/project',enabled:true,consent:true,revision:0});
  await home.client.handle('owner','PUT',['connection'],{enabled:true,revision:1});await home.client.run('owner');
  const plan=await home.client.handle('owner','POST',['projects',p.id,'notes'],{title:'A',current:'成功幂等',reasons:'避免重复生效',constraints:'实付退款',open:'失败处理待补',parent:null,references:[]});
  const invite=await home.client.handle('owner','POST',['invitations'],{projects:[p.id]});
  const office=connector('office',async()=>{throw Error('MCP must not invoke native Codex');});
  await office.client.handle('owner','POST',['connect'],{url:address,mode:'join',deviceName:'Office',invitation:invite.invitation});
  home.controller.abort(); // the originating machine is no longer available
  const local=await listen(createServer(async(req,res)=>{
    try {
      assert.equal(req.headers['x-orchestrator-request'],'1');assert.equal(req.method,'GET');
      const path=req.url.slice('/orchestrator/api/loom/sync'.length).split('/').filter(Boolean);
      const result=await office.client.handle('owner','GET',path);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:'not authorized'}));}
  }));
  child=spawn(process.execPath,[resolve('lib/sync-mcp.js')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,LOOM_SYNC_LOCAL_URL:local+'/orchestrator/api/loom/sync'}});
  let seq=0;const pending=new Map();let diagnostics='';
  child.stderr.on('data',s=>{diagnostics+=s.toString();});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const message=JSON.parse(line),p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('MCP request timed out: '+method)),15_000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'loom-smoke',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list',{});assert.equal(tools.tools.length,4);assert.ok(tools.tools.every(t=>t.annotations.readOnlyHint));
  const denied=await rpc('tools/call',{name:'loom_get_context',arguments:{projectId:p.id}});assert.equal(denied.isError,true);
  await office.client.handle('owner','PUT',['projects',p.id,'ai'],{enabled:true,consent:true});
  await office.client.handle('owner','POST',['projects',p.id,'notes'],{title:'B',current:'成功幂等，失败重试',reasons:'失败请求仍要能恢复',constraints:'实付退款',open:'',parent:plan.id,references:[]});
  const listing=await rpc('tools/call',{name:'loom_list_projects',arguments:{}});assert.ok(listing.content[0].text.includes(p.id));
  const context=await rpc('tools/call',{name:'loom_get_context',arguments:{projectId:p.id}});assert.ok(context.content[0].text.includes('失败请求仍要能恢复'));assert.ok(context.content[0].text.includes('方案A'));
  await office.client.handle('owner','PUT',['projects',p.id,'ai'],{enabled:false,consent:true});
  const withdrawn=await rpc('tools/call',{name:'loom_get_context',arguments:{projectId:p.id}});assert.equal(withdrawn.isError,true);
  assert.ok(!diagnostics.includes(bootstrap));
  console.log('PASS: built MCP, source offline, A/B provenance, independent AI grant and revocation; no real history or model calls.');
  child.stdin.end();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP did not exit')),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
} finally {
  child?.kill();controllers.forEach(c=>c.abort());
  for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(()=>r()));}
  data.forEach(db=>db.close());
  if(!resolve(dir).startsWith(resolve(tmpdir())+sep+'loom-sync-smoke-'))throw Error('unsafe cleanup');
  rmSync(dir,{recursive:true,force:true});
}
