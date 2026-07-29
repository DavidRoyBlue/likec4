import type * as t from '@likec4/core/types'
import {
  type ActorRefFromLogic,
  type StateMachine,
  type StateValue,
  fromPromise,
  setup,
} from 'xstate'
import {
  type inferChildrenRef,
  type inferProvidedActor,
  defineActors,
} from '../../utils/defineActors'
import { hotkey } from './hotkey'
import type {
  EditorActorContext,
  EditorActorEmitedEvent,
  EditorActorEvent,
  EditorActorInput,
  EditorActorStateTag,
  QueuedChange,
} from './types'

export namespace EditorCalls {
  export type ApplyLatestToManual = (
    params: { input: ApplyLatestToManual.Input },
  ) => Promise<ApplyLatestToManual.Output>
  export namespace ApplyLatestToManual {
    export type Input = { viewId: t.ViewId; current: t.LayoutedView | undefined }
    export type Output = { updated: t.LayoutedView }
  }

  export type ApplySemanticLayout = (
    params: { input: ApplySemanticLayout.Input },
  ) => Promise<ApplySemanticLayout.Output>
  export namespace ApplySemanticLayout {
    export type Input = { viewId: t.ViewId }
    export type Output = {}
  }

  export type RefetchView = (
    params: { input: RefetchView.Input },
  ) => Promise<RefetchView.Output>
  export namespace RefetchView {
    export type Input = { viewId: t.ViewId }
    export type Output = { view: t.LayoutedView }
  }

  export type ExecuteChange = (
    params: { input: ExecuteChange.Input },
  ) => Promise<ExecuteChange.Output>
  export namespace ExecuteChange {
    export type Input = { viewId: t.ViewId; changes: QueuedChange[] }
    /**
     * Outcome of a batch of queued changes.
     *
     * `applied` carries the ack tokens the queue then waits for on `view.synched`.
     */
    export type Output = {
      requested: QueuedChange[]
      applied: QueuedChange[]
      failed: Array<{ item: QueuedChange; error: string }>
      /**
       * Non-fatal messages surfaced to the user (populated by model changes)
       */
      warnings: string[]
    }
  }
}

const applyLatest = fromPromise<EditorCalls.ApplyLatestToManual.Output, EditorCalls.ApplyLatestToManual.Input>(
  () => {
    throw new Error('Not implemented')
  },
)

const executeChange = fromPromise<EditorCalls.ExecuteChange.Output, EditorCalls.ExecuteChange.Input>(
  () => {
    throw new Error('Not implemented')
  },
)

const applySemanticLayout = fromPromise<EditorCalls.ApplySemanticLayout.Output, EditorCalls.ApplySemanticLayout.Input>(
  () => {
    throw new Error('Not implemented')
  },
)

const refetchView = fromPromise<EditorCalls.RefetchView.Output, EditorCalls.RefetchView.Input>(
  () => {
    throw new Error('Not implemented')
  },
)

const actors = defineActors({
  hotkey,
  applyLatest,
  executeChange,
  applySemanticLayout,
  refetchView,
})

export const machine = setup({
  types: {
    context: {} as EditorActorContext,
    events: {} as EditorActorEvent,
    emitted: {} as EditorActorEmitedEvent,
    input: {} as EditorActorInput,
    children: {} as {
      hotkey: 'hotkey'
    },
    tags: '' as EditorActorStateTag,
  },
  actors: actors,
  delays: {
    '500ms': 500,
    'wait-after-edit': 1_000,
  },
  guards: {
    'has pending': ({ context }) => context.syncQueue.length > 0,
    'can undo': ({ context }) => context.history !== null,
    'can redo': ({ context }) => context.redo !== null,
  },
})

/**
 * to workaround circular dependency issue between editor and diagram packages
 */
export interface BaseEditorActorLogic<State extends StateValue = any> extends
  StateMachine<
    EditorActorContext,
    EditorActorEvent,
    inferChildrenRef<typeof actors>,
    inferProvidedActor<typeof actors>,
    never,
    never,
    never,
    State,
    EditorActorStateTag,
    EditorActorInput,
    never,
    EditorActorEmitedEvent,
    never,
    never
  >
{
}
export type BaseEditorActorRef = ActorRefFromLogic<BaseEditorActorLogic>
