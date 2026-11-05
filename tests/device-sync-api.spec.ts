import { afterEach, beforeEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
let h:Host
beforeEach(async()=>{h=await startRuntime(undefined,{github:false});const s=h.runtime.store.settings();h.runtime.store.saveSettings({...s,sources:{...s.sources,feishu:{...s.sources.feishu!,config:{...s.sources.feishu!.config,ownerOnly:true}}}})})
afterEach(async()=>{await h.stop()})
it('exposes disabled device setup and loopback MCP configuration through the existing owner adapter',async()=>{
  expect(await h.api('GET','loom/sync')).toMatchObject({status:200,body:{connected:false,mappings:[]}})
  expect(await h.api('GET','loom/sync/mcp-config')).toMatchObject({status:200,body:{config:expect.stringContaining('[mcp_servers.loom_context]')}})
  expect(await h.api('POST','loom/sync/connect',{url:'http://example.com',mode:'join',deviceName:'x',invitation:'x'.repeat(43)})).toMatchObject({status:400})
  expect(await h.api('POST','loom/sync/connect',{url:'http://localhost:1',mode:'join',deviceName:'x',invitation:'x'.repeat(43),owner:'someone-else'})).toMatchObject({status:400})
  expect(await h.api('POST','loom/sync/run',{})).toMatchObject({status:409})
  expect(await h.api('POST','loom/sync/execute',{command:'whoami'})).toMatchObject({status:404})
})
