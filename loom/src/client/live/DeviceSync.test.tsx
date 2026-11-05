// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceSync } from './DeviceSync';
import { api } from './api';
vi.mock('./api',()=>({api:vi.fn(),message:(e:unknown)=>e instanceof Error?e.message:String(e),when:(s:unknown)=>String(s)}))
let host:HTMLDivElement,root:Root
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.mocked(api).mockReset()})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!
it('starts in pairing setup without source reads, uploads or stored secret disclosure',async()=>{
  vi.mocked(api).mockResolvedValue({connected:false,mappings:[],running:false})
  await act(async()=>root.render(<DeviceSync/>))
  expect(host.textContent).toContain('连接你的同步空间')
  expect([...host.querySelectorAll('input[type="password"]')]).toHaveLength(1)
  expect(button('连接空间').disabled).toBe(true)
  expect(vi.mocked(api).mock.calls.every(c=>c[0]==='/sync'&&(c[1]===undefined||c[1]==='GET'))).toBe(true)
})
it('keeps project collection behind explicit consent and AI access as a separate action',async()=>{
  const id='11111111-1111-4111-8111-111111111111'
  const status={connected:true,mappings:[],running:false,device:{id:'local',name:'公司电脑',admin:false},enabled:false,revision:1,readProjects:[],space:'private',url:'https://sync.example'}
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/sync')return status as any
    if(path==='/sync/projects')return {projects:[{id,name:'退款方案'}]} as any
    if(path==='/sync/devices')return {devices:[]} as any
    if(path===`/sync/projects/${id}`)return {project:{id,name:'退款方案'},sessions:[],notes:[]} as any
    throw Error('unexpected API '+path)
  })
  await act(async()=>root.render(<DeviceSync/>))
  const select=host.querySelector('select')!
  await act(async()=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(button('保存本机采集授权').disabled).toBe(true)
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  expect(button('查看接续上下文').disabled).toBe(true)
  expect(button('允许本机 AI 读取此项目')).toBeTruthy()
  expect(vi.mocked(api).mock.calls.some(c=>c[1]&&c[1]!=='GET')).toBe(false)
  expect(host.textContent).not.toContain('为此项目添加另一台设备')
})
