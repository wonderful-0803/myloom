// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Delegations } from './Delegations'
import { WorkspaceContext, type Workspace } from './context'
import { api } from './api'
vi.mock('./api', async original=>({...await original<typeof import('./api')>(),api:vi.fn()}))
let host:HTMLDivElement,root:Root
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.mocked(api).mockReset()})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
const button=(text:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent===text)!
async function render(){
 const value={data:{workspace:{mode:'group'},policyRevision:4,mode:'auto',paused:false,automation:{maxWorkers:2},rules:[],delegations:[],recordings:{available:true,items:[]},
  connection:{chats:[{chatId:'oc_team',name:'工作群',listen:'all'}]}},locked:false,refresh:vi.fn(),notify:vi.fn(),run:vi.fn(),go:vi.fn(),openTask:vi.fn()} as unknown as Workspace
 await act(async()=>root.render(<WorkspaceContext.Provider value={value}><Delegations/></WorkspaceContext.Provider>))
 await act(async()=>button('新建委托').click())
 await act(async()=>button('录音会议纪要').click())
}
it('requires recording-specific consent and saves the exact scope rather than silently enabling arbitrary files',async()=>{
 await render()
 expect(button('保存委托').disabled).toBe(true)
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('主人回复“需要”才创建任务并转写')
 const consent=document.querySelector<HTMLInputElement>('.is-consent input')!
 await act(async()=>consent.click())
 expect(button('保存委托').disabled).toBe(false)
 vi.mocked(api).mockResolvedValue({})
 await act(async()=>button('保存委托').click())
 expect(api).toHaveBeenCalledWith('/delegations','POST',expect.objectContaining({meeting:{audio:'confirm',provider:'bailian'},meetingConsent:true,chatIds:['oc_team'],keywords:[],mode:'auto'}))
})
it('drops recording authority when switching back to an ordinary message delegation',async()=>{
 await render()
 await act(async()=>document.querySelector<HTMLInputElement>('.is-consent input')!.click())
 await act(async()=>button('飞书群消息').click())
 expect(document.querySelector('.is-consent')).toBeNull()
 vi.mocked(api).mockResolvedValue({})
 await act(async()=>button('保存委托').click())
 const body=vi.mocked(api).mock.calls[0]?.[2] as Record<string,unknown>
 expect(body.meeting).toBeUndefined();expect(body.meetingConsent).toBeUndefined()
})
