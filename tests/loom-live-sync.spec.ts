// @vitest-environment jsdom
/** Embedded pages keep syncing across visibility/navigation changes without discarding every slow response. */
import { afterEach, expect, it, vi } from 'vitest'
import { startLiveSync } from '../loom/src/client/live-sync.ts'
const stops:(()=>void)[]=[]
afterEach(()=>{for(const stop of stops.splice(0))stop();vi.useRealTimers();vi.restoreAllMocks()})
it('keeps one slow request in flight and applies its result even after multiple polling intervals',async()=>{
  vi.useFakeTimers();const gate=Promise.withResolvers<number>(),load=vi.fn(()=>gate.promise),value=vi.fn(),error=vi.fn()
  const sync=startLiveSync({load,value,error});stops.push(sync.stop)
  await vi.advanceTimersByTimeAsync(6500)
  expect(load).toHaveBeenCalledTimes(1)
  gate.resolve(42);await sync.refresh()
  expect(value).toHaveBeenCalledWith(42);expect(error).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2500);expect(load).toHaveBeenCalledTimes(2)
})
it('refreshes hidden embedded tabs, route changes and visibility changes without waiting for window focus',async()=>{
  vi.useFakeTimers();vi.spyOn(document,'hidden','get').mockReturnValue(true)
  const load=vi.fn(async()=>1),value=vi.fn(),sync=startLiveSync({load,value,error:vi.fn()});stops.push(sync.stop)
  await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000);expect(load).toHaveBeenCalledTimes(2)
  window.dispatchEvent(new Event('hashchange'));await sync.refresh();expect(load).toHaveBeenCalledTimes(3)
  document.dispatchEvent(new Event('visibilitychange'));await sync.refresh();expect(load).toHaveBeenCalledTimes(4)
  sync.stop();window.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(10000)
  expect(load).toHaveBeenCalledTimes(4)
})
it('aborts a stuck fetch, reports stale connectivity and can retry on the next poll',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined
  const error=vi.fn(),value=vi.fn(),load=vi.fn((input:AbortSignal)=>{
    signal=input;return new Promise<number>((_resolve,reject)=>input.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}))
  })
  const sync=startLiveSync({load,value,error});stops.push(sync.stop)
  await vi.advanceTimersByTimeAsync(10000)
  expect(signal?.aborted).toBe(true);expect(error).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000);expect(load).toHaveBeenCalledTimes(2)
  sync.stop();await vi.advanceTimersByTimeAsync(0)
  expect(error).toHaveBeenCalledTimes(1);expect(value).not.toHaveBeenCalled()
})
