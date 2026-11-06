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
const cloudStatus={connected:false,mappings:[],running:false,account:{state:'signed-out',name:'',missing:[],message:'请先完成飞书用户授权。'}}
async function openSelfHosted() {
  await act(async()=>root.render(<DeviceSync/>))
  await act(async()=>button('展开自建同步').click())
}
it('defaults to Feishu account authorization without loading or changing self-hosted sync',async()=>{
  vi.mocked(api).mockResolvedValue(cloudStatus)
  await act(async()=>root.render(<DeviceSync/>))
  expect(host.textContent).toContain('飞书同步')
  expect(host.textContent).toContain('默认方案')
  expect(host.textContent).toContain('请先完成飞书用户授权')
  expect(host.textContent).toContain('自建同步 · 待验证')
  expect(button('登录飞书并授权同步').disabled).toBe(false)
  expect(button('连接飞书').disabled).toBe(true)
  expect(button('展开自建同步').getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('input[type="password"]')).toBeNull()
  expect(vi.mocked(api).mock.calls.every(c=>c[0]==='/sync/feishu'&&(c[1]===undefined||c[1]==='GET'))).toBe(true)
})
it('keeps self-hosted pairing behind advanced settings without source reads, uploads or stored secret disclosure',async()=>{
  vi.mocked(api).mockResolvedValue({connected:false,mappings:[],running:false})
  await openSelfHosted()
  expect(button('收起自建同步').getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('自建同步（待验证）')
  expect(host.textContent).toContain('连接你的同步空间')
  expect([...host.querySelectorAll('input[type="password"]')]).toHaveLength(1)
  expect(button('连接空间').disabled).toBe(true)
  expect(vi.mocked(api).mock.calls.every(c=>['/sync','/sync/feishu'].includes(c[0])&&(c[1]===undefined||c[1]==='GET'))).toBe(true)
})
it('keeps project collection behind explicit consent and AI access as a separate action',async()=>{
  const id='11111111-1111-4111-8111-111111111111'
  const status={connected:true,mappings:[],running:false,device:{id:'local',name:'公司电脑',admin:false},enabled:false,revision:1,readProjects:[],space:'private',url:'https://sync.example'}
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/sync/feishu')return cloudStatus as any
    if(path==='/sync')return status as any
    if(path==='/sync/projects')return {projects:[{id,name:'退款方案'}]} as any
    if(path==='/sync/devices')return {devices:[]} as any
    if(path===`/sync/projects/${id}`)return {project:{id,name:'退款方案'},sessions:[],notes:[]} as any
    throw Error('unexpected API '+path)
  })
  await openSelfHosted()
  const select=host.querySelector('select')!
  await act(async()=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(button('保存本机采集授权').disabled).toBe(true)
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  expect(button('查看接续上下文').disabled).toBe(true)
  expect(button('允许本机 AI 读取此项目')).toBeTruthy()
  expect(vi.mocked(api).mock.calls.some(c=>c[1]&&c[1]!=='GET')).toBe(false)
  expect(host.textContent).not.toContain('为此项目添加另一台设备')
  await act(async()=>button('收起自建同步').click())
  expect(host.textContent).toContain('默认方案')
  expect(host.textContent).not.toContain('项目与本机授权')
  expect(vi.mocked(api).mock.calls.some(c=>c[1]&&c[1]!=='GET')).toBe(false)
})

