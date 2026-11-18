import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { bailianTranscribe, bailianTranscript, bailianConfig } from '../src/asr-bailian.ts'
let directory:string
const model='qwen-audio-3.1-asr-flash-filetrans'
const document={properties:{original_duration_in_milliseconds:10000},transcripts:[{sentences:[{begin_time:0,end_time:5000,text:'本周先完成原型验证。',speaker_id:0},{begin_time:5000,end_time:10000,text:'周五完成测试。',speaker_id:1}]}]}
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'loom-asr-'));const file=join(directory,'key');writeFileSync(file,'fixture-only-api-key',{mode:0o600});vi.stubEnv('LOOM_ASR_API_KEY_FILE',file);vi.stubEnv('LOOM_ASR_MODEL',model);vi.stubEnv('LOOM_ASR_ENDPOINT','https://dashscope.aliyuncs.com/api/v1')})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(directory,{recursive:true,force:true})})
it('preserves timestamps and anonymous speaker labels without inventing people',()=>{
 expect(bailianTranscript(document,model)).toMatchObject({duration:10,segments:[{start:0,end:5,speaker:'说话人1'},{start:5,end:10,speaker:'说话人2'}]})
 expect(()=>bailianTranscript({...document,properties:{original_duration_in_milliseconds:8000000}},model)).toThrow('范围')
})
it('resumes an accepted task without uploading again and does not send the API key to result storage',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({output:{task_status:'SUCCEEDED',results:[{subtask_status:'SUCCEEDED',transcription_url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json'}]}})).mockResolvedValueOnce(Response.json(document))
 vi.stubGlobal('fetch',fetcher)
 const checkpoint=vi.fn()
 await bailianTranscribe('/file-not-needed-for-resume',new AbortController().signal,checkpoint,{stage:'polling',model,taskId:'task_fixture_1234',startedAt:new Date().toISOString()})
 expect(fetcher).toHaveBeenCalledTimes(2)
 expect(fetcher.mock.calls[0]![0]).toContain('/tasks/task_fixture_1234')
 expect(fetcher.mock.calls[1]![1].headers).toBeUndefined()
 expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({stage:'succeeded',taskId:'task_fixture_1234'}))
})
it('never silently resubmits a task with an unknown submit outcome',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
 await expect(bailianTranscribe('/unused',new AbortController().signal,vi.fn(),{stage:'unknown',model,startedAt:new Date().toISOString()})).rejects.toThrow('未再次')
 expect(fetcher).not.toHaveBeenCalled()
})
it('refuses redirected or local result destinations and non-vendor credential endpoints',async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({output:{task_status:'SUCCEEDED',results:[{subtask_status:'SUCCEEDED',transcription_url:'http://127.0.0.1/private'}]}}));vi.stubGlobal('fetch',fetcher)
 await expect(bailianTranscribe('/unused',new AbortController().signal,vi.fn(),{stage:'polling',model,taskId:'task_fixture_1234',startedAt:new Date().toISOString()})).rejects.toThrow('允许范围')
 expect(fetcher).toHaveBeenCalledTimes(1)
 vi.stubEnv('LOOM_ASR_ENDPOINT','https://example.com/api/v1')
 expect(()=>bailianConfig()).toThrow('支持范围')
})
