/** Browser-safe recording delegation policy. Saving this authorizes asking, not immediate transcription. */
import { z } from 'zod'
export const MeetingDelegationSchema = z.object({ audio: z.literal('confirm'), provider: z.enum(['bailian', 'local']).default('bailian') }).strict()
