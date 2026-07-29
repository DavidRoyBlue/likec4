import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise } from 'xstate'
import { editorActorLogic } from './machine'

afterEach(() => {
  vi.useRealTimers()
})

function makeActor(executeChangeImpl: (input: any) => Promise<any>) {
  const logic = editorActorLogic.provide({
    actors: {
      executeChange: fromPromise(({ input }) => executeChangeImpl(input)),
      applyLatest: fromPromise(async () => ({ updated: {} as any })),
      applySemanticLayout: fromPromise(async () => ({})),
      // NOTE: Task 10 adds a `refetchView` actor to setup.ts — when implementing
      // Task 10, extend this helper to also provide it.
    },
  })
  return createActor(logic, { input: { viewId: 'index' as any }, systemId: 'editor' })
}

describe('sync queue ack discipline', () => {
  it('waits for matching view.synched changeId instead of a 2s timer', async () => {
    vi.useFakeTimers()
    let resolveRpc!: (v: any) => void
    const executed: any[] = []
    const actor = makeActor(async (input) => {
      executed.push(input)
      return await new Promise(r => (resolveRpc = r))
    })
    actor.start()
    actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'TB' } } as any })

    await vi.advanceTimersByTimeAsync(10)
    expect(executed).toHaveLength(1)
    const changeId = executed[0].changes[0].changeId
    expect(changeId).toBeTypeOf('string')

    resolveRpc({ requested: executed[0].changes, applied: executed[0].changes, failed: [], warnings: [] })
    await vi.advanceTimersByTimeAsync(10)

    // a NON-matching ack must NOT release the queue (old 2000ms fallback would have)
    actor.send({ type: 'view.synched', changeId: 'someone-else' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(actor.getSnapshot().matches({ syncQueue: { process: 'waitViewSynced' } })).toBe(true)

    actor.send({ type: 'view.synched', changeId })
    await vi.advanceTimersByTimeAsync(10)
    expect(actor.getSnapshot().matches({ syncQueue: 'idle' })).toBe(true)
  })

  it('does not start the second op before the first is acked (the #2975 duplicate-insert class)', async () => {
    vi.useFakeTimers()
    const invocations: string[][] = []
    let release!: (v: any) => void
    const actor = makeActor(async (input) => {
      invocations.push(input.changes.map((c: any) => c.changeId))
      return await new Promise(r => (release = r))
    })
    actor.start()
    actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'TB' } } as any })
    await vi.advanceTimersByTimeAsync(10)
    actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'LR' } } as any })
    await vi.advanceTimersByTimeAsync(3000)
    // second op queued, NOT executed against un-acked state
    expect(invocations).toHaveLength(1)
    release({ requested: [], applied: [], failed: [], warnings: [] })
    await vi.advanceTimersByTimeAsync(10)
    actor.send({ type: 'view.synched', changeId: null })
    await vi.advanceTimersByTimeAsync(10)
    expect(invocations.length).toBeGreaterThanOrEqual(2)
  })
})
