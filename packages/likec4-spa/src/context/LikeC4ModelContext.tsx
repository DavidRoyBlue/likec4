import type { LikeC4Model } from '@likec4/core/model'
import { LikeC4ModelProvider } from '@likec4/diagram'
import { useStore } from '@nanostores/react'
import type { ReadableAtom } from 'nanostores'
import type { PropsWithChildren } from 'react'
import { AppliedChangeIdProvider, LikeC4ModelDataContextProvider } from './safeCtx'

export function LikeC4ModelContext(
  { likec4model, appliedChangeId, children }: PropsWithChildren<{
    likec4model: ReadableAtom<LikeC4Model.Layouted>
    appliedChangeId: ReadableAtom<string | null>
  }>,
) {
  // useLogger('LikeC4ModelContext', [likec4data, likec4model])
  const model = useStore(likec4model)

  return (
    <LikeC4ModelDataContextProvider value={likec4model}>
      <AppliedChangeIdProvider value={appliedChangeId}>
        <LikeC4ModelProvider likec4model={model}>
          {children}
        </LikeC4ModelProvider>
      </AppliedChangeIdProvider>
    </LikeC4ModelDataContextProvider>
  )
}
