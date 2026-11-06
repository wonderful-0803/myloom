import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FeishuDrive } from '../src/sync/feishu-drive.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
let h:Host
beforeEach(async()=>{h=await startRuntime(undefined,{github:false});const s=h.runtime.store.settings();h.runtime.store.saveSettings({...s,sources:{...s.sources,feishu:{...s.sources.feishu!,config:{...s.sources.feishu!.config,ownerOnly:true}}}})})
afterEach(async()=>{await h.stop();vi.restoreAllMocks()})
it('exposes disabled device setup and loopback MCP configuration through the existing owner adapter',async()=>{
  expect(await h.api('GET','loom/sync')).toMatchObject({status:200,body:{connected:false,mappings:[]}})
  expect(await h.api('GET','loom/sync/mcp-config')).toMatchObject({status:200,body:{config:expect.stringContaining('[mcp_servers.loom_context]')}})
  expect(await h.api('POST','loom/sync/connect',{url:'http://example.com',mode:'join',deviceName:'x',invitation:'x'.repeat(43)})).toMatchObject({status:400})
  expect(await h.api('POST','loom/sync/connect',{url:'http://localhost:1',mode:'join',deviceName:'x',invitation:'x'.repeat(43),owner:'someone-else'})).toMatchObject({status:400})
  expect(await h.api('POST','loom/sync/run',{})).toMatchObject({status:409})
  expect(await h.api('POST','loom/sync/execute',{command:'whoami'})).toMatchObject({status:404})
})

it('routes Feishu setup independently, keeps device codes private, and generates the cloud MCP endpoint',async()=>{
  vi.spyOn(FeishuDrive.prototype,'identity').mockResolvedValue({appId:'cli_bot',owner:'ou_alice',name:'Alice',missing:[]})
  vi.spyOn(FeishuDrive.prototype,'application').mockResolvedValue('cli_bot')
  vi.spyOn(FeishuDrive.prototype,'begin').mockResolvedValue({device:'private-device-code',url:'https://accounts.feishu.cn/test',qr:'data:image/png;base64,AA==',expires:Date.now()+300000})
  expect(await h.api('GET','loom/sync/feishu')).toMatchObject({status:200,body:{connected:false,account:{state:'ready'},mappings:[]}})
  const config=await h.api('GET','loom/sync/feishu/mcp-config')
  expect(config).toMatchObject({status:200,body:{config:expect.stringContaining('/orchestrator/api/loom/sync/feishu')}})
  const started=await h.api('POST','loom/sync/feishu/auth/start',{})
  expect(started).toMatchObject({status:200,body:{url:'https://accounts.feishu.cn/test'}})
  expect(JSON.stringify(started)).not.toContain('private-device-code')
  expect(await h.api('POST','loom/sync/feishu/auth/start',{owner:'ou_other'})).toMatchObject({status:400})
  expect(await h.api('POST','loom/sync/feishu/connect',{deviceName:'A'})).toMatchObject({status:400})
  expect(await h.api('POST','loom/sync/feishu/execute',{command:'whoami'})).toMatchObject({status:404})
  expect(await h.api('GET','loom/sync')).toMatchObject({status:200,body:{connected:false}})
  expect(await h.api('GET','loom/sync/feishu',undefined,{'x-forwarded-for':'203.0.113.10'})).toMatchObject({status:403})
})
