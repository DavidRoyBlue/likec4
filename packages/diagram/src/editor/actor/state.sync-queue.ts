import { invariant } from '@likec4/core'
import { findLast } from 'remeda'
import { assign, enqueueActions, log, sendTo } from 'xstate'
import { typedSystem } from '../../likec4diagram/state/utils'
import { notifyEditError, notifyEditWarning } from '../notifyEditError'
import {
  cancelSync,
  clearQueue,
  deleteNodesAndEdges,
  makeSnapshot,
  newChangeId,
  pushToSyncQueue,
  redo,
  scheduleSync,
  undo,
} from './actions'
import { machine } from './setup'
import { ackReleasesQueue, isQueuedChange } from './types'

const to = {
  idle: { target: '#queue-idle' },
  pending: { target: '#queue-pending' },
  suspended: { target: '#queue-suspended' },
  process: { target: '#queue-process' },
} as const

const idOf = (t: { target: string }) => ({ id: t.target.substring(1) })

/**
 * Idle state, no pending operations
 */
const idle = machine.createStateConfig({
  ...idOf(to.idle),
  always: {
    guard: 'has pending',
    ...to.pending,
  },
  on: {
    'delete.nodes-edges': {
      actions: deleteNodesAndEdges(),
    },
    'change.sync-snapshot': {
      actions: pushToSyncQueue(),
      ...to.pending,
    },
    'change.*': {
      actions: pushToSyncQueue(),
      ...to.process,
    },
    'undo': {
      actions: undo(),
    },
    'redo': {
      actions: redo(),
    },
    'cancel': {
      actions: cancelSync(),
      ...to.idle,
    },
    'view.synched': {
      actions: log('in idle got view.synched'),
    },
  },
})

/**
 * Has pending operations
 */
const pending = machine.createStateConfig({
  ...idOf(to.pending),
  on: {
    // Debounce queue events
    'change.sync-snapshot': {
      reenter: true,
      actions: pushToSyncQueue(),
      ...to.pending,
    },
    // All other changes route to process
    'change.*': {
      actions: pushToSyncQueue(),
      ...to.process,
    },
    'delete.nodes-edges': {
      actions: deleteNodesAndEdges(),
      reenter: true,
      ...to.pending,
    },
    // When editing starts, we suspend the queue
    'edit.move.start': {
      ...to.suspended,
    },
    'undo': {
      reenter: true,
      actions: undo(),
      ...to.pending,
    },
    'redo': {
      reenter: true,
      actions: redo(),
      ...to.pending,
    },
    'cancel': {
      actions: clearQueue(),
      ...to.idle,
    },
    'view.synched': {
      actions: log('in pending got view.synched'),
    },
  },
  after: {
    'wait-after-edit': [
      {
        guard: 'has pending',
        ...to.process,
      },
      to.idle,
    ],
  },
})

/**
 * When editing starts, we suspend the queue
 */
const suspended = machine.createStateConfig({
  ...idOf(to.suspended),
  on: {
    // idle redirects to pending if any
    'edit.*': to.idle,
    'cancel': {
      actions: [
        clearQueue(),
        cancelSync(),
      ],
      ...to.idle,
    },
  },
})

const peekFromQueue = () =>
  machine.assign(({ system, context: { syncQueue } }) => {
    let [head, ...tail] = syncQueue
    if (head === 'sync-snapshot') {
      head = { changeId: newChangeId(), change: makeSnapshot(system).change }
    }
    return {
      processing: head ?? null,
      syncQueue: tail,
    }
  })

const clearProcessing = () => ({
  processing: null,
  // Nothing is outstanding once we leave the wait (also cleans up after the escape hatch)
  awaitingAck: [],
  seenAcks: [],
})

/**
 * Processing pending operation
 */
