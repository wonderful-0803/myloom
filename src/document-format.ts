/** Public metadata and bounded inputs for host-generated task documents. No server paths or executable input. */
import { z } from 'zod'

export const DocumentOutputSchema = z.object({
  format: z.literal('docx'),
  filename: z.string().trim().min(6).max(100).refine(value => /^[\p{L}\p{N}][\p{L}\p{N} _().-]*\.docx$/iu.test(value), '请使用不含路径的 .docx 文件名').default('result.docx'),
}).strict()
export interface ArtifactFile {
  format: 'docx'; filename: string; mediaType: string; sha256: string; byteLength: number
}
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
