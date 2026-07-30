import { describe, expect, it } from 'vitest'
import { buildViewPropertyChange } from './EditViewPropertiesButton'

describe('buildViewPropertyChange', () => {
  it('returns null when nothing changed', () => {
    expect(buildViewPropertyChange({
      title: 'A',
      description: 'd',
      originalTitle: 'A',
      originalDescription: 'd',
    })).toBeNull()
  })
  it('includes only changed fields', () => {
    expect(buildViewPropertyChange({
      title: 'B',
      description: 'd',
      originalTitle: 'A',
      originalDescription: 'd',
    })).toEqual({ op: 'change-property', title: 'B' })
  })
  it('wraps a changed description as markdown', () => {
    expect(buildViewPropertyChange({
      title: 'A',
      description: 'new',
      originalTitle: 'A',
      originalDescription: 'd',
    })).toEqual({ op: 'change-property', description: { md: 'new' } })
  })
})
