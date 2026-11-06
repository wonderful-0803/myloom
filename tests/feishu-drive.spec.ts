/** Exercises the actual CLI adapter's envelopes, identity separation and relative private file transfers. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FeishuDrive, feishuSyncScopes, type CliRunner } from '../src/sync/feishu-drive.ts'
let directory:string
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'loom-drive-adapter-'))})
afterEach(()=>{vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true})})
it('checks the verified user identity and reports only the required missing scopes',async()=>{
  const runner=vi.fn<CliRunner>().mockResolvedValue({appId:'cli_test',identities:{user:{verified:true,openId:'ou_owner',userName:'本人',scope:feishuSyncScopes.filter(s=>s!=='space:document:retrieve').join(' ')}}})
  const drive=new FeishuDrive(directory,undefined,runner)
  expect(await drive.identity(new AbortController().signal)).toEqual({appId:'cli_test',owner:'ou_owner',name:'本人',missing:['space:document:retrieve']})
  expect(runner.mock.calls[0]![0]).toEqual(['auth','status','--verify','--json'])
})
it('uses user identity, private relative files, and removes transfer contents after upload/download',async()=>{
  const runner=vi.fn<CliRunner>().mockImplementation(async(args,cwd)=>{
    expect(args.slice(-4)).toEqual(['--as','user','--format','json'])
    if(args[1]==='+upload'){
      expect(args).toContain('payload.json');expect(args).not.toContain('--file-token')
      expect(statSync(join(cwd!,'payload.json')).mode&0o777).toBe(0o600)
      expect(readFileSync(join(cwd!,'payload.json'),'utf8')).toBe('{"text":"测试"}')
      return {ok:true,identity:'user',data:{file_token:'file1'}}
    }
    writeFileSync(join(cwd!,'payload.json'),'{"text":"测试"}',{mode:0o600})
    return {ok:true,identity:'user',data:{}}
  })
  const drive=new FeishuDrive(directory,undefined,runner),signal=new AbortController().signal
  expect(await drive.upload('folder1','batch.json','{"text":"测试"}',signal)).toBe('file1')
  expect(await drive.download('file1',signal)).toBe('{"text":"测试"}')
  expect(()=>statSync(runner.mock.calls[0]![1]!)).toThrow()
})
it('refuses bot envelopes and incomplete pagination instead of claiming a complete cloud listing',async()=>{
  const runner=vi.fn<CliRunner>().mockResolvedValueOnce({ok:true,identity:'bot',data:{files:[]}}).mockResolvedValue({ok:true,identity:'user',data:{files:[],has_more:true,next_page_token:'same'}})
  const drive=new FeishuDrive(directory,undefined,runner),signal=new AbortController().signal
  await expect(drive.list('folder',signal)).rejects.toMatchObject({status:401})
  await expect(drive.list('folder',signal)).rejects.toMatchObject({status:409})
})
it('rejects a non-Feishu login destination before generating a QR or storing a device code',async()=>{
  const runner=vi.fn<CliRunner>().mockResolvedValue({device_code:'private',verification_url:'https://untrusted.example/login'})
  await expect(new FeishuDrive(directory,undefined,runner).begin(new AbortController().signal)).rejects.toMatchObject({status:502})
  expect(runner).toHaveBeenCalledTimes(1)
})

it.skipIf(process.platform==='win32')('uses the host user CLI environment even while Harness PATH points at a bot shim',async()=>{
  const user=join(directory,'user'),bot=join(directory,'bot'),previous=process.env.PATH
  mkdirSync(user);mkdirSync(bot)
  const write=(path:string,value:unknown)=>writeFileSync(join(path,'lark-cli'),'#!/bin/sh\nprintf \'%s\\n\' \''+JSON.stringify(value)+'\'\n',{mode:0o755})
  write(user,{appId:'cli_test',identities:{user:{verified:true,openId:'ou_owner',userName:'本人',scope:feishuSyncScopes.join(' ')}}})
  write(bot,{appId:'cli_test',identities:{bot:{verified:true}}})
  vi.stubEnv('PATH',bot+':'+previous)
  const drive=new FeishuDrive(join(directory,'state'),undefined,undefined,()=>({PATH:user+':'+previous}))
  expect(await drive.identity(new AbortController().signal)).toMatchObject({owner:'ou_owner',missing:[]})
})
