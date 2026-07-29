import type * as t from '@likec4/core/types'
import type { Types } from '../../likec4diagram/types'
import type { HotKeyEvent } from './hotkey'

export type EditorActorEvent =
  // Add change to queue
  | { type: 'change.view'; change: t.ViewChange }
  | { type: 'change.model'; change: t.ModelChange }
  | { type: 'change.semantic-layout' }
  | { type: 'change.latest-to-manual' }
  | { type: 'change.sync-snapshot' }
  | { type: 'delete.nodes-edges'; nodeIds: t.NodeId[]; edgeIds: t.EdgeId[] }
  // view update has been received, consider synced
  | { type: 'view.synched'; changeId?: string | null }
  | { type: 'cancel' }
  // Edit events
  | { type: 'edit.move.start'; subject: 'node' | 'edge' }
  | { type: 'edit.move.end' }
  | { type: 'edit.move.cancel' } // Cancel current editing
  | HotKeyEvent

export type Snapshot = {
  view: t.LayoutedView
  change: t.ViewChange.SaveViewSnapshot
  xynodes: Types.Node[]
  xyedges: Types.Edge[]
}

export type LinkedSnapshot = {
  head: Snapshot
  tail: LinkedSnapshot | null
}

export interface EditorActorInput {
  viewId: t.ViewId
}

/**
 * A change queued for sync, tagged with an ack token.
 *
 * The `changeId` travels to the language server and comes back on `view.synched`,
 * which is how the queue knows the change it sent has actually landed
 * (instead of guessing with a fixed timer).
 */
export type QueuedChange = {
  changeId: string
  change: t.ViewChange | t.ModelChange
}

export type SyncOp =
  | QueuedChange
  | 'sync-snapshot'
  | 'apply-semantic-layout'
  | 'apply-latest-to-manual'

/**
 * Structural guard - checks for the `changeId` property, so that assigning a raw
 * `ViewChange` (an un-wrapped change, missing its ack token) anywhere in the
 * queue is a compile error rather than a silent runtime bug.
 */
export const isQueuedChange = (op: SyncOp | null | undefined): op is QueuedChange =>
  op !== null && op !== undefined && typeof op !== 'string' && 'changeId' in op

/**
 * Unwraps a queued change to the underlying change, string sentinels pass through.
 */
export const unwrapSyncOp = (op: SyncOp): t.ViewChange | t.ModelChange | Exclude<SyncOp, QueuedChange> =>
  isQueuedChange(op) ? op.change : op

/**
 * ONE discriminator between `ModelChange` and `ViewChange`, used everywhere -
 * do not re-declare this check locally.
 */
// extend in later phases
export const isModelChange = (c: t.ViewChange | t.ModelChange): c is t.ModelChange => c.op === 'change-element-property'

export interface EditorActorContext {
  viewId: t.ViewId

  // Undo history
  history: LinkedSnapshot | null

  // Redo history
  redo: LinkedSnapshot | null

  editing: null | {
    /**
     * The subject of the edit
     */
    subject: 'node' | 'edge'
    /**
     * The state before editing started
     */
    before: Snapshot
  }

  syncQueue: Array<SyncOp>
  processing: Exclude<SyncOp, 'sync-snapshot'> | null

  /**
   * Change ids sent to the server and not yet acknowledged by a `view.synched`.
   * Empty means "nothing outstanding".
   */
  awaitingAck: string[]

  /**
   * Acks observed for the current batch *before* the queue reached `waitViewSynced`.
   *
   * The HMR model push that carries the applied change id can outrun the RPC reply,
   * so the only ack for a batch may arrive while `executeChanges` is still invoking.
   * Recording it here keeps it from being dropped (which would strand the queue on
   * the 8s escape hatch with the canvas frozen by the `busy` tag).
   *
   * `null` entries are un-correlated acks (sources that don't thread change ids).
   */
  seenAcks: Array<string | null>
}

/**
 * The `view.synched` release rule, in one place so the event-driven check in
 * `waitViewSynced` and the replay of {@link EditorActorContext.seenAcks} cannot drift.
 *
 * Releases on an un-correlated ack, on nothing being outstanding, or on a match.
 */
export const ackReleasesQueue = (awaitingAck: string[], changeId: string | null | undefined): boolean =>
  changeId == null || awaitingAck.length === 0 || awaitingAck.includes(changeId)

export type EditorActorEmitedEvent = { type: 'idle' }

export type EditorActorStateTag = 'pending' | 'busy' | 'ai-semantic-layout'
