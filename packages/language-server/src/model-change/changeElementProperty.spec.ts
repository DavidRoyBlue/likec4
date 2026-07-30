import { describe, it, vi } from 'vitest'
import { testDoc } from './__tests__/testDoc'

vi.mock('node:fs')
vi.mock('node:fs/promises')

const SPEC = `
  specification {
    element system
    element container
    tag alpha
    tag beta
  }
`

// Separate spec for the positional-run tests — keeps SPEC (and the inline
// snapshot that echoes it) untouched.
const SPEC_WITH_ACTOR = `
  specification {
    element actor
    element container
  }
`

describe('change-element-property', () => {
  it('replaces the POSITIONAL title (parser gives it precedence over body title)', async ({ expect }) => {
    // Base.ts:598 — `override?.title ?? parseMarkdownAsString(props.title)`:
    // a positional title string always wins over a body `title` property, so
    // editing must remove the positional literal and write the body property.
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'Old Title' {
          technology 'REST'
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, title: 'New Title' } })
    const text = read()
    expect(text).toContain(`title 'New Title'`)
    expect(text).not.toContain('Old Title')
  })

  it('collapses a 2-positional run on title edit (cloud-system pattern)', async ({ expect }) => {
    // examples/cloud-system/model.c4:3 — `actor 'Title' 'Summary'`.
    // Deleting only props[0] would promote 'Interacts with the system' into the
    // TITLE slot and silently override the body title we just wrote.
    const { changeModel, read, parsedElement } = await testDoc(
      expect,
      `${SPEC_WITH_ACTOR}
      model {
        customer = actor 'Cloud System Customer' 'Interacts with the system' {
          description 'Long description'
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'customer' as any, title: 'Renamed' } })
    const text = read()
    expect(text).toContain(`title 'Renamed'`)
    expect(text).toContain(`summary 'Interacts with the system'`)
    // no positional left on the declaration line
    expect(text).toContain('customer = actor {')
    expect(text).not.toContain(`'Cloud System Customer'`)

    const parsed = await parsedElement('customer')
    expect(parsed?.title).toBe('Renamed')
    expect(parsed?.summary).toEqual({ txt: 'Interacts with the system' })
    expect(parsed?.description).toEqual({ txt: 'Long description' })
  })

  it('collapses a 3-positional run on technology edit (no silent shadowing)', async ({ expect }) => {
    const { changeModel, read, parsedElement } = await testDoc(
      expect,
      `${SPEC_WITH_ACTOR}
      model {
        api = container 'API' 'Public API' 'REST' {
          description 'The API'
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'api' as any, technology: 'gRPC' } })
    const text = read()
    expect(text).toContain('api = container {')
    expect(text).toContain(`technology 'gRPC'`)
    expect(text).not.toContain(`'REST'`)

    const parsed = await parsedElement('api')
    // the edited value actually takes effect — not shadowed by props[2]
    expect(parsed?.technology).toBe('gRPC')
    // displaced slots survive
    expect(parsed?.title).toBe('API')
    expect(parsed?.summary).toEqual({ txt: 'Public API' })
    expect(parsed?.description).toEqual({ txt: 'The API' })
  })

  it('leaves the positional run alone when nothing it shadows is edited', async ({ expect }) => {
    const { changeModel, read, parsedElement } = await testDoc(
      expect,
      `${SPEC_WITH_ACTOR}
      model {
        customer = actor 'Customer' 'Interacts' {
        }
      }`,
    )
    // description is NOT shadowed (slot 1 is `summary`), so no collapse needed
    await changeModel({ change: { op: 'change-element-property', target: 'customer' as any, description: 'Note' } })
    const text = read()
    expect(text).toContain(`customer = actor 'Customer' 'Interacts' {`)
    const parsed = await parsedElement('customer')
    expect(parsed?.title).toBe('Customer')
    expect(parsed?.description).toEqual({ txt: 'Note' })
  })

  it('collapses a positional run on a braceless element', async ({ expect }) => {
    const { changeModel, read, parsedElement } = await testDoc(
      expect,
      `${SPEC_WITH_ACTOR}
      model {
        customer = actor 'Customer' 'Interacts' 'REST'
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'customer' as any, title: 'Renamed' } })
    const text = read()
    expect(text).toContain('customer = actor {')
    const parsed = await parsedElement('customer')
    expect(parsed?.title).toBe('Renamed')
    expect(parsed?.summary).toEqual({ txt: 'Interacts' })
    expect(parsed?.technology).toBe('REST')
  })

  it('escapes quotes in written values', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'S' {
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, title: 'Bob\'s API' } })
    const first = read()
    // must re-parse: a second edit through the full pipeline proves validity
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, technology: 'k8s' } })
    const text = read()
    expect(text).toContain('k8s')
    expect(first).not.toContain('\'Bob\'s API\'') // naive unescaped form is invalid DSL
  })

  it('writes a multi-line markdown description as a triple-quoted block', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'S' {
        }
      }`,
    )
    await changeModel({
      change: { op: 'change-element-property', target: 'sys' as any, description: { md: 'line1\nline2' } },
    })
    expect(read()).toContain(`'''`)
  })

  it('sets description on element with body', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        cloud = system 'Cloud' {
          api = container 'API' {
            technology 'REST'
          }
        }
      }`,
    )
    await changeModel({
      change: { op: 'change-element-property', target: 'cloud.api' as any, description: 'Public API' },
    })
    expect(read()).toContain(`description 'Public API'`)
  })

  it('replaces existing description idempotently (two edits, one property)', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'S' {
          description 'one'
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, description: 'two' } })
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, description: 'three' } })
    const text = read()
    expect(text).toContain(`description 'three'`)
    expect(text.match(/description/g)).toHaveLength(1)
  })

  it('creates a body on a braceless element', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'Braceless'
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, title: 'Renamed' } })
    expect(read()).toMatchInlineSnapshot(`
      "
      specification {
        element system
        element container
        tag alpha
        tag beta
      }

          model {
            sys = system {
              title 'Renamed'
            }
          }"
    `) // filled by vitest: body braces created, title inside
  })

  it('preserves comments around the edited element', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        // important comment
        sys = system 'S' {
          description 'old' // trailing comment on other prop stays
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, technology: 'k8s' } })
    const text = read()
    expect(text).toContain('// important comment')
    expect(text).toContain(`technology 'k8s'`)
  })

  it('adds and removes element tags', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'S' {
          #alpha
        }
      }`,
    )
    await changeModel({
      change: { op: 'change-element-property', target: 'sys' as any, tag: { add: 'beta' as any } },
    })
    expect(read()).toContain('#alpha, #beta')
    await changeModel({
      change: { op: 'change-element-property', target: 'sys' as any, tag: { remove: 'alpha' as any } },
    })
    const text = read()
    expect(text).toContain('#beta')
    expect(text).not.toContain('#alpha')
  })

  it('warns when the added tag already arrives via extend elsewhere', async ({ expect }) => {
    const { services, changeModelRaw } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'S' {
        }
        extend sys {
          #alpha
        }
      }`,
    )
    const res = await changeModelRaw({
      change: { op: 'change-element-property', target: 'sys' as any, tag: { add: 'alpha' as any } },
    })
    if (!res.success) throw new Error(res.error)
    expect(res.warnings ?? []).toEqual([
      expect.stringContaining('alpha'),
    ])
  })

  it('rejects apply when the document changed between locate and apply (version guard)', async ({ expect }) => {
    const { services, changeModelRaw } = await testDoc(
      expect,
      `
      specification { element system }
      model {
        sys = system 'S' {
          description 'old'
        }
      }`,
    )
    // Monkey-patch applyTextEdits' precondition path: simulate concurrent edit by
    // bumping the document version after locate but before apply.
    const mc = services.likec4.ModelChanges as any
    const originalApply = mc.applyTextEdits.bind(mc)
    mc.applyTextEdits = async (doc: any, edits: any, expectedVersion?: number) => {
      // simulate another writer landing first
      doc.textDocument._version = (doc.textDocument.version ?? 0) + 1
      return originalApply(doc, edits, expectedVersion)
    }
    const res = await changeModelRaw({
      change: { op: 'change-element-property', target: 'sys' as any, description: 'new' },
    })
    expect(res.success).toBe(false)
    if (res.success) throw new Error('expected apply to fail')
    expect(res.error).toContain('changed')
  })
})