it('shows an empty scan separately from a server-confirmed upload',async()=>{
  const id='11111111-1111-4111-8111-111111111111'
  const status={connected:true,running:false,device:{id:'local',name:'Linux',admin:false},enabled:true,revision:2,readProjects:[],space:'private',url:'http://127.0.0.1:7421',
    mappings:[{project:id,cwd:'/chosen',enabled:true,revision:1,lastChecked:'2026-11-06T01:00:00Z',lastRun:{sessions:0,messages:0},warnings:['未找到此精确路径对应的 Codex 会话，本轮没有上传记录。']}]}
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/sync/feishu')return cloudStatus as any
    if(path==='/sync')return status as any
    if(path==='/sync/projects')return {projects:[{id,name:'测试项目'}]} as any
    if(path==='/sync/devices')return {devices:[]} as any
    if(path===`/sync/projects/${id}`)return {project:{id,name:'测试项目'},sessions:[],notes:[]} as any
    throw Error('unexpected API '+path)
  })
  await openSelfHosted()
  const select=host.querySelector('select')!
  await act(async()=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(host.textContent).toContain('尚无成功上传回执')
  expect(host.textContent).toContain('本轮确认 0 个会话、0 条文字')
  expect(host.textContent).toContain('本轮没有上传记录')
  expect(host.textContent).not.toContain('最近一次服务端确认')
})

it('shows the real authorization QR and requires directory consent before connecting Feishu',async()=>{
  let state:any=cloudStatus
  vi.mocked(api).mockImplementation(async(path,method,body)=>{
    if(path==='/sync/feishu')return state
    if(path==='/sync/feishu/auth/start')return {url:'https://accounts.feishu.cn/test',qr:'data:image/png;base64,aGVsbG8=',expires:Date.now()+300000} as any
    if(path==='/sync/feishu/auth/finish'){state={...cloudStatus,account:{state:'ready',name:'本人',missing:[],message:''}};return state}
    if(path==='/sync/feishu/connect'){expect(body).toEqual({deviceName:'Linux-A',consent:true});state={...state,connected:true,enabled:false,revision:1,device:{id:'local',name:'Linux-A',admin:true},space:'private'};return state}
    if(path==='/sync/feishu/projects')return {projects:[]} as any
    if(path==='/sync/feishu/devices')return {devices:[]} as any
    throw Error('unexpected API '+path+' '+method)
  })
  await act(async()=>root.render(<DeviceSync/>))
  await act(async()=>button('登录飞书并授权同步').click())
  expect(host.querySelector('img')?.getAttribute('alt')).toBe('飞书同步授权二维码')
  expect(host.querySelector('a')?.href).toBe('https://accounts.feishu.cn/test')
  await act(async()=>button('我已完成授权').click())
  expect(host.querySelector('img')).toBeNull()
  const input=host.querySelector<HTMLInputElement>('input[type="text"]')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Linux-A');input.dispatchEvent(new Event('input',{bubbles:true}))})
  expect(button('连接飞书').disabled).toBe(true)
  await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(button('连接飞书').disabled).toBe(false)
  await act(async()=>button('连接飞书').click())
  expect(host.textContent).toContain('自动同步暂停')
  expect(vi.mocked(api).mock.calls.some(c=>c[0].endsWith('/mapping')||c[0].endsWith('/run'))).toBe(false)
})

it('shows actionable login failures, removes a stale QR, and allows generating a new one',async()=>{
  let fail=false
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/sync/feishu')return {...cloudStatus,account:{...cloudStatus.account,state:'configuration-required',message:'用于同步的飞书应用尚未配置。'}} as any
    if(path==='/sync/feishu/auth/start'){
      if(fail)throw Error('用于同步的飞书应用尚未配置。')
      return {url:'https://accounts.feishu.cn/test',qr:'data:image/png;base64,aGVsbG8=',expires:Date.now()+300000} as any
    }
    throw Error('unexpected API '+path)
  })
  await act(async()=>root.render(<DeviceSync/>))
  expect(host.textContent).toContain('用于同步的飞书应用尚未配置')
  await act(async()=>button('登录飞书并授权同步').click())
  expect(host.querySelector('img')).not.toBeNull()
  fail=true;await act(async()=>button('重新生成授权二维码').click())
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).toContain('用于同步的飞书应用尚未配置')
  expect(button('登录飞书并授权同步').disabled).toBe(false)
  fail=false;await act(async()=>button('登录飞书并授权同步').click())
  expect(host.querySelector('img')).not.toBeNull()
})