const process = machine.createStateConfig({
  ...idOf(to.process),
  initial: 'peekFromQueue',
  tags: ['busy'],
  states: {
    peekFromQueue: {
      entry: peekFromQueue(),
      // Decide what to do next
      always: [
        {
          guard: ({ context: { processing } }) => processing === 'apply-latest-to-manual',
          target: 'applyLatestToManual',
        },
        {
          guard: ({ context: { processing } }) => processing === 'apply-semantic-layout',
          target: 'applySemanticLayout',
        },
        {
          guard: ({ context: { processing } }) => isQueuedChange(processing),
          target: 'executeChanges',
        },
        {
          guard: 'has pending',
          reenter: true,
          ...to.process,
        },
        {
          actions: clearQueue(),
          ...to.idle,
        },
      ],
    },
    /**
     * Syncing state, some edits are not yet synced
     */
    applyLatestToManual: machine.createStateConfig({
      initial: 'call',
      entry: assign(({ system }) => ({
        processing: { changeId: newChangeId(), change: makeSnapshot(system).change },
      })),
      states: {
        // Fetch latest and manual layouts
        // Apply changes, send update to diagram
        call: {
          invoke: {
            src: 'applyLatest',
            input: ({ context }) => {
              const current = context.processing
              invariant(isQueuedChange(current) && current.change.op === 'save-view-snapshot')
              return ({
                current: current.change.layout,
                viewId: context.viewId,
              })
            },
            onDone: {
              actions: sendTo(
                typedSystem.diagramActor,
                ({ event }) => ({
                  type: 'update.view',
                  view: event.output.updated,
                }),
                { delay: 20 },
              ),
              target: 'wait',
            },
            onError: {
              actions: assign(({ event }) => {
                console.error('applyLatestToManual onError', { error: event.error })
                notifyEditError({ op: 'apply-latest-to-manual', error: String(event.error) })
                return {
                  processing: null,
                  syncQueue: [],
                }
              }),
              ...to.idle,
            },
          },
        },
        // Now we wait 500ms, take new snapshot and send sync
        wait: {
          on: {
            // Ignore all events during window to prevent
            // race conditions between view updates and sync operations
            '*': {
              actions: log(({ event }) => `wait: ignoring event ${event.type}`),
            },
          },
          after: {
            '500ms': {
              actions: [
                clearQueue(),
                assign({ redo: null }),
                scheduleSync(),
              ],
              ...to.idle,
            },
          },
        },
      },
    }),
    /**
     * User requested semantic layout, we will call the AI
     */
    applySemanticLayout: machine.createStateConfig({
      tags: ['ai-semantic-layout'],
      invoke: {
        src: 'applySemanticLayout',
        input: ({ context }) => ({
          viewId: context.viewId,
        }),
        onDone: {
          target: 'decideNext',
        },
        onError: {
          actions: ({ event }) => {
            console.error('applySemanticLayout onError', { error: event.error })
            notifyEditError({ op: 'apply-semantic-layout', error: String(event.error) })
          },
          target: 'failure',
        },
      },
    }),
    /**
     * Calls `executeChange` to save the snapshot
     */
    executeChanges: machine.createStateConfig({
      // A new batch starts with a clean ack slate, so an ack observed here can only
      // belong to this batch. Deliberately NOT cleared in `onDone` - that would erase
      // an ack that beat the RPC reply, which is the whole point of recording them.
      entry: assign({ seenAcks: [] }),
      invoke: {
        src: 'executeChange',
        input: ({ context: { processing, syncQueue, viewId } }) => {
          // processing must be defined
          invariant(processing && isQueuedChange(processing))
          return ({
            changes: [
              processing,
              ...syncQueue.filter(isQueuedChange),
            ],
            viewId,
          })
        },
        onDone: [
          {
            guard: ({ event }) => event.output.failed.length > 0,
            actions: assign({
              lastFailures: ({ event }) =>
                event.output.failed.map(({ item, error }) => ({ op: item.change.op, error })),
            }),
            target: 'failureNotify',
          },
          {
            actions: enqueueActions(({ context, event, enqueue }) => {
              if (import.meta.env.DEV) {
                console.log('executeChanges onDone', { event })
              }
              const requested = event.output.requested
              enqueue.assign({
                processing: null,
                // Match by ack token, not object identity: `requested` only shares
                // references with the queue while the actor logic happens to echo
                // `input.changes` locally. Any serializing hop (birpc) would break that.
                syncQueue: context.syncQueue.filter(op =>
                  !isQueuedChange(op) || !requested.some(item => item.changeId === op.changeId)
                ),
                // Only what actually reached the server needs an ack
                awaitingAck: event.output.applied.map(item => item.changeId),
              })

              const lastSyncSnapshot = findLast(
                event.output.applied,
                item => item.change.op === 'save-view-snapshot',
              )
              if (lastSyncSnapshot && lastSyncSnapshot.change.op === 'save-view-snapshot') {
                enqueue.sendTo(
                  typedSystem.diagramActor,
                  {
                    type: 'update.view-bounds',
                    bounds: lastSyncSnapshot.change.layout.bounds,
                  },
                )
              }

              // Non-fatal messages surfaced to the user (populated by model changes,
              // e.g. extend-tag warnings)
              for (const warning of event.output.warnings) {
                notifyEditWarning(warning)
              }
            }),
            target: 'waitViewSynced',
          },
        ],
        onError: {
          actions: ({ event }) => {
            console.error('executeChanges onError', { error: event.error })
          },
          target: 'failure',
        },
      },
    }),

    /**
     * At least one change in the batch failed: server truth wins. Refetch the
     * current view, push it to the diagram, notify every failure, and drop
     * whatever was queued - the client-side queue can no longer be trusted to
     * apply cleanly against server state it disagrees with.
     */
    failureNotify: machine.createStateConfig({
      invoke: {
        src: 'refetchView',
        input: ({ context }) => ({ viewId: context.viewId }),
        onDone: {
          actions: [
            // GUARDED send: system.get('diagram') is absent in standalone contexts
            // (unit tests, detached actors) where a raw sendTo would throw.
            enqueueActions(({ enqueue, event, system }) => {
              if ((system as any).get('diagram')) {
                enqueue.sendTo(typedSystem.diagramActor, {
                  type: 'update.view' as const,
                  view: event.output.view,
                  source: 'editor' as const,
                })
              }
            }),
            ({ context }) => {
              for (const f of context.lastFailures) {
                notifyEditError(f)
              }
            },
            assign({ lastFailures: [], awaitingAck: [], syncQueue: [], processing: null }),
          ],
          ...to.idle,
        },
        onError: {
          // refetch itself failed — notify and reset; HMR will eventually restore truth
          actions: [
            ({ context }) => {
              for (const f of context.lastFailures) notifyEditError(f)
            },
            assign({ lastFailures: [], awaitingAck: [], syncQueue: [], processing: null }),
          ],
          ...to.idle,
        },
      },
    }),

    // This state blocks further changes until the view is fully synced
    waitViewSynced: {
      // The ack may already have arrived while `executeChanges` was still invoking
      // (the HMR model push can outrun the RPC reply). Replay what was recorded so
      // such a batch releases at once instead of stalling on the 8s escape hatch.
      always: {
        guard: ({ context }) => context.seenAcks.some(changeId => ackReleasesQueue(context.awaitingAck, changeId)),
        actions: log('view.synched arrived before the RPC reply — releasing on the recorded ack'),
        target: 'decideNext',
      },
      on: {
        'view.synched': [
          {
            // `changeId == null` releases the queue for sources that don't thread
            // ack tokens (VSCode preview, applyLatest) - they must not deadlock it.
            guard: ({ context, event }) => ackReleasesQueue(context.awaitingAck, event.changeId),
            actions: assign({ awaitingAck: [] }),
            target: 'decideNext',
          },
          { actions: log('view.synched with non-matching changeId — keep waiting') },
        ],
      },
      after: {
        // Escape hatch only (server hung / HMR channel dropped) — 8s, not 30s:
        // a stalled drag gesture must not freeze for half a minute.
        8_000: 'decideNext',
      },
    },

    decideNext: {
      entry: assign(clearProcessing),
      always: [
        // If there are pending operations, enter the process state
        {
          guard: 'has pending',
          reenter: true,
          ...to.process,
        },
        // Otherwise, stay idle
        to.idle,
      ],
    },

    failure: {
      always: {
        actions: clearQueue(),
        ...to.idle,
      },
    },
  },
  on: {
    // Changes arriving while an op is in flight (or awaiting its ack) are queued,
    // never executed against un-acked state and never dropped.
    // The `wait` sub-state of applyLatestToManual keeps its own `*` handler and,
    // being deeper, still wins - its ignore-window is preserved.
    'change.*': {
      actions: pushToSyncQueue(),
    },
    // Acks can land before the queue reaches `waitViewSynced` (deeper states that
    // handle `view.synched` themselves - i.e. `waitViewSynced` - still win here).
    // Record rather than drop, so the batch is not stranded on the 8s hatch.
    'view.synched': {
      actions: assign(({ context, event }) => ({
        seenAcks: [...context.seenAcks, event.changeId ?? null],
      })),
    },
    // 'undo': {
    //   actions: log('ignore undo in process state'),
    // },
  },
})

export const syncQueue = machine.createStateConfig({
  initial: 'idle',
  states: {
    idle,
    pending,
    suspended,
    process,
  },
  on: {},
})
