/** Shared process budgets across isolated group runtimes. Stops and delivery never wait for model slots. */
import { setTimeout as delay } from 'node:timers/promises'
import type { CompanyBackend } from './server.ts'
/** A bounded company pilot shares worker/model capacity while preserving each group's persisted queues. */
export class CompanyCapacity {
  private workers = 0
  private assessors = 0
  constructor(private maxWorkers = 2, private maxAssessors = 1) {
    if (![maxWorkers, maxAssessors].every(value => Number.isInteger(value) && value >= 1 && value <= 20)) throw Error('Invalid shared company capacity')
  }
  wrap(backend: CompanyBackend): CompanyBackend {
    return {
      assess: async (candidate, job) => {
        while (this.assessors >= this.maxAssessors) { await delay(50, undefined, { signal: job.signal }); await job.assertCurrent() }
        this.assessors++
        try { await job.assertCurrent(); return await backend.assess(candidate, job) } finally { this.assessors-- }
      },
      work: async (request, job) => {
        if (this.workers >= this.maxWorkers) return { state: 'retry', delayMs: 1000 }
        this.workers++
        try { await job.assertCurrent(); return await backend.work(request, job) } finally { this.workers-- }
      },
      stop: (...args) => backend.stop(...args), close: () => backend.close(), recover: id => backend.recover?.(id) ?? Promise.resolve(),
    }
  }
}
