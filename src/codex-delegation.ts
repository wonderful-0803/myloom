/** Bounded, owner-selected local Codex inputs for recurring daily reports; no Codex execution authority. */
import { z } from 'zod'
import { key } from './core/index.ts'

const unique = (values: string[]) => new Set(values).size === values.length
export const CodexDailySchema = z.object({
  projects: z.array(z.string().min(1).max(1000).refine(value => value.startsWith('/') && !value.includes('\0')
    && value.split('/').every(part => part !== '..' && part !== '.') && (value === '/' || !value.endsWith('/')), '请选择绝对项目路径')).max(10).refine(unique),
  sessions: z.array(z.uuid()).max(20).refine(unique),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timezone: z.literal('Asia/Shanghai'),
  delivery: z.enum(['none', 'feishu', 'default']),
}).strict().refine(value => !!value.projects.length !== !!value.sessions.length, '请选择项目范围或具体会话，两种范围只能使用一种')
export type CodexDailyConfig = z.infer<typeof CodexDailySchema>
export const codexScopeKey = (value: CodexDailyConfig): string => key('codex-daily-scope', JSON.stringify({
  projects: [...value.projects].sort(), sessions: [...value.sessions].sort(),
}))
export const shanghaiDate = (at = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(at)
export const codexRunId = (owner: string, delegation: string, date: string): string => key('codex-daily-run', owner, delegation, date)
export const matchesCodexScope = (scope: Pick<CodexDailyConfig, 'projects' | 'sessions'>, session: { id: string; cwd: string }): boolean =>
  scope.sessions.includes(session.id) || scope.projects.includes(session.cwd)
