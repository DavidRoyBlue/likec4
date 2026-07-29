import { nonNullable } from '@likec4/core'
import type { LikeC4Model } from '@likec4/core/model'
import type { Atom, ReadableAtom } from 'nanostores'
import { createContext, useContext } from 'react'

/**
 * To improve experience with HMR, we move context to separate files and use as a boundary for hooks
 */
const LikeC4ModelDataContext = createContext<Atom<LikeC4Model.Layouted>>(null as any)

export const LikeC4ModelDataContextProvider = LikeC4ModelDataContext.Provider

export const useLikeC4ModelAtom = () => {
  const ctx = useContext(LikeC4ModelDataContext)
  if (ctx === null) {
    throw new Error('LikeC4ModelAtom is not provided')
  }
  return ctx
}

const AppliedChangeIdContext = createContext<ReadableAtom<string | null> | null>(null)
export const AppliedChangeIdProvider = AppliedChangeIdContext.Provider
export function useAppliedChangeIdAtom(): ReadableAtom<string | null> {
  return nonNullable(useContext(AppliedChangeIdContext), 'No AppliedChangeIdContext')
}

// /**
//  * To improve experience with HMR, we move context to separate files and use as a boundary for hooks
//  */
// const LikeC4ModelDataContext = createContext<Atom<LayoutedLikeC4ModelData>>(null as any)

// export const LikeC4ModelDataContextProvider = LikeC4ModelDataContext.Provider

// export const useLikeC4ModelDataAtom = () => {
//   const ctx = useContext(LikeC4ModelDataContext)
//   if (ctx === null) {
//     throw new Error('LikeC4ModelDataAtom is not provided')
//   }
//   return ctx
// }
