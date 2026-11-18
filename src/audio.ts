/** Fixed, local speech recognizer. No model-controlled command, URL or filesystem path is accepted. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { packagePath } from './infra/paths.ts'
import { bailianConfig, bailianTranscribe, type BailianJob } from './asr-bailian.ts'

export const AudioTranscriptSchema = z.object({
  engine: z.string().max(100), duration: z.number().positive().max(7200),
  segments: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive(), text: z.string().max(6000), speaker: z.string().max(50).optional() })).max(10000),
}).strict()
export type AudioTranscript = z.infer<typeof AudioTranscriptSchema>
export const AUDIO_MAX_BYTES = 80 * 1024 * 1024
export function asrInfo() {
  if (process.env.LOOM_ASR_PROVIDER && !['local','bailian'].includes(process.env.LOOM_ASR_PROVIDER)) throw new Error('转写服务类型无效。')
  return process.env.LOOM_ASR_PROVIDER === 'local' ? { provider: 'local' as const, model: 'SenseVoice-int8', description: '在本机转写录音' }
    : { provider: 'bailian' as const, model: bailianConfig().model, description: '将录音提交百炼云端转写' }
}
export function asrReady(): boolean {
  if (asrInfo().provider === 'local') return localAsrReady()
  const file = bailianConfig().keyFile
  return isAbsolute(file) && existsSync(file)
}
export async function transcribeAudio(file: string, signal: AbortSignal, progress: (seconds:number)=>void, checkpoint:(job:BailianJob)=>void|Promise<void>, previous?:BailianJob) {
  return asrInfo().provider === 'local' ? localTranscribe(file,signal,progress) : AudioTranscriptSchema.parse(await bailianTranscribe(file,signal,checkpoint,previous))
}
export function localAsrReady(): boolean {
  const python = process.env.LOOM_ASR_PYTHON, model = process.env.LOOM_ASR_MODEL_DIR
  return !!python && isAbsolute(python) && existsSync(python) && !!model && isAbsolute(model)
    && ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'].every(file => existsSync(`${model}/${file}`))
}
/** The process group includes ffmpeg; aborting a task also stops the decoder. */
export async function localTranscribe(file: string, signal: AbortSignal, progress: (seconds: number) => void): Promise<AudioTranscript> {
  if (!localAsrReady()) throw new Error('本机录音转写尚未配置。')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.LOOM_ASR_PYTHON!, [packagePath('skills', 'dsh-superagent-office', 'transcribe.py'),
      '--input', file, '--model-dir', process.env.LOOM_ASR_MODEL_DIR!], { detached: process.platform !== 'win32', windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let pending = '', size = 0, result: AudioTranscript | undefined, failed = false
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch {} }
    const abort = () => { failed = true; kill() }
    const timer = setTimeout(abort, 30 * 60_000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stderr.on('data', () => {}) // Decoder and native-model diagnostics are not transcript data or user-facing logs.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part: string) => {
      size += Buffer.byteLength(part)
      if (size > 2_000_000) { abort(); return }
      pending += part
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        try {
          const event = JSON.parse(line)
          if (event.type === 'progress' && Number.isFinite(event.seconds)) progress(event.seconds)
          else if (event.type === 'result') result = AudioTranscriptSchema.parse(event.result)
        } catch { abort() }
      }
    })
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    child.on('error', () => { cleanup(); reject(new Error('本地转写进程无法启动，请检查转写组件。')) })
    child.on('close', code => {
      cleanup()
      if (failed || signal.aborted || code !== 0 || !result) reject(new Error(signal.aborted ? '录音转写已停止。' : '转写失败、超出时长预算或文件不是可解码的音频；未生成纪要。'))
      else resolve(result)
    })
  })
}
