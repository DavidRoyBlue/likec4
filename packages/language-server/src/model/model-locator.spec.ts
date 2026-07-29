import { describe, it, vi } from 'vitest'
import { testDoc } from '../model-change/__tests__/testDoc'

vi.mock('node:fs')
vi.mock('node:fs/promises')

describe('LikeC4ModelLocator.locateElementAst', () => {
  it('returns live ast.Element with cst node for a nested fqn', async ({ expect }) => {
    const { services } = await testDoc(
      expect,
      `
      specification {
        element system
        element container
      }
      model {
        cloud = system 'Cloud' {
          api = container 'API' {
            description 'old'
          }
        }
      }`,
    )
    const located = services.likec4.ModelLocator.locateElementAst('cloud.api' as any)
    expect(located).toBeTruthy()
    expect(located!.elementAst.$cstNode).toBeDefined()
    expect(located!.element.id).toBe('cloud.api')
    expect(located!.elementAst.name).toBe('api')
  })

  it('returns null for unknown fqn', async ({ expect }) => {
    const { services } = await testDoc(
      expect,
      `specification { element system }
      model { sys = system 'S' }`,
    )
    expect(services.likec4.ModelLocator.locateElementAst('nope' as any)).toBeNull()
  })
})
