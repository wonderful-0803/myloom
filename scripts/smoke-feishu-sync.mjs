/** Compiled Feishu adapter + two local stores + actual read-only MCP child. Drive/Codex are synthetic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FeishuSync, SyncDatabase } from '../lib/sync-core.js';
const directory=mkdtempSync(join(tmpdir(),'loom-feishu-mcp-')),files=new Map(),data=[],controllers=[];
let child,server,clock=0;
const owner='ou_owner',appId='cli_smoke',native='11111111-1111-4111-8111-111111111111';
const drive={
  identity:async()=>({appId,owner,name:'Owner',missing:[]}),
  list:async parent=>[...files.values()].filter(f=>f.parent===parent).map(({text,...file})=>file),
  folder:async(parent,name)=>{const token=randomUUID();files.set(token,{token,parent,name,type:'folder',owner_id:owner,modified_time:String(++clock)});return token;},
  upload:async(parent,name,text)=>{const token=randomUUID();files.set(token,{token,parent,name,text,type:'file',owner_id:owner,modified_time:String(++clock)});return token;},
  download:async token=>files.get(token).text,
  removeFolder:async()=>{throw Error('Smoke must not delete cloud data.');},
};
const read=async(_signal,run)=>run({call:async method=>{
  if(method==='thread/list')return {data:[{id:native,name:'Plan discussion',cwd:'/fixture',source:'cli'}],nextCursor:null};
  if(method==='thread/read')return {thread:{id:native,cwd:'/fixture',source:'cli'}};
  return {data:[{item:{id:'m1',type:'userMessage',content:[{type:'text',text:'方案A：成功回调幂等。'}]},turnId:'t1',startedAtMs:1000}],nextCursor:null};
}});
function local(label,capture){const db=new SyncDatabase(join(directory,label+'.sqlite')),controller=new AbortController();data.push(db);controllers.push(controller);return {controller,sync:new FeishuSync(db,drive,{owner:()=>owner,appId:()=>appId,paused:()=>false,lifetime:controller.signal,read:capture})};}
const call=(s,method,path,body)=>s.handle(owner,method,path,body);
try {
  const home=local('home',read),office=local('office',async()=>{throw Error('Read-only recall must not invoke local Codex.');});
  await call(home.sync,'POST',['connect'],{deviceName:'Home',consent:true});
  const project=await call(home.sync,'POST',['projects'],{name:'退款设计'});
  await call(home.sync,'PUT',['projects',project.id,'mapping'],{cwd:'/fixture',enabled:true,consent:true,revision:0});
  await call(home.sync,'PUT',['connection'],{enabled:true,revision:1});await home.sync.connector.run(owner);
  await call(office.sync,'POST',['connect'],{deviceName:'Office',consent:true});home.controller.abort();
  server=createServer(async(req,res)=>{
    try {
      assert.equal(req.method,'GET');assert.equal(req.headers['x-orchestrator-request'],'1');
      const prefix='/orchestrator/api/loom/sync/feishu';assert.ok(req.url.startsWith(prefix));
      const value=await call(office.sync,'GET',req.url.slice(prefix.length).split('/').filter(Boolean));
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
    }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:'Unavailable'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  child=spawn(process.execPath,[resolve('lib/sync-mcp.js')],{stdio:['pipe','pipe','pipe'],env:{...process.env,LOOM_SYNC_LOCAL_URL:`http://127.0.0.1:${server.address().port}/orchestrator/api/loom/sync/feishu`}});
  let seq=0;const pending=new Map();child.stderr.resume();
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line),p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('MCP timed out')),15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'feishu-smoke',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list',{});assert.equal(tools.tools.length,4);assert.ok(tools.tools.every(t=>t.annotations.readOnlyHint));
  const denied=await rpc('tools/call',{name:'loom_get_context',arguments:{projectId:project.id}});assert.equal(denied.isError,true);
  await call(office.sync,'PUT',['projects',project.id,'ai'],{enabled:true,consent:true});
  const note=await call(office.sync,'POST',['projects',project.id,'notes'],{title:'方案B',current:'成功幂等，失败重试',reasons:'失败请求仍需恢复',constraints:'退款不超过实付',open:'',parent:null,references:[]});
  const listing=await rpc('tools/call',{name:'loom_list_projects',arguments:{}});assert.ok(listing.content[0].text.includes(project.id));
  const context=await rpc('tools/call',{name:'loom_get_context',arguments:{projectId:project.id}});assert.ok(!context.isError);assert.ok(context.content[0].text.includes('方案A'));assert.ok(context.content[0].text.includes('失败请求仍需恢复'));
  const record=await rpc('tools/call',{name:'loom_read_note',arguments:{projectId:project.id,noteId:note.id}});assert.ok(record.content[0].text.includes('退款不超过实付'));
  const view=await call(office.sync,'GET',['projects',project.id]),session=view.sessions[0];
  const raw=await rpc('tools/call',{name:'loom_read_session',arguments:{projectId:project.id,deviceId:session.device,sessionId:session.session,offset:0,limit:20}});assert.ok(raw.content[0].text.includes('成功回调幂等'));
  await call(office.sync,'PUT',['projects',project.id,'ai'],{enabled:false,consent:true});
  assert.equal((await rpc('tools/call',{name:'loom_get_context',arguments:{projectId:project.id}})).isError,true);
  child.stdin.end();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP did not exit')),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  console.log('PASS: compiled Feishu storage adapter, offline source, four real MCP tools, plan reasons and independent AI revocation. Drive/Codex use synthetic data; no live account or model calls.');
} finally {
  child?.kill();controllers.forEach(c=>c.abort());
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  data.forEach(d=>d.close());
  if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'loom-feishu-mcp-'))throw Error('Unsafe cleanup');
  rmSync(directory,{recursive:true,force:true});
}
