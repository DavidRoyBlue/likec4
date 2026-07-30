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
  it('title stays a plain string', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any,
      field: 'title',
      value: 'New',
      original: 'Old',
    })).toEqual({ op: 'change-element-property', target: 'a.b', title: 'New' })
  })
  it('wraps a changed description as markdown', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any,
      field: 'description',
      value: '# Heading',
      original: 'plain',
    })).toEqual({ op: 'change-element-property', target: 'a.b', description: { md: '# Heading' } })
  })
  it('null when description is unchanged (original arrives as a plain string)', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any,
      field: 'description',
      value: '# Heading',
      original: '# Heading',
    })).toBeNull()
  })
  it('null when an empty value matches a missing original', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any,
      field: 'description',
      value: '',
      original: null,
    })).toBeNull()
  })
})
