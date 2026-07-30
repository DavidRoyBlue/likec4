import { describe, expect, it } from 'vitest'
import { buildElementPropertyChange } from './EditableProperty'

describe('buildElementPropertyChange', () => {
  it('null when unchanged', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any,
      field: 'description',
      value: 'same',
      original: 'same',
    })).toBeNull()
  })
  it('builds a change for the single edited field', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any,
      field: 'technology',
      value: 'k8s',
      original: null,
    })).toEqual({ op: 'change-element-property', target: 'a.b', technology: 'k8s' })
  })
})
