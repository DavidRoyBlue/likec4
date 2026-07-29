import { describe, expect, it } from 'vitest'
import { updateModel } from './updateModel'

const params = (applyModelChange: any) =>
  ({
    logger: { info() {}, error() {} },
    likec4: { editor: { applyModelChange } },
    appliedChanges: new Map<string, string>(),
  }) as any

describe('updateModel', () => {
  it('records the changeId, reverting on failure', async () => {
    const ok = params(async () => ({ success: true, location: null }))
    await updateModel(ok, {
      projectId: 'p' as any,
      change: { op: 'change-element-property', target: 'a' } as any,
      changeId: 'c1',
    })
    expect(ok.appliedChanges.get('p')).toBe('c1')

    const bad = params(async () => ({ success: false, error: 'boom' }))
    const res = await updateModel(bad, {
      projectId: 'p' as any,
      change: { op: 'change-element-property', target: 'a' } as any,
      changeId: 'c2',
    })
    expect(res).toEqual({ success: false, error: 'boom' })
    expect(bad.appliedChanges.has('p')).toBe(false)
  })
})
