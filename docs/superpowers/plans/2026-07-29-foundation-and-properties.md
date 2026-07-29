# Command Center Phase 1+2: Foundation Hardening & Property Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LikeC4 dev-server write path race-free and failure-visible, then ship the first visible editing capability: element properties (title/description/technology/tags) and view properties editable from the diagram, persisted as comment-preserving TextEdits into `.c4` source.

**Architecture:** Extends the single existing write pipeline (diagram machine → editor sync-queue actor → `LikeC4EditorCallbacks` → birpc-over-HMR → `LikeC4ModelChanges` → `TextEdit[]` → `FileSystemProvider`). Adds a `ModelChange` envelope parallel to `ViewChange` for element-scoped ops, ack tokens (`changeId`) that flow server→model-module→diagram to replace the 2s sync timer, and failure rollback via server-truth refetch + notifications. Spec: `docs/superpowers/specs/2026-07-29-command-center-editing-design.md`.

**Tech Stack:** TypeScript, Langium (CST-range TextEdits), `@likec4/generators/likec4` `ops` combinators, XState v5, React 19 + Mantine, birpc over Vite HMR, Vitest + memfs.

## Global Constraints

- Node >= 22.22.3, pnpm workspace. Run all commands from the worktree root: `/home/bkd/LikeC4/.claude/worktrees/command-center-spec`.
- Before first task: `pnpm install && pnpm generate` (generated Langium parser & icons registry are gitignored — nothing builds without this).
- After ANY change to `packages/core`: run `pnpm exec tsc --build packages/core` before typechecking/testing downstream packages (composite project gotcha — stale `.d.ts` otherwise). If downstream `tsc -b` reports phantom errors: `find packages -name "*.tsbuildinfo" -delete`.
- Formatting: dprint (120 cols, single quotes, no semicolons). Run `pnpm fmt` before every commit. Lint: `pnpm lint:errors-only`.
- Tests: Vitest, colocated `*.spec.ts`. Run a package's tests: `pnpm --filter @likec4/language-server exec vitest run src/model-change` (adjust filter/path).
- Never edit `packages/language-server/src/generated*`, `**/routeTree.gen.ts`, or `packages/icons`.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`). One focused commit per task.
- Do NOT add new runtime dependencies except `@mantine/notifications` (Task 10; already in workspace catalog `catalog:mantine`).
- `ViewChange` union lives in `packages/core/src/types/view-changes.ts`; keep it untouched except where a task explicitly modifies it.
- NEVER verify via `node packages/likec4/bin/likec4.mjs` — that entry imports `../dist/` which does not exist in a fresh worktree. The source-mode dev server is `pnpm --filter likec4 dev:example-cloud` (tsx with `--conditions=sources`; picks up edits in diagram/vite-plugin/language-server/spa without building). Note the port it prints.
- After editing any `package.json` dependencies: run `pnpm install` before any test or typecheck step.

---

### Task 1: Core `ModelChange` type

**Files:**
- Create: `packages/core/src/types/model-changes.ts`
- Modify: `packages/core/src/types/index.ts` (add export; find the line `export * from './view-changes'` and add the sibling export next to it)

**Interfaces:**
- Consumes: `scalar.Fqn`, `scalar.Tag`, `scalar.MarkdownOrString` from `./scalar` (same imports style as `view-changes.ts`).
- Produces: `ModelChange` union and `ModelChange.ChangeElementProperty` — used by Tasks 5, 6, 7, 9b, 12. Exact shape:

```ts
ModelChange = ModelChange.ChangeElementProperty
ModelChange.ChangeElementProperty = {
  op: 'change-element-property'
  target: scalar.Fqn
  title?: string
  description?: string | scalar.MarkdownOrString   // plain string prints single-quoted; { md } prints a ''' block
  technology?: string
  tag?: { add?: scalar.Tag | scalar.Tag[]; remove?: scalar.Tag | scalar.Tag[] }
}
```

- [ ] **Step 1: Environment sanity (first task only)**

```bash
pnpm install && pnpm generate
pnpm --filter @likec4/language-server exec vitest run src/model-change/viewChange.spec.ts
```
Expected: install + generate succeed; all existing viewChange tests PASS. If they fail, STOP — the baseline is broken.

- [ ] **Step 2: Create the type file**

```ts
// packages/core/src/types/model-changes.ts
import type * as scalar from './scalar'

export namespace ModelChange {
  /**
   * Change properties of a model element (identified by FQN).
   * Grammar guarantees title/description/technology live only at the
   * declaration site (extend carries only tags/links/metadata).
   */
  export interface ChangeElementProperty {
    op: 'change-element-property'
    target: scalar.Fqn
    title?: string
    /**
     * Plain string → single-quoted literal; { md } → triple-quoted markdown block.
     * ops.props.descriptionProperty() accepts both (generators/.../properties.ts:74).
     */
    description?: string | scalar.MarkdownOrString
    technology?: string
    tag?: {
      add?: scalar.Tag | scalar.Tag[]
      remove?: scalar.Tag | scalar.Tag[]
    }
  }
}

export type ModelChange = ModelChange.ChangeElementProperty
```

- [ ] **Step 3: Export from types index**

In `packages/core/src/types/index.ts`, next to the existing `export * from './view-changes'` line, add:

```ts
export * from './model-changes'
```

- [ ] **Step 4: Build core and typecheck**

```bash
pnpm exec tsc --build packages/core
```
Expected: clean build, no errors.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/core && git commit -m "feat(core): add ModelChange union for element-scoped edits"
```

---

### Task 2: Extract shared `testDoc` harness

**Files:**
- Create: `packages/language-server/src/model-change/__tests__/testDoc.ts`
- Modify: `packages/language-server/src/model-change/viewChange.spec.ts:1-65`

**Interfaces:**
- Produces: `testDoc(expect: ExpectStatic, document: string)` returning `{ change, changeModel, read, fs, services }` — used by Tasks 4, 5, 6. `change(params: ChangeView.Params)` applies a view change and returns in-memory text (Task 5 adds `changeModel`/`changeModelRaw` siblings); `read()` asserts memory==disk and returns text; `services` is the full `createTestServices` result services object (needed by Task 4 to reach `ModelLocator`).

- [ ] **Step 1: Move the harness**

Cut lines 1–65 of `viewChange.spec.ts` (imports through the closing brace of `async function testDoc`, including `vi.mock('node:fs')`, `vi.mock('node:fs/promises')`, and `let seq = 0`) into the new file `packages/language-server/src/model-change/__tests__/testDoc.ts`. Apply these changes while moving:

- Fix relative imports (one level deeper): `'../filesystem'` → `'../../filesystem'`, `'../protocol'` → `'../../protocol'`, `'../test'` → `'../../test'`.
- Add `export` before `async function testDoc`.
- Return `services` too: change the return statement to `return { change, read, fs, services }`.
- Keep `vi.mock('node:fs')` / `vi.mock('node:fs/promises')` in BOTH files (vi.mock is hoisted per-test-file; the spec file must keep its own).

The moved file:

```ts
// packages/language-server/src/model-change/__tests__/testDoc.ts
import { UriUtils } from 'langium'
import { vol } from 'memfs'
import stripIndent from 'strip-indent'
import { type ExpectStatic, vi } from 'vitest'
import { URI } from 'vscode-uri'
import { WithFileSystem } from '../../filesystem'
import type { ChangeView } from '../../protocol'
import { createTestServices } from '../../test'

let seq = 0
export async function testDoc(expect: ExpectStatic, document: string) {
  const workspacePath = URI.file('/test/workspace/src' + ++seq)
  const documentUri = UriUtils.joinPath(workspacePath, 'test.c4')

  vol.mkdirSync(workspacePath.fsPath, { recursive: true })
  vol.writeFileSync(documentUri.fsPath, stripIndent(document).trimEnd(), { encoding: 'utf-8' })

  const { initialize, services } = createTestServices({
    workspace: workspacePath.toString(),
    context: {
      ...WithFileSystem(),
    },
  })

  const fs = services.shared.workspace.FileSystemProvider
  vi.spyOn(fs, 'readDirectory').mockResolvedValue([{
    isDirectory: false,
    isFile: true,
    uri: documentUri,
  }])
  vi.spyOn(fs, 'readFile').mockImplementation((uri) => vol.promises.readFile(uri.fsPath, 'utf-8') as any)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data) => {
    vol.writeFileSync(path.fsPath, data, { encoding: 'utf-8' })
  })

  await initialize()

  function readFromMemory() {
    const doc = services.shared.workspace.LangiumDocuments.getDocument(documentUri)
    return doc?.textDocument?.getText() ?? undefined
  }

  function readFromFS() {
    return vol.readFileSync(documentUri.fsPath, 'utf-8')
  }

  async function change(params: ChangeView.Params) {
    await services.likec4.ModelChanges.applyChange(params)
    return readFromMemory()
  }

  function read() {
    const memoryContent = readFromMemory()
    expect(memoryContent).toBeDefined()
    const fsContent = readFromFS()
    expect(fsContent).toBeDefined()
    expect(memoryContent, 'Memory and FS content should be equal').toEqual(fsContent)
    return memoryContent!
  }

  return { change, read, fs, services }
}
```

In `viewChange.spec.ts` replace the removed lines with:

```ts
import { describe, it, vi } from 'vitest'
import { testDoc } from './__tests__/testDoc'

vi.mock('node:fs')
vi.mock('node:fs/promises')
```

- [ ] **Step 2: Run the full existing spec**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model-change/viewChange.spec.ts
```
Expected: all ~20 tests PASS unchanged (pure refactor).

- [ ] **Step 3: Commit**

```bash
pnpm fmt && git add -A packages/language-server && git commit -m "refactor(language-server): extract shared testDoc harness for model-change specs"
```

---

### Task 3: Extract `propertyEdits` shared helpers

**Files:**
- Create: `packages/language-server/src/model-change/propertyEdits.ts`
- Modify: `packages/language-server/src/model-change/viewChange.ts` (delete lines 97–332, re-import from the new module)

**Interfaces:**
- Consumes: `ops`, `printOperation`, `materialize`, `withctx`, `indent`, `newline`, `print`, `AnyOp` from `@likec4/generators/likec4`; `ast` from `../ast`.
- Produces (used by Tasks 5 and by refactored `viewChange.ts`):

```ts
// A node whose body has props with $cstNode — both ast.LikeC4View and ast.Element satisfy this
export type WithPropsBody = {
  body?: {
    $cstNode?: ast.LikeC4View['$cstNode']
    // key is OPTIONAL: ElementProperty includes MetadataProperty which has no
    // `key` assignment — Array<ElementProperty> is not assignable otherwise
    props: Array<{ key?: string | undefined; $cstNode?: ast.LikeC4View['$cstNode'] }>
    tags?: ast.Tags
  } | undefined
}
export function findExistingProperty(node: PropsBodyNode, key: string): (prop & { $cstNode: CstNode }) | undefined
export function findInsertPosition(node: PropsBodyNode, select: (body) => Position | undefined): Position
export const doubleIndent: (op: AnyOp) => AnyOp
export function updateTitleProperty(node, title: string): TextEdit
export function updateDescriptionProperty(node, description: scalar.MarkdownOrString): TextEdit[]
export function updateTechnologyProperty(node, technology: string): TextEdit
export function updateTags(node, tag: { add?: ...; remove?: ... }): TextEdit[]
```

This task is a behavior-preserving refactor. Its test gate is the EXISTING 20-case
`viewChange.spec.ts` suite staying green with byte-identical snapshots — do not write a new spec
here; element-side behavior gets its own tests in Task 5.

- [ ] **Step 1: Create `propertyEdits.ts` by extraction**

Move from `viewChange.ts` — verbatim except for the generalized type parameter — the following (currently lines 97–332): `PropOf`/`WithCst` types, `findExistingViewProperty` (rename → `findExistingProperty`), `findInsertPosition`, `doubleIndent`, `collectAllTagRefs`, `addTag`, `removeTag`, `updateViewTags` (rename → `updateTags`), `updateViewTitle` (rename → `updateTitleProperty`), `updateViewDescription` (rename → `updateDescriptionProperty`). Generalize the subject type from `ast.LikeC4View` to:

```ts
type PropsBodyNode = {
  $cstNode?: ast.LikeC4View['$cstNode']
  body?: {
    $cstNode?: ast.LikeC4View['$cstNode']
    // key OPTIONAL — ElementProperty includes MetadataProperty (no key assignment);
    // findExistingProperty's `p.key === property` comparison stays sound.
    props: Array<{ key?: string | undefined; $cstNode?: ast.LikeC4View['$cstNode'] }>
    tags?: ast.Tags | undefined
  } | undefined
}
```

Every function that took `viewAst: ast.LikeC4View` now takes `node: PropsBodyNode`. Add one new sibling by copying `updateTitleProperty` and swapping the op:

```ts
export function updateTechnologyProperty(node: PropsBodyNode, technology: string): TextEdit {
  const existing = findExistingProperty(node, 'technology')
  const out = withctx({ technology })(ops.props.technologyProperty())
  if (existing) {
    return TextEdit.replace(existing.$cstNode.range, printOperation(out))
  }
  return TextEdit.insert(
    findInsertPosition(node, body =>
      body.tags?.$cstNode?.range.end
        ?? body.$cstNode?.range.start),
    materialize(doubleIndent(out)).trimEnd(),
  )
}
```

Then rewrite `viewChange.ts` to keep only: `ViewChangePayload`, `preparePayload`, `viewChangeHandler`, `changePropertyHandler` — the latter delegating:

```ts
export const changePropertyHandler = viewChangeHandler(
  'change-property',
  ({ change, viewAst }) => {
    const { title, description } = change
    const edits: TextEdit[] = []
    if (title !== undefined) {
      edits.push(updateTitleProperty(viewAst, title))
    }
    if (description !== undefined) {
      edits.push(...updateDescriptionProperty(viewAst, description))
    }
    if (change.tag !== undefined) {
      edits.push(...updateTags(viewAst, change.tag))
    }
    return edits
  },
)
```

- [ ] **Step 2: Run the regression gate**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model-change
```
Expected: ALL viewChange tests still PASS with byte-identical snapshots — if any snapshot differs, the extraction changed behavior: fix the extraction, never the snapshot.

- [ ] **Step 3: Commit**

```bash
pnpm fmt && git add -A packages/language-server && git commit -m "refactor(language-server): extract property-edit helpers, generalized over element bodies"
```

---

### Task 4: `locateElementAst` on `LikeC4ModelLocator`

**Files:**
- Modify: `packages/language-server/src/model/model-locator.ts` (add method after `getParsedElement`, which is at line 64)
- Test: `packages/language-server/src/model/model-locator.spec.ts` (create or extend if exists)

**Interfaces:**
- Consumes: existing `getParsedElement(fqn, projectId?)` → `{ projectId, element: ParsedAstElement, document } | null`; `services.workspace.AstNodeLocator.getAstNode(root, astPath)` (same pattern as `locateRelation` at line 149).
- Produces (used by Tasks 5, 6):

```ts
public locateElementAst(fqn: c4.Fqn, projectId?: c4.ProjectId): null | {
  doc: ParsedLikeC4LangiumDocument
  element: ParsedAstElement
  elementAst: ast.Element
}
```

- [ ] **Step 0: Install the new dependency FIRST**

Add `"@mantine/notifications": "catalog:mantine"` to `packages/diagram/package.json` dependencies, then:

```bash
pnpm install
```
Without this, every subsequent vitest/typecheck step fails with `Cannot find module '@mantine/notifications'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/language-server/src/model/model-locator.spec.ts
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
    const { services } = await testDoc(expect, `specification { element system }
      model { sys = system 'S' }`)
    expect(services.likec4.ModelLocator.locateElementAst('nope' as any)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model/model-locator.spec.ts
```
Expected: FAIL — `locateElementAst is not a function`.

- [ ] **Step 3: Implement**

Add to `LikeC4ModelLocator` (import `ast` and `ParsedLikeC4LangiumDocument` already imported in the file):

```ts
/**
 * Like {@link locateViewAst}, but for model elements:
 * resolves an FQN to its declaring document and live AST node.
 */
public locateElementAst(fqn: c4.Fqn, projectId?: c4.ProjectId): null | {
  doc: ParsedLikeC4LangiumDocument
  element: ParsedAstElement
  elementAst: ast.Element
} {
  const found = this.getParsedElement(fqn, ...(projectId ? [projectId] as const : [] as const))
  if (!found) {
    return null
  }
  const elementAst = this.services.workspace.AstNodeLocator.getAstNode<ast.Element>(
    found.document.parseResult.value,
    found.element.astPath,
  )
  if (!elementAst) {
    return null
  }
  return {
    doc: found.document as ParsedLikeC4LangiumDocument,
    element: found.element,
    elementAst,
  }
}
```

Note: match the actual `getParsedElement` overload style in the file (it accepts `[fqn]` or `[fqn, projectId]` — call it accordingly). If `this.services.workspace` is not how the locator reaches `AstNodeLocator`, mirror EXACTLY how `locateRelation` (line 149) obtains it.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model/model-locator.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/language-server && git commit -m "feat(language-server): add ModelLocator.locateElementAst"
```

---

### Task 5: `changeElementProperty` handler

**Files:**
- Create: `packages/language-server/src/model-change/changeElementProperty.ts`
- Modify: `packages/language-server/src/model-change/__tests__/testDoc.ts` (add `changeModel`/`changeModelRaw` wrappers, Step 1)
- Modify: `packages/language-server/src/model-change/ModelChanges.ts` (minimal dispatch, Step 4)
- Test: `packages/language-server/src/model-change/changeElementProperty.spec.ts`

**Interfaces:**
- Consumes: `ModelChange.ChangeElementProperty` (Task 1), `locateElementAst` (Task 4), `updateTitleProperty` / `updateDescriptionProperty` / `updateTechnologyProperty` / `updateTags` / `findInsertPosition` (Task 3).
- Produces (used by Task 6):

```ts
export function changeElementProperty(
  services: LikeC4Services,
  args: {
    doc: ParsedLikeC4LangiumDocument
    elementAst: ast.Element
    change: ModelChange.ChangeElementProperty
  },
): { edits: TextEdit[]; modifiedRange: Range; warnings: string[] }
```

- [ ] **Step 1: Write the failing tests (this is the behavioral contract — write them all)**

```ts
// packages/language-server/src/model-change/changeElementProperty.spec.ts
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

  it('escapes quotes in written values', async ({ expect }) => {
    const { changeModel, read } = await testDoc(
      expect,
      `${SPEC}
      model {
        sys = system 'S' {
        }
      }`,
    )
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, title: "Bob's API" } })
    const first = read()
    // must re-parse: a second edit through the full pipeline proves validity
    await changeModel({ change: { op: 'change-element-property', target: 'sys' as any, technology: 'k8s' } })
    const text = read()
    expect(text).toContain('k8s')
    expect(first).not.toContain("'Bob's API'") // naive unescaped form is invalid DSL
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
    expect(read()).toMatchInlineSnapshot() // filled by vitest: body braces created, title inside
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
    expect(res.success).toBe(true)
    expect(res.warnings ?? []).toEqual([
      expect.stringContaining('alpha'),
    ])
  })
})
```

Note: `changeModel` / `changeModelRaw` come from the harness extension in Task 6. To keep this task independently testable, ALSO add them to the harness NOW as thin wrappers that will call `services.likec4.ModelChanges.applyModelChange(params)`:

```ts
// append inside testDoc() in __tests__/testDoc.ts, next to change():
async function changeModelRaw(params: { change: import('@likec4/core').ModelChange; projectId?: string }) {
  return await (services.likec4.ModelChanges as any).applyModelChange(params)
}
async function changeModel(params: { change: import('@likec4/core').ModelChange; projectId?: string }) {
  const res = await changeModelRaw(params)
  if (!res.success) throw new Error(res.error)
  return readFromMemory()
}
// and add changeModel, changeModelRaw to the returned object
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model-change/changeElementProperty.spec.ts
```
Expected: FAIL — `applyModelChange is not a function` (Task 6 wires the dispatcher; implement the handler in Step 3 and a MINIMAL private dispatch in Step 4 so this task is self-contained).

- [ ] **Step 3: Implement the handler**

```ts
// packages/language-server/src/model-change/changeElementProperty.ts
import { type ModelChange, nonNullable } from '@likec4/core'
import { type Range, Position, TextEdit } from 'vscode-languageserver-types'
import { type ParsedLikeC4LangiumDocument, ast } from '../ast'
import type { LikeC4Services } from '../module'
import {
  updateDescriptionProperty,
  updateTags,
  updateTechnologyProperty,
  updateTitleProperty,
} from './propertyEdits'

/**
 * Union of every edit range — reported back as `location` (same convention
 * as changeElementStyle's modifiedRange).
 */
function includeRanges(edits: TextEdit[]): Range {
  const first = nonNullable(edits[0], 'at least one edit required')
  let { start, end } = first.range
  for (const e of edits.slice(1)) {
    if (e.range.start.line < start.line) start = e.range.start
    if (e.range.end.line > end.line) end = e.range.end
  }
  return { start, end }
}

/**
 * If the element was declared braceless (`sys = system 'S'`), we must create
 * a body. All property values are printed via the generators' ops combinators —
 * NEVER hand-rolled template strings (no escaping, breaks on quotes/markdown).
 * `change.tag.remove` is a no-op on this path (braceless element has no tags).
 */
function bracelessBodyEdit(
  elementAst: ast.Element,
  change: ModelChange.ChangeElementProperty,
): TextEdit {
  const cst = nonNullable(elementAst.$cstNode, 'element cst')
  const indentUnit = ' '.repeat(cst.range.start.character)
  const inner = indentUnit + '  '
  const parts: string[] = []
  const tagsToAdd = change.tag?.add
    ? (Array.isArray(change.tag.add) ? change.tag.add : [change.tag.add])
    : []
  if (tagsToAdd.length > 0) {
    parts.push(printOperation(withctx({ tags: tagsToAdd }, ops.props.tagsProperty())))
  }
  if (change.title !== undefined) {
    parts.push(printOperation(withctx({ title: change.title }, ops.props.titleProperty())))
  }
  if (change.technology !== undefined) {
    parts.push(printOperation(withctx({ technology: change.technology }, ops.props.technologyProperty())))
  }
  if (change.description !== undefined) {
    parts.push(printOperation(withctx({ description: change.description }, ops.props.descriptionProperty())))
  }
  const body = parts
    .flatMap(p => p.split('\n'))
    .map(line => inner + line)
    .join('\n')
  return TextEdit.insert(cst.range.end, ' {\n' + body + '\n' + indentUnit + '}')
}
// imports needed: { ops, printOperation, withctx } from '@likec4/generators/likec4'

/**
 * Positional title handling: grammar allows `sys = system 'Title' { ... }`
 * where the positional string OVERRIDES any body `title` property (see
 * ModelParser Base.ts:598). Editing the title must therefore DELETE the
 * positional literal (its CST node is `elementAst.props[0]`), then upsert the
 * body property. Declaration style changes (`= system 'T'` → `= system` +
 * body title) — accepted trade-off: reuses vetted printers, adds zero
 * escaping code, and is idempotent on the second edit.
 */
function removePositionalTitle(elementAst: ast.Element): TextEdit | undefined {
  const positional = elementAst.props?.[0]
  if (!positional?.$cstNode) {
    return undefined
  }
  // delete from end of the previous token (kind or name) to the literal's end
  return TextEdit.del(positional.$cstNode.range)
}

export function changeElementProperty(
  services: LikeC4Services,
  { doc, elementAst, change }: {
    doc: ParsedLikeC4LangiumDocument
    elementAst: ast.Element
    change: ModelChange.ChangeElementProperty
  },
): { edits: TextEdit[]; modifiedRange: Range; warnings: string[] } {
  const warnings = collectExtendTagWarnings(doc, change)

  if (!elementAst.body) {
    const edit = bracelessBodyEdit(elementAst, change)
    return { edits: [edit], modifiedRange: edit.range, warnings }
  }

  const edits: TextEdit[] = []
  if (change.title !== undefined) {
    const dropPositional = removePositionalTitle(elementAst)
    if (dropPositional) {
      edits.push(dropPositional)
    }
    edits.push(updateTitleProperty(elementAst, change.title))
  }
  if (change.description !== undefined) {
    edits.push(...updateDescriptionProperty(elementAst, change.description))
  }
  if (change.technology !== undefined) {
    edits.push(updateTechnologyProperty(elementAst, change.technology))
  }
  if (change.tag !== undefined) {
    edits.push(...updateTags(elementAst, change.tag))
  }
  return { edits, modifiedRange: includeRanges(edits), warnings }
}

/**
 * Detect tags that already arrive through `extend <fqn> { #tag }` in any
 * document of the project — the edit still applies (tags dedupe on merge),
 * but the user should know the tag is ALSO set elsewhere.
 */
function collectExtendTagWarnings(
  doc: ParsedLikeC4LangiumDocument,
  change: ModelChange.ChangeElementProperty,
): string[] {
  const toAdd = change.tag?.add
    ? (Array.isArray(change.tag.add) ? change.tag.add : [change.tag.add])
    : []
  if (toAdd.length === 0) return []
  const warnings: string[] = []
  for (const ext of doc.c4ExtendElements ?? []) {
    if (ext.id !== change.target) continue
    for (const tag of toAdd) {
      if (ext.tags?.includes(tag)) {
        warnings.push(`Tag #${tag} is already added to ${change.target} via an extend block`)
      }
    }
  }
  return warnings
}
```

IMPORTANT adaptation notes for the implementer: (a) the exact grammar assignment holding the positional title on `ast.Element` must be verified in `packages/language-server/src/generated/ast.ts` (grammar `like-c4.langium:126-138` assigns positional strings to `props`; if the generated property differs, adjust `removePositionalTitle` — the parser precedence code to mirror is `Base.ts:598`); (b) the exact field names on `ParsedAstExtend` (`ext.id`, `ext.tags`) must be checked against `packages/language-server/src/ast.ts:100-106` and adjusted; the parsed extend records live per-document on `doc.c4ExtendElements`. For cross-document detection, iterate `services.shared.workspace.LangiumDocuments.projectDocuments(projectId)` instead of just `doc` — do this if the accessor is readily available on the services object (it is: `LangiumDocuments` from `../workspace/LangiumDocuments`), passing `projectId` through from the dispatcher in Task 6.

- [ ] **Step 4: Minimal dispatch to make tests runnable (completed properly in Task 6)**

Add to `LikeC4ModelChanges` (`ModelChanges.ts`), after `applyChange`:

```ts
public async applyModelChange(params: {
  change: import('@likec4/core').ModelChange
  projectId?: string | undefined
}): Promise<
  { success: true; location: import('vscode-languageserver-types').Location | null; warnings?: string[] }
  | { success: false; error: string }
> {
  const workspace = this.services.shared.workspace
  try {
    const project = workspace.ProjectsManager.ensureProject(params.projectId as ProjectId)
    const change = params.change
    switch (change.op) {
      case 'change-element-property': {
        const located = this.locator.locateElementAst(change.target, project.id)
        if (!located) {
          throw new Error(`Element ${change.target} not found in project ${project.id}`)
        }
        const { edits, modifiedRange, warnings } = changeElementProperty(this.services, {
          doc: located.doc,
          elementAst: located.elementAst,
          change,
        })
        if (!edits.length) {
          return { success: false, error: 'No changes to apply' }
        }
        const applied = await this.applyTextEdits(located.doc, edits)
        if (!applied) {
          return { success: false, error: 'Failed to apply changes' }
        }
        return {
          success: true,
          location: { uri: located.doc.textDocument.uri, range: modifiedRange },
          ...(warnings.length > 0 && { warnings }),
        }
      }
      default:
        nonexhaustive(change.op)
    }
  } catch (err) {
    const error = loggable(wrapError(err, `Failed to apply model change ${params.change.op}`))
    logger.warn(error)
    return { success: false, error }
  }
}
```

(Import `changeElementProperty` at top. `nonexhaustive`, `loggable`, `wrapError`, `logger` already imported in the file.)

- [ ] **Step 5: Run to verify pass, fill inline snapshots deliberately**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model-change
```
Expected: all new tests PASS (review the filled `toMatchInlineSnapshot` for the braceless case — the body must be `{\n  title 'Renamed'\n}` attached after the element, correctly indented), all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
pnpm fmt && git add -A packages/language-server && git commit -m "feat(language-server): change-element-property op with extend-tag warnings"
```

---

### Task 6: `ChangeModel` protocol, version guard, LSP registration

**Files:**
- Modify: `packages/language-server/src/protocol.ts` (add `ChangeModel` namespace next to `ChangeView` at line 283)
- Modify: `packages/language-server/src/Rpc.ts` (register handler next to the `ChangeView` registration at ~line 330)
- Modify: `packages/language-server/src/model-change/ModelChanges.ts` (formalize Task 5's dispatch + version guard on BOTH apply paths)
- Test: extend `packages/language-server/src/model-change/changeElementProperty.spec.ts`

**Interfaces:**
- Produces (used by Task 7):

```ts
export namespace ChangeModel {
  export type Params = {
    change: ModelChange
    projectId?: string | undefined
    changeId?: string | undefined
  }
  export type Res =
    | { success: true; location: Location | null; changeId?: string; warnings?: string[] }
    | { success: false; error: string; changeId?: string }
  export const req = new RequestType<Params, Res, void>('likec4/change-model')
}
```
- `ChangeView.Params` gains optional `changeId?: string`; `ChangeView.Res` success/failure variants gain optional `changeId?: string` (echoed back verbatim).

- [ ] **Step 1: Write the failing version-guard test**

Append to `changeElementProperty.spec.ts`:

```ts
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
  expect(res.error).toContain('changed')
})
```

Implementer note: if `_version` is not writable on the TextDocument implementation, instead simulate by calling `TextDocument.update(doc.textDocument, [], doc.textDocument.version + 1)` (imported from `langium`) — pick whichever mutates version in this Langium version and keep the assertion identical.

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — guard not implemented (apply succeeds).

- [ ] **Step 3: Implement guard + protocol + registration**

In `ModelChanges.ts`:

1. Change `applyTextEdits` signature to `applyTextEdits(doc, edits, expectedVersion?: number)`. First line:

```ts
if (expectedVersion !== undefined && doc.textDocument.version !== expectedVersion) {
  // THROW (not `return false`): the callers' try/catch converts this into
  // {success:false, error} with THIS message — a plain false is
  // indistinguishable from an applyEdit failure and would report the wrong error.
  throw new Error('Document changed underneath — retry the edit')
}
```

2. Capture `const expectedVersion = <doc>.textDocument.version` immediately after EVERY locate and pass it to `applyTextEdits`. There are THREE sites: (a) `locateViewAst` in `applyChange` (line 54 area); (b) `locateElementAst` in `applyModelChange`; (c) the `change-property` EARLY-RETURN branch of `applyChange` (lines 26-47) — it locates via `preparePayload(...)` and applies at line 36 without ever reaching the try/catch below, so wrap that branch's apply in its own try/catch (or move the branch inside the existing try) and capture `payload.doc.textDocument.version` right after `preparePayload`. This early-return path is the exact one the spec calls out as unguarded.
3. Thread `changeId` through: `applyChange`/`applyModelChange` read `params.changeId` and include it in every returned `Res` object.

In `protocol.ts`: add the `ChangeModel` namespace exactly as in Interfaces above (mirror `ChangeView`'s `RequestType` import/pattern verbatim), and add `changeId?: string | undefined` to `ChangeView.Params` + both `Res` variants.

In `Rpc.ts`: next to the existing `ChangeView` registration (`onRequest(ChangeView.req, ...)` at ~line 330), add:

```ts
connection.onRequest(ChangeModel.req, async (params) => {
  return await likec4Services.ModelChanges.applyModelChange(params)
})
```

(mirror the exact surrounding style — if the existing registration wraps in cancellation/queue helpers, wrap identically.)

- [ ] **Step 4: Run all language-server model-change + locator tests**

```bash
pnpm --filter @likec4/language-server exec vitest run src/model-change src/model/model-locator.spec.ts
pnpm --filter @likec4/language-server exec tsc --noEmit 2>/dev/null || pnpm typecheck
```
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/language-server && git commit -m "feat(language-server): ChangeModel protocol, changeId echo, document version guard"
```

---

### Task 7: vite-plugin `updateModel` RPC + applied-change tracking

**Files:**
- Create: `packages/vite-plugin/src/rpc/functions/updateModel.ts`
- Modify: `packages/vite-plugin/src/rpc/protocol.ts`
- Modify: `packages/vite-plugin/src/rpc/rpc.ts:22-26`
- Modify: `packages/vite-plugin/src/rpc/functions/updateView.ts`
- Modify: `packages/vite-plugin/src/virtuals/_shared.ts` (extend `SharedVirtualModuleOptions`)
- Modify: `packages/vite-plugin/src/plugin.ts` (instantiate the tracking map where `SharedVirtualModuleOptions` is built)
- Modify: `packages/vite-plugin/src/virtuals/rpc.ts:26-36` (production stub)
- Modify: `packages/vite-plugin/src/modules.d.ts` (ambient type for `likec4:rpc` gains `updateModel`)

**Interfaces:**
- Consumes: `LikeC4.editor.applyModelChange` (exists after Task 6 — the `editor` getter on language-services `LikeC4` already exposes `LikeC4ModelChanges`).
- Produces:

```ts
// protocol.ts
updateModel(payload: {
  projectId: ProjectId
  change: ModelChange
  changeId?: string
}): Promise<{ success: boolean; error?: string; warnings?: string[] }>
// updateView return changes from Promise<void> to Promise<{ success: boolean; error?: string }>
// SharedVirtualModuleOptions gains: appliedChanges: Map<string, string> // projectId -> last applied changeId
```

- [ ] **Step 1: Extend shared options + protocol**

In `_shared.ts`, add to `SharedVirtualModuleOptions`: `appliedChanges: Map<string, string>`.

In `plugin.ts`: the options object is built by `moduleopts<T>()` (~line 223-235), **a function invoked on every virtual-module load and once for `enablePluginRPC`** — putting `new Map()` inside its return literal creates a DIFFERENT map per call and the ack mechanism silently never works. Instead declare ONE instance at module/plugin scope, next to `let rpcEnabled = false` (~line 196):

```ts
const appliedChanges = new Map<string, string>()
```

and spread that same instance into `moduleopts`'s returned object (`appliedChanges,`).

In `rpc/protocol.ts`, add `ModelChange` to the type import from `@likec4/core/types` and add the `updateModel` signature; change `updateView`'s return type to `Promise<{ success: boolean; error?: string }>`.

- [ ] **Step 2: Implement `updateModel` + record applied changes**

```ts
// packages/vite-plugin/src/rpc/functions/updateModel.ts
import k from 'tinyrainbow'
import type { LikeC4VitePluginRpc } from '../protocol'
import type { PluginRPCParams } from '../rpc'

export async function updateModel(
  params: PluginRPCParams,
  data: Parameters<LikeC4VitePluginRpc['updateModel']>[0],
): Promise<Awaited<ReturnType<LikeC4VitePluginRpc['updateModel']>>> {
  const { logger, likec4, appliedChanges } = params
  logger.info([
    k.green('model:onChange'),
    k.dim('project'),
    data.projectId,
    k.dim('change'),
    data.change.op,
  ].join(' '))
  // Record BEFORE applying: DocumentBuilder.update (inside applyModelChange) is
  // what triggers regeneration of likec4:model/<project>, which READS this map.
  // Setting after the await races the regeneration and can push a stale ack,
  // stalling the client queue on its escape hatch.
  const prev = data.changeId ? appliedChanges.get(data.projectId) : undefined
  if (data.changeId) {
    appliedChanges.set(data.projectId, data.changeId)
  }
  const result = await likec4.editor.applyModelChange({
    change: data.change,
    projectId: data.projectId,
    changeId: data.changeId,
  })
  if (!result.success) {
    if (data.changeId) {
      prev === undefined ? appliedChanges.delete(data.projectId) : appliedChanges.set(data.projectId, prev)
    }
    logger.error(`Failed to apply model change:\n${result.error}`)
    return { success: false, error: result.error }
  }
  logger.info([k.green('model:onChange'), '✅'].join(' '))
  return { success: true, ...(result.warnings && { warnings: result.warnings }) }
}
```

In `rpc.ts` register it: `updateModel: (data) => updateModel(params, data),`.

In `updateView.ts`: change to return `{ success: boolean; error?: string }` instead of throwing (keep the error log), record `changeId` with the same set-before-await + revert-on-failure pattern as `updateModel`, and pass `changeId` through to `likec4.editor.applyChange(data)` (the field flows inside `data` once added to the payload type). NOTE (intentional behavior change): `updateView` no longer throws, so birpc's `onFunctionError` → `sendError` Vite error overlay no longer fires for failed view changes — Task 10's notification replaces it. Keep the `logger.error`.

In `virtuals/rpc.ts` production stub object, add:

```ts
updateModel: () => {
  throw new Error('likec4rpc.updateModel is not available in production')
},
```

`modules.d.ts` needs NO change for the rpc module — it declares `export const likec4rpc: LikeC4VitePluginRpc` wholesale (line ~174-178), so extending `rpc/protocol.ts` suffices.

- [ ] **Step 3: Write the unit spec (vitest infra EXISTS in this package — see src/virtuals/*.spec.ts)**

```ts
// packages/vite-plugin/src/rpc/functions/updateModel.spec.ts
import { describe, expect, it } from 'vitest'
import { updateModel } from './updateModel'

const params = (applyModelChange: any) => ({
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
```

Run + typecheck:

```bash
pnpm --filter @likec4/vite-plugin exec vitest run src/rpc
pnpm exec tsc --build packages/core packages/language-server; pnpm --filter @likec4/vite-plugin typecheck
```
Expected: PASS + clean.

- [ ] **Step 4: Commit**

```bash
pnpm fmt && git add -A packages/vite-plugin && git commit -m "feat(vite-plugin): updateModel RPC and applied-change tracking"
```

---

### Task 8: Ack plumbing — `$appliedChangeId` from model module to diagram

**Files:**
- Modify: `packages/vite-plugin/src/virtuals/model.ts:6-32`
- Modify: `packages/vite-plugin/src/modules.d.ts` (BOTH: the `declare module 'likec4:model/*'` block at ~125-140 gains `$appliedChangeId: ReadableAtom<string | null>`, AND the `loadModel` return type at ~45-51 gains the same)
- Modify: `packages/likec4-spa/src/routes/_single/route.tsx` (loader returns `$appliedChangeId`)
- Modify: `packages/likec4-spa/src/routes/project.$projectId/route.tsx` (same)
- Modify: `packages/likec4-spa/src/context/safeCtx.ts` (second context + `useAppliedChangeIdAtom`)
- Modify: `packages/likec4-spa/src/context/LikeC4ModelContext.tsx` (accept + provide the atom)
- Modify: `packages/likec4-spa/src/pages/ViewEditor.tsx` (`useStore` + pass prop)
- Modify: `packages/diagram/src/LikeC4Diagram.props.ts` (add optional prop) and `packages/diagram/src/LikeC4Diagram.tsx` (pass into `<DiagramActorProvider>`)
- Modify: `packages/diagram/src/likec4diagram/state/DiagramActorProvider.tsx:88-97` (the `useUpdateEffect` that sends `update.inputs` — THIS is where inputs enter the machine, not LikeC4Diagram)
- Modify: `packages/diagram/src/likec4diagram/state/machine.setup.ts` (`Input` at ~line 74 gains `appliedChangeId?: string | null` — `Context extends Input` at ~line 91, and the `update.inputs` event type at ~line 227 is `Partial<Omit<Input, 'view'|'xystore'|'dynamicViewVariant'|'features'>>`, so the new field is automatically included; `machine.actions.ts:157-161` `updateInputs()` does `exact({...event.inputs})` — no per-field merge needed)
- Modify: `packages/diagram/src/likec4diagram/state/machine.actions.ts:622-630` (`sendSynced` carries it)
- Modify: `packages/diagram/src/editor/actor/types.ts:13` (`view.synched` gains `changeId?`)

**Interfaces:**
- Consumes: `appliedChanges` map (Task 7).
- Produces: `view.synched` events carry `changeId: string | null`; `LikeC4Diagram` accepts optional `appliedChangeId?: string | null`. Used by Task 9a's queue matching.

- [ ] **Step 1: Embed in the generated model module**

In `virtuals/model.ts`, change `projectModelCode` to accept and embed the applied change id, and export it as an atom that HMR updates:

```ts
const projectModelCode = (model: LikeC4Model.Layouted, appliedChangeId: string | null) => `
import { createHooksForModel, atom } from 'likec4/vite-plugin/internal'

export let $likec4data = atom(${JSON5.stringify(model.$data)})
export let $appliedChangeId = atom(${JSON5.stringify(appliedChangeId)})

export let {
  updateModel,
  $likec4model,
  useLikeC4Model,
  useLikeC4Views,
  useLikeC4View
} = createHooksForModel($likec4data)

if (import.meta.hot) {
  import.meta.hot.accept(md => {
    if (!import.meta.hot.data.$update) {
      import.meta.hot.data.$update = updateModel
    }
    if (!import.meta.hot.data.$ackUpdate) {
      import.meta.hot.data.$ackUpdate = (v) => $appliedChangeId.set(v)
    }
    const update = md.$likec4data?.get()
    if (update) {
      import.meta.hot.data.$update(update)
      import.meta.hot.data.$ackUpdate(md.$appliedChangeId?.get() ?? null)
    } else {
      import.meta.hot.invalidate()
    }
  })
}
`
```

And in `load()`: `code: projectModelCode(model, project ? (opts.appliedChanges.get(project.id) ?? null) : null)` — match the actual `load({ likec4, project, ...opts })` destructuring in the file; the shared options carry `appliedChanges` (Task 7). Also update the ambient declaration for `likec4:model` in `modules.d.ts` to export `$appliedChangeId: ReadableAtom<string | null>`.

- [ ] **Step 2: Thread through the SPA (the model module is ONLY reachable via `loadModel(projectId)` in two route loaders)**

1. `src/routes/_single/route.tsx` and `src/routes/project.$projectId/route.tsx`: both loaders already do `const likec4model = await loadModel(projectId)` (or equivalent destructure). Add `$appliedChangeId` to what the loader returns, next to the existing model atom.
2. `src/context/safeCtx.ts`: add a second context following the existing `LikeC4ModelDataContextProvider`/`useLikeC4ModelAtom` pattern verbatim:

```tsx
const AppliedChangeIdContext = createContext<ReadableAtom<string | null> | null>(null)
export const AppliedChangeIdProvider = AppliedChangeIdContext.Provider
export function useAppliedChangeIdAtom(): ReadableAtom<string | null> {
  return nonNullable(useContext(AppliedChangeIdContext), 'No AppliedChangeIdContext')
}
```

3. `LikeC4ModelContext.tsx`: accept `appliedChangeId: ReadableAtom<string | null>` as a prop and wrap children in `<AppliedChangeIdProvider value={appliedChangeId}>`; the two route files pass the loader value in where they render `<LikeC4ModelContext>`.
4. `ViewEditor.tsx`:

```tsx
import { useStore } from '@nanostores/react'
// inside ViewEditor():
const appliedChangeId = useStore(useAppliedChangeIdAtom())
// pass to diagram:
<LikeC4Diagram
  appliedChangeId={appliedChangeId}
  ...
```

- [ ] **Step 3: Diagram prop → machine context → sendSynced**

- `LikeC4Diagram.props.ts`: add `appliedChangeId?: string | null | undefined` with JSDoc "Ack token of the last server-applied change; used by the editor sync queue".
- `LikeC4Diagram.tsx`: pass the prop into `<DiagramActorProvider appliedChangeId={...}>` (~line 193-203).
- `DiagramActorProvider.tsx`: include `appliedChangeId` in the initial machine `input` AND in the `useUpdateEffect` at lines 88-97 that sends `update.inputs` on prop changes.
- `machine.setup.ts`: add `appliedChangeId?: string | null` to `Input` (~line 74). `Context extends Input` (~line 91) picks it up; the `update.inputs` event type (~line 227) includes it automatically (it is not in the `Omit` list); `updateInputs()` in `machine.actions.ts:157-161` already spreads `exact({...event.inputs})` — no merge code needed.
- `machine.actions.ts` `sendSynced` (line 622):

```ts
export const sendSynced = () => {
  if (import.meta.env.DEV) {
    console.log('sendSynced')
  }
  return machine.sendTo(
    typedSystem.editorActor,
    ({ context }) => ({
      type: 'view.synched' as const,
      changeId: context.appliedChangeId ?? null,
    }),
  )
}
```

- `editor/actor/types.ts` line 13: `| { type: 'view.synched'; changeId?: string | null }`.

- [ ] **Step 4: Typecheck everything touched**

```bash
pnpm exec tsc --build packages/core
pnpm --filter @likec4/diagram typecheck && pnpm --filter @likec4/vite-plugin typecheck && pnpm --filter @likec4/spa typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/vite-plugin packages/likec4-spa packages/diagram && git commit -m "feat: thread appliedChangeId ack from server through model module to diagram"
```

---

### Task 9a: Sync queue — `QueuedChange` ack tokens replace the 2s timer (ViewChange-only)

**Files:**
- Modify: `packages/diagram/src/editor/actor/types.ts` (`QueuedChange`, guards, `awaitingAck`, `view.synched {changeId}`)
- Modify: `packages/diagram/src/editor/actor/actions.ts` (`pushToSyncQueue` unwrapped comparisons, `isLayoutChangeOp`/`withoutSnapshotChanges` at lines 42-49, `newChangeId`)
- Modify: `packages/diagram/src/editor/actor/state.sync-queue.ts` (wrap BOTH `makeSnapshot` injection sites at lines 140-141 and 193-195, invariant at line 204, `executeChanges` input/onDone, `waitViewSynced`)
- Modify: `packages/diagram/src/editor/actor/machine.ts` (init `awaitingAck: []`)
- Modify: `packages/diagram/src/editor/actor/setup.ts` (`ExecuteChange` types)
- Modify: `packages/diagram/src/editor/useEditorActorLogic.ts` (`meta.changeId` on `handleChange`, keep the `if (!port)` guard)
- Modify: `packages/diagram/src/editor/LikeC4EditorCallbacks.tsx` (optional `meta` third param on `handleChange`)
- Modify: `packages/likec4-spa/src/pages/ViewEditor.tsx` (`handleChange` forwards `changeId`, checks `.success`)
- Test: `packages/diagram/src/editor/actor/state.sync-queue.spec.ts` (create)

**Interfaces:**
- Consumes: `view.synched {changeId?}` (Task 8).
- Produces — the contract 9b and later phases build on:

```ts
// types.ts
export type QueuedChange = { changeId: string; change: t.ViewChange | t.ModelChange }
// STRUCTURAL guard — 'changeId' in op — so a raw ViewChange assigned anywhere
// becomes a TYPE ERROR instead of silently passing:
export const isQueuedChange = (op: SyncOp | null): op is QueuedChange =>
  op !== null && typeof op !== 'string' && 'changeId' in op
export type SyncOp = QueuedChange | 'sync-snapshot' | 'apply-semantic-layout' | 'apply-latest-to-manual'
// context additions:
awaitingAck: string[]
// actions.ts — NOT crypto.randomUUID(): undefined on http://<LAN-IP> (likec4 start --host)
let seq = 0
export const newChangeId = () => `c${Date.now().toString(36)}-${++seq}`

// LikeC4EditorCallbacks — optional third param, vscode-preview untouched:
handleChange(viewId: t.ViewId, change: t.ViewChange, meta?: { changeId: string }): void | Promise<void>

// EditorCalls.ExecuteChange:
Input = { viewId: t.ViewId; changes: QueuedChange[] }
Output = {
  requested: QueuedChange[]
  applied: QueuedChange[]
  failed: Array<{ item: QueuedChange; error: string }>
  warnings: string[]  // populated by 9b; always [] here
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/diagram/src/editor/actor/state.sync-queue.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise } from 'xstate'
import { editorActorLogic } from './machine'

afterEach(() => {
  vi.useRealTimers()
})

function makeActor(executeChangeImpl: (input: any) => Promise<any>) {
  const logic = editorActorLogic.provide({
    actors: {
      executeChange: fromPromise(({ input }) => executeChangeImpl(input)),
      applyLatest: fromPromise(async () => ({ updated: {} as any })),
      applySemanticLayout: fromPromise(async () => ({})),
      // NOTE: Task 10 adds a `refetchView` actor to setup.ts — when implementing
      // Task 10, extend this helper to also provide it.
    },
  })
  return createActor(logic, { input: { viewId: 'index' as any }, systemId: 'editor' })
}

describe('sync queue ack discipline', () => {
  it('waits for matching view.synched changeId instead of a 2s timer', async () => {
    vi.useFakeTimers()
    let resolveRpc!: (v: any) => void
    const executed: any[] = []
    const actor = makeActor(async (input) => {
      executed.push(input)
      return await new Promise(r => (resolveRpc = r))
    })
    actor.start()
    actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'TB' } } as any })

    await vi.advanceTimersByTimeAsync(10)
    expect(executed).toHaveLength(1)
    const changeId = executed[0].changes[0].changeId
    expect(changeId).toBeTypeOf('string')

    resolveRpc({ requested: executed[0].changes, applied: executed[0].changes, failed: [], warnings: [] })
    await vi.advanceTimersByTimeAsync(10)

    // a NON-matching ack must NOT release the queue (old 2000ms fallback would have)
    actor.send({ type: 'view.synched', changeId: 'someone-else' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(actor.getSnapshot().matches({ syncQueue: { process: 'waitViewSynced' } })).toBe(true)

    actor.send({ type: 'view.synched', changeId })
    await vi.advanceTimersByTimeAsync(10)
    expect(actor.getSnapshot().matches({ syncQueue: 'idle' })).toBe(true)
  })

  it('does not start the second op before the first is acked (the #2975 duplicate-insert class)', async () => {
    vi.useFakeTimers()
    const invocations: string[][] = []
    let release!: (v: any) => void
    const actor = makeActor(async (input) => {
      invocations.push(input.changes.map((c: any) => c.changeId))
      return await new Promise(r => (release = r))
    })
    actor.start()
    actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'TB' } } as any })
    await vi.advanceTimersByTimeAsync(10)
    actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'LR' } } as any })
    await vi.advanceTimersByTimeAsync(3000)
    // second op queued, NOT executed against un-acked state
    expect(invocations).toHaveLength(1)
    release({ requested: [], applied: [], failed: [], warnings: [] })
    await vi.advanceTimersByTimeAsync(10)
    actor.send({ type: 'view.synched', changeId: null })
    await vi.advanceTimersByTimeAsync(10)
    expect(invocations.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @likec4/diagram exec vitest run src/editor/actor/state.sync-queue.spec.ts
```
Expected: FAIL — no changeId on executed changes; waitViewSynced released at 2000ms.

- [ ] **Step 3: Implement**

1. `types.ts`: apply the Interfaces block. Keep `isViewChange` only as `isQueuedChange` alias if it reduces churn, but the STRUCTURAL check (`'changeId' in op`) is mandatory — it is what turns un-wrapped assignments into compile errors. Add `awaitingAck: string[]` to `EditorActorContext`; init `awaitingAck: []` in `machine.ts:12-20`.
2. `actions.ts`:
   - Add `newChangeId` (see Interfaces — counter, NOT `crypto.randomUUID`).
   - `pushToSyncQueue`: build `nextOp = { changeId: newChangeId(), change: event.change }` for `change.view`. CRITICAL — the existing coalescing compares by identity and MUST be rewritten to unwrap: `syncQueue[0] === nextOp` → compare `.change` references where both are `QueuedChange` (`isQueuedChange(a) && isQueuedChange(b) && a.change === b.change`); `isLayoutChangeOp(existingOp)` → `isLayoutChangeOp(isQueuedChange(existingOp) ? existingOp.change : existingOp)`. String sentinels keep identity comparison. Update `isLayoutChangeOp`/`withoutSnapshotChanges` signatures (lines 42-49) accordingly.
   - `makeSnapshot` callers own the wrapping (next point) — `makeSnapshot` itself is unchanged.
3. `state.sync-queue.ts` — the TWO raw-injection sites both critics flagged:
   - Line 140-141 (`peekFromQueue`): `head = { changeId: newChangeId(), change: makeSnapshot(system).change }`.
   - Line 193-195 (`applyLatestToManual` entry): `processing: { changeId: newChangeId(), change: makeSnapshot(system).change }`.
   - Line 204 invariant: `invariant(isQueuedChange(current) && current.change.op === 'save-view-snapshot')`, and the `input` below reads `current.change.layout`.
   - `executeChanges.invoke.input`: `changes: [processing, ...syncQueue.filter(isQueuedChange)]`.
   - `executeChanges.onDone`: `awaitingAck: event.output.applied.map(i => i.changeId)`; the queue filter keeps identity semantics (wrapper objects are stable): `context.syncQueue.filter(op => !isQueuedChange(op) || !requested.includes(op))`; `lastSyncSnapshot` becomes `findLast(event.output.applied, i => i.change.op === 'save-view-snapshot')` with `.change.layout.bounds`.
   - `waitViewSynced`:

```ts
waitViewSynced: {
  on: {
    'view.synched': [
      {
        guard: ({ context, event }) =>
          event.changeId == null
          || context.awaitingAck.length === 0
          || context.awaitingAck.includes(event.changeId),
        actions: assign({ awaitingAck: [] }),
        target: 'decideNext',
      },
      { actions: log('view.synched with non-matching changeId — keep waiting') },
    ],
  },
  after: {
    // Escape hatch only (server hung / HMR channel dropped) — 8s, not 30s:
    // a stalled drag gesture must not freeze for half a minute.
    8_000: 'decideNext',
  },
},
```

   Rationale for the `event.changeId == null` release: sources that don't thread acks (VSCode preview, `applyLatest`) must not deadlock the queue.
4. `setup.ts`: `ExecuteChange` types per Interfaces (declare `warnings: string[]` now; 9a callers return `[]`).
5. `useEditorActorLogic.ts` `executeChange` — KEEP the existing `if (!port)` guard, then:

```ts
const applied: QueuedChange[] = []
const failed: Array<{ item: QueuedChange; error: string }> = []
for (const item of input.changes) {
  try {
    await promisify(() => port.handleChange(input.viewId, item.change as t.ViewChange, { changeId: item.changeId }))
    applied.push(item)
  } catch (error) {
    failed.push({ item, error: error instanceof Error ? error.message : String(error) })
  }
}
return { requested: input.changes, applied, failed, warnings: [] }
```

6. `LikeC4EditorCallbacks.tsx`: optional `meta` third param on `handleChange` per Interfaces.
7. `ViewEditor.tsx` `handleChange`:

```ts
handleChange: (viewId, change, meta) => {
  return likec4rpc.updateView({ projectId: project.id, viewId, change, changeId: meta?.changeId })
    .then(res => {
      if (res && res.success === false) throw new Error(res.error ?? 'updateView failed')
    })
},
```

- [ ] **Step 4: Run tests + typecheck (the typecheck IS the regression gate for the injection sites)**

```bash
pnpm --filter @likec4/diagram exec vitest run src/editor
pnpm --filter @likec4/diagram typecheck && pnpm --filter @likec4/spa typecheck
```
Expected: both new tests PASS; existing editor tests PASS; typecheck clean — note that before step 3.3 the two `makeSnapshot(system).change` assignments FAIL typecheck (structural `QueuedChange` vs raw `ViewChange`); that failure appearing and then disappearing is the proof the wrap landed.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/diagram packages/likec4-spa && git commit -m "feat(diagram): ack-token sync discipline replaces fixed sync timer"
```

---

### Task 9b: `ModelChange` rides the queue

**Files:**
- Modify: `packages/diagram/src/editor/actor/types.ts` (`change.model` event, `isModelChange` — single source of truth)
- Modify: `packages/diagram/src/editor/actor/actions.ts` (`pushToSyncQueue` accepts `change.model`)
- Modify: `packages/diagram/src/editor/useEditorActorLogic.ts` (model branch + warnings)
- Modify: `packages/diagram/src/editor/LikeC4EditorCallbacks.tsx` (`handleModelChange?`)
- Modify: `packages/diagram/src/likec4diagram/state/diagram-api.ts` (`triggerModelChange`)
- Modify: `packages/diagram/src/likec4diagram/state/machine.ts` + `machine.actions.ts` (route `trigger.model-change` → editor actor, mirroring the existing `trigger.change` action)
- Modify: `packages/likec4-spa/src/pages/ViewEditor.tsx` (`handleModelChange`)
- Test: extend `packages/diagram/src/editor/actor/state.sync-queue.spec.ts`

**Interfaces:**
- Consumes: `QueuedChange` pipeline (9a), `updateModel` RPC (Task 7), `ModelChange` (Task 1).
- Produces:

```ts
// types.ts — ONE discriminator, used everywhere (do not re-declare locally):
export const isModelChange = (c: t.ViewChange | t.ModelChange): c is t.ModelChange =>
  c.op === 'change-element-property'  // extend in later phases
// event:
| { type: 'change.model'; change: t.ModelChange }

// LikeC4EditorCallbacks (optional — vscode-preview untouched):
handleModelChange?: (change: t.ModelChange, meta: { changeId: string }) => void | Promise<void | { warnings?: string[] }>

// DiagramApi:
triggerModelChange(change: t.ModelChange): void
```

- [ ] **Step 0: Install the new dependency FIRST**

Add `"@mantine/notifications": "catalog:mantine"` to `packages/diagram/package.json` dependencies, then:

```bash
pnpm install
```
Without this, every subsequent vitest/typecheck step fails with `Cannot find module '@mantine/notifications'`.

- [ ] **Step 1: Write the failing test**

```ts
it('routes change.model through executeChange', async () => {
  const executed: any[] = []
  const actor = makeActor(async (input) => {
    executed.push(input)
    return { requested: input.changes, applied: input.changes, failed: [], warnings: [] }
  })
  actor.start()
  actor.send({
    type: 'change.model',
    change: { op: 'change-element-property', target: 'sys' as any, title: 'X' },
  })
  await new Promise(r => setTimeout(r, 20))
  expect(executed).toHaveLength(1)
  expect(executed[0].changes[0].change.op).toBe('change-element-property')
  expect(executed[0].changes[0].changeId).toBeTypeOf('string')
})
```

- [ ] **Step 2: Run to verify failure** (`change.model` is an unknown event type)

- [ ] **Step 3: Implement**

1. `types.ts`: add the event and `isModelChange` per Interfaces.
2. `actions.ts` `pushToSyncQueue`: handle `change.model` identically to `change.view` (wrap with `newChangeId()`); the `change.*` wildcard in `state.sync-queue.ts` already routes it to `process`.
3. `useEditorActorLogic.ts` `executeChange` — extend the 9a loop's try block:

```ts
if (isModelChange(item.change)) {
  if (!port.handleModelChange) {
    throw new Error('Editor port does not support model changes')
  }
  const res = await promisify(() => port.handleModelChange!(item.change, { changeId: item.changeId }))
  if (res && Array.isArray(res.warnings)) {
    warnings.push(...res.warnings)
  }
} else {
  await promisify(() => port.handleChange(input.viewId, item.change, { changeId: item.changeId }))
}
```

with `const warnings: string[] = []` collected into the output.
4. `LikeC4EditorCallbacks.tsx`: add optional `handleModelChange` per Interfaces.
5. `diagram-api.ts`: `triggerModelChange(change) { this.send({ type: 'trigger.model-change', change }) }`. Diagram machine: on `'trigger.model-change'` → `sendTo(typedSystem.editorActor, { type: 'change.model', change: event.change })`, mirroring the existing `trigger.change` action in `machine.actions.ts` (omit the `viewportChangedManually` flag — model changes don't move the viewport).
6. `ViewEditor.tsx`:

```ts
handleModelChange: (change, meta) => {
  return likec4rpc.updateModel({ projectId: project.id, change, changeId: meta.changeId })
    .then(res => {
      if (!res.success) throw new Error(res.error ?? 'updateModel failed')
      return res.warnings?.length ? { warnings: res.warnings } : undefined
    })
},
```

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @likec4/diagram exec vitest run src/editor
pnpm --filter @likec4/diagram typecheck && pnpm --filter @likec4/spa typecheck
```
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/diagram packages/likec4-spa && git commit -m "feat(diagram): ModelChange ops ride the editor sync queue"
```

---

### Task 10: Failure rollback + notifications

**Files:**
- Modify: `packages/diagram/package.json` (add `"@mantine/notifications": "catalog:mantine"` to dependencies)
- Create: `packages/diagram/src/editor/notifyEditError.ts`
- Modify: `packages/diagram/src/editor/actor/setup.ts` (new actor `refetchView`)
- Modify: `packages/diagram/src/editor/actor/types.ts` + `machine.ts` (context gains `lastFailures: Array<{ op: string; error: string }>`, init `[]`)
- Modify: `packages/diagram/src/editor/actor/state.sync-queue.ts` (failure path + warnings surfacing)
- Modify: `packages/diagram/src/editor/useEditorActorLogic.ts` (provide `refetchView` via `port.fetchView`)
- Modify: `packages/diagram/src/likec4diagram/DiagramUI.tsx` (mount `<Notifications />` when editor enabled)
- Modify: `packages/likec4-spa/src/style.css` + `packages/vscode-preview/src/index.css` (notifications styles — the diagram package imports NO mantine css itself; consumers do, via CSS layers)
- Test: extend `packages/diagram/src/editor/actor/state.sync-queue.spec.ts`

**Interfaces:**
- Consumes: `failed` array from Task 9a's `ExecuteChange.Output`; `port.fetchView(viewId, 'auto')`.
- Produces: on any failed change — server-truth restore (`update.view` with refetched view, `source: 'editor'`) + `notifications.show({ color: 'red', title: 'Edit failed', message })`. No silent failures.

- [ ] **Step 0: Install the new dependency FIRST**

Add `"@mantine/notifications": "catalog:mantine"` to `packages/diagram/package.json` dependencies, then:

```bash
pnpm install
```
Without this, every subsequent vitest/typecheck step fails with `Cannot find module '@mantine/notifications'`.

- [ ] **Step 1: Write the failing test**

```ts
it('on failed change: refetches server truth and clears queue (no silent failure)', async () => {
  const refetched: any[] = []
  const logic = editorActorLogic.provide({
    actors: {
      executeChange: fromPromise(async ({ input }) => ({
        requested: input.changes,
        applied: [],
        failed: input.changes.map((item: any) => ({ item, error: 'boom' })),
      })),
      refetchView: fromPromise(async ({ input }) => {
        refetched.push(input)
        return { view: { id: input.viewId } as any }
      }),
      applyLatest: fromPromise(async () => ({ updated: {} as any })),
      applySemanticLayout: fromPromise(async () => ({})),
    },
  })
  const actor = createActor(logic, { input: { viewId: 'index' as any }, systemId: 'editor' })
  actor.start()
  actor.send({ type: 'change.view', change: { op: 'change-autolayout', layout: { direction: 'TB' } } as any })
  await new Promise(r => setTimeout(r, 50))
  expect(refetched).toHaveLength(1)
  expect(actor.getSnapshot().matches({ syncQueue: 'idle' })).toBe(true)
  expect(actor.getSnapshot().context.syncQueue).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — no `refetchView` actor exists; failure path only clears queue.

- [ ] **Step 3: Implement**

1. `setup.ts`: declare `refetchView` stub actor (`fromPromise<{ view: t.LayoutedView }, { viewId: t.ViewId }>(() => { throw new Error('Not implemented') })`), add to `defineActors`.
2. `useEditorActorLogic.ts`: provide it — `refetchView: fromPromise(async ({ input }) => ({ view: await promisify(() => port!.fetchView(input.viewId, 'auto')) }))` (guard `port` like the others).
3. `state.sync-queue.ts`: `executeChanges.onDone` — when `event.output.failed.length > 0`, stash messages and target `failureNotify`:

```ts
failureNotify: machine.createStateConfig({
  invoke: {
    src: 'refetchView',
    input: ({ context }) => ({ viewId: context.viewId }),
    onDone: {
      actions: [
        // GUARDED send: typedSystem.diagramActor is system.get('diagram')! —
        // in standalone contexts (unit tests, detached actors) there is no
        // 'diagram' actor and a raw sendTo throws. enqueueActions + check:
        enqueueActions(({ enqueue, event, system }) => {
          if ((system as any).get('diagram')) {
            enqueue.sendTo(typedSystem.diagramActor, {
              type: 'update.view' as const,
              view: event.output.view,
              source: 'editor' as const,
            })
          }
        }),
        ({ context }) => {
          for (const f of context.lastFailures) {
            notifyEditError(f)
          }
        },
        assign({ lastFailures: [], awaitingAck: [], syncQueue: [], processing: null }),
      ],
      ...to.idle,
    },
    onError: {
      // refetch itself failed — notify and reset; HMR will eventually restore truth
      actions: [
        ({ context }) => {
          for (const f of context.lastFailures) notifyEditError(f)
        },
        assign({ lastFailures: [], awaitingAck: [], syncQueue: [], processing: null }),
      ],
      ...to.idle,
    },
  },
}),
```

   with `lastFailures: Array<{ error: string; op: string }>` added to context (default `[]`), populated in `onDone` of `executeChanges` from `event.output.failed`. `notifyEditError`:

```ts
// packages/diagram/src/editor/notifyEditError.ts (new small file)
import { notifications } from '@mantine/notifications'

export function notifyEditError({ op, error }: { op: string; error: string }) {
  notifications.show({
    color: 'red',
    title: `Edit failed (${op})`,
    message: error,
    withCloseButton: true,
    autoClose: 8000,
  })
}

export function notifyEditWarning(message: string) {
  notifications.show({
    color: 'yellow',
    title: 'Applied with warning',
    message,
    withCloseButton: true,
    autoClose: 8000,
  })
}
```

Also in `executeChanges.onDone` (success path): when `event.output.warnings.length > 0`, call
`notifyEditWarning` for each — this is how the spec's "UI surfaces a warning" for extend-tags lands.

4. `DiagramUI.tsx`: import `Notifications` from `@mantine/notifications` and render `<Notifications position="bottom-right" limit={3} />` guarded by `<IfEnabled feature="Editor">` (import from `../context/DiagramFeatures`). STYLES: the diagram package imports no Mantine CSS itself — consumers do, via CSS layer imports. Add `@import "@mantine/notifications/styles.layer.css";` immediately after the existing `@import "@mantine/core/styles.layer.css";` line in BOTH `packages/likec4-spa/src/style.css` (line ~2) and `packages/vscode-preview/src/index.css` (line ~2). Do NOT add a JS side-effect css import inside the library.
5. Also update the existing `applyLatestToManual.onError` and `applySemanticLayout.onError` blocks to call `notifyEditError({ op: ..., error: String(event.error) })` in addition to their current behavior — the "no console.error-only paths" rule from the spec.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @likec4/diagram exec vitest run src/editor && pnpm --filter @likec4/diagram typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/diagram && git commit -m "feat(diagram): failure rollback via server-truth refetch + edit-error notifications"
```

---

### Task 11: View properties UI (backend exists)

**Files:**
- Create: `packages/diagram/src/navigationpanel/editorpanel/EditViewPropertiesButton.tsx`
- Modify: `packages/diagram/src/navigationpanel/editorpanel/EditorPanel.tsx` (render the new button alongside `ChangeAutoLayoutButton`)
- Test: `packages/diagram/src/navigationpanel/editorpanel/EditViewPropertiesButton.spec.ts` (pure-logic spec of the payload builder — the package has NO jsdom/@testing-library infra; the two existing `.spec.tsx` files use `renderToStaticMarkup` only. Name it `.spec.ts` so nobody attempts rendering.)

**Interfaces:**
- Consumes: `diagram.triggerChange` (existing), `ViewChange.ChangeProperty` (existing core type), current view via `useDiagram()` / context selectors used by sibling editorpanel components (mirror `ChangeAutoLayoutButton.tsx`'s data access exactly).
- Produces: UI only. Payload builder exported for testing:

```ts
export function buildViewPropertyChange(input: {
  title: string; description: string
  originalTitle: string | null; originalDescription: string | null
}): ViewChange.ChangeProperty | null
// returns null when nothing actually changed; omits unchanged fields
```

- [ ] **Step 1: Failing test for the payload builder**

```ts
import { describe, expect, it } from 'vitest'
import { buildViewPropertyChange } from './EditViewPropertiesButton'  // .spec.ts imports the builder only

describe('buildViewPropertyChange', () => {
  it('returns null when nothing changed', () => {
    expect(buildViewPropertyChange({
      title: 'A', description: 'd', originalTitle: 'A', originalDescription: 'd',
    })).toBeNull()
  })
  it('includes only changed fields', () => {
    expect(buildViewPropertyChange({
      title: 'B', description: 'd', originalTitle: 'A', originalDescription: 'd',
    })).toEqual({ op: 'change-property', title: 'B' })
  })
})
```

- [ ] **Step 2: Run to verify failure** (`module not found`)

- [ ] **Step 3: Implement the component**

Follow `ChangeAutoLayoutButton.tsx` structurally (Popover from an ActionIcon in the panel, commit on explicit button):

```tsx
// EditViewPropertiesButton.tsx — structure (adapt imports/styles to match ChangeAutoLayoutButton exactly)
import { Button, Popover, PopoverDropdown, PopoverTarget, Stack, Textarea, TextInput } from '@mantine/core'
import { IconPencil } from '@tabler/icons-react'
import { useState } from 'react'
import type { ViewChange } from '@likec4/core/types'
import { useDiagram } from '../../hooks/useDiagram'
// + the same current-view selector hook ChangeAutoLayoutButton uses

export function buildViewPropertyChange(input: {
  title: string
  description: string
  originalTitle: string | null
  originalDescription: string | null
}): ViewChange.ChangeProperty | null {
  const change: ViewChange.ChangeProperty = { op: 'change-property' }
  if (input.title !== (input.originalTitle ?? '')) {
    change.title = input.title
  }
  if (input.description !== (input.originalDescription ?? '')) {
    change.description = input.description
  }
  return change.title !== undefined || change.description !== undefined ? change : null
}

export const EditViewPropertiesButton = () => {
  const diagram = useDiagram()
  // OBTAIN THE CURRENT VIEW exactly the way ChangeAutoLayoutButton does:
  // grep -n "useDiagram\|Context\|view" packages/diagram/src/navigationpanel/editorpanel/ChangeAutoLayoutButton.tsx
  // and copy its context-selector call verbatim. It must yield an object with
  // { title: string | null, description: MarkdownOrString | null }.
  const view = useCurrentViewLikeSiblingButton()
  const [opened, setOpened] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  // sync local state from view when opening
  // view.description is MarkdownOrString = {txt} | {md}; `?.md` alone silently
  // drops the {txt} variant (the common `description 'text'` case) — use the
  // core helper instead:
  // import { flattenMarkdownOrString } from '@likec4/core' (scalar.ts:53)
  const open = () => {
    setTitle(view.title ?? '')
    setDescription(flattenMarkdownOrString(view.description) ?? '')
    setOpened(true)
  }
  const save = () => {
    const change = buildViewPropertyChange({
      title,
      description,
      originalTitle: view.title,
      originalDescription: flattenMarkdownOrString(view.description) ?? null,
    })
    if (change) {
      diagram.triggerChange(change)
    }
    setOpened(false)
  }
  return (
    <Popover opened={opened} onDismiss={() => setOpened(false)} position="bottom-start">
      <PopoverTarget>
        {/* same Tooltip+ActionIcon wrapper as sibling buttons, icon IconPencil, onClick=open */}
      </PopoverTarget>
      <PopoverDropdown>
        <Stack gap="xs" w={320}>
          <TextInput label="Title" size="xs" value={title} onChange={e => setTitle(e.currentTarget.value)} />
          <Textarea
            label="Description"
            description="Markdown"
            size="xs"
            autosize
            minRows={3}
            maxRows={10}
            value={description}
            onChange={e => setDescription(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
            }}
          />
          <Button size="xs" onClick={save}>Save</Button>
        </Stack>
      </PopoverDropdown>
    </Popover>
  )
}
```

Render it in `EditorPanel.tsx` next to `ChangeAutoLayoutButton` (same wrapper markup as siblings). Tag editing for views is NOT in this popover for now — tags need the tag-picker treatment that Task 12 builds for elements; view tags follow in a later phase.

- [ ] **Step 4: Run test + typecheck + visual sanity**

```bash
pnpm --filter @likec4/diagram exec vitest run src/navigationpanel && pnpm --filter @likec4/diagram typecheck
```
Then manual, via the source-mode dev server (see Global Constraints — never the dist bin):

```bash
pnpm --filter likec4 dev:example-cloud
```
Open the printed URL at `/view/cloud`, click Edit, open the pencil popover, change the title, save. Verify: `examples/cloud-system/views.c4` gains/updates `title` inside `view cloud`, browser updates without reload. `git checkout examples/` afterwards.

- [ ] **Step 5: Commit**

```bash
pnpm fmt && git add -A packages/diagram && git commit -m "feat(diagram): edit view title/description from editor panel"
```

---

### Task 12: Editable element Properties tab + overlays read-only relaxation

**Files:**
- Modify: `packages/diagram/src/context/DiagramFeatures.tsx:111-116`
- Create: `packages/diagram/src/overlays/element-details/EditableProperty.tsx`
- Create: `packages/diagram/src/overlays/element-details/ElementTagsEditor.tsx`
- Modify: `packages/diagram/src/overlays/element-details/ElementDetailsCard.tsx:418-450`
- Test: `packages/diagram/src/overlays/element-details/EditableProperty.spec.ts` (payload-builder logic test, pure `.spec.ts` — same constraint as Task 11)

**Interfaces:**
- Consumes: `diagram.triggerModelChange` (Task 9b), `ModelChange.ChangeElementProperty` (Task 1), `elementModel` already in scope in the card (`.id` is the Fqn), `useEnabledFeatures().enableReadOnly`.
- Produces: exported payload builder:

```ts
export function buildElementPropertyChange(input: {
  target: Fqn
  field: 'title' | 'description' | 'technology'
  value: string
  original: string | null
}): ModelChange.ChangeElementProperty | null
```

- [ ] **Step 1: Overlays relaxation (the enabling architectural change)**

In `DiagramFeatures.tsx`, change:

```ts
const overridesForOverlays: Partial<EnabledFeatures> = {
  enableControls: false,
  enableAISemanticLayout: false,
  enableCompareWithLatest: false,
}
```

(remove `enableReadOnly: true` — overlays now inherit read-only state from the diagram scope; with no editor attached, `enableReadOnly` stays true as before via `LikeC4Diagram`'s derivation).

Then audit every `enableReadOnly` / `IfNotReadOnly` consumer under `packages/diagram/src/overlays/` (`grep -rn "ReadOnly" packages/diagram/src/overlays/`) and for each hit verify what an editor-enabled overlay now renders. Known consumers to check: relationship-details / relationships-browser mini-diagrams (they mount their own providers — confirm they pass explicit features and are unaffected). Record findings in the commit message. If any overlay consumer visibly regresses (edit affordances appearing where they can't work), scope those subtrees with an explicit `<DiagramFeatures overrides={{ enableReadOnly: true }}>` locally.

- [ ] **Step 2: Failing test for the payload builder**

```ts
import { describe, expect, it } from 'vitest'
import { buildElementPropertyChange } from './EditableProperty'

describe('buildElementPropertyChange', () => {
  it('null when unchanged', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any, field: 'description', value: 'same', original: 'same',
    })).toBeNull()
  })
  it('builds a change for the single edited field', () => {
    expect(buildElementPropertyChange({
      target: 'a.b' as any, field: 'technology', value: 'k8s', original: null,
    })).toEqual({ op: 'change-element-property', target: 'a.b', technology: 'k8s' })
  })
})
```

- [ ] **Step 3: Run to verify failure, then implement**

`EditableProperty.tsx` — pencil-toggled inline editor used for description (Textarea) and technology/title (TextInput). Commit on blur or Ctrl+Enter; Esc cancels; disabled (renders children read-only) when `enableReadOnly`:

```tsx
import type { Fqn, ModelChange } from '@likec4/core/types'
import { ActionIcon, Textarea, TextInput } from '@mantine/core'
import { IconCheck, IconPencil, IconX } from '@tabler/icons-react'
import { type PropsWithChildren, useState } from 'react'
import { useEnabledFeatures } from '../../context/DiagramFeatures'
import { useDiagram } from '../../hooks/useDiagram'

export function buildElementPropertyChange(input: {
  target: Fqn
  field: 'title' | 'description' | 'technology'
  value: string
  original: string | null
}): ModelChange.ChangeElementProperty | null {
  if (input.value === (input.original ?? '')) {
    return null
  }
  return {
    op: 'change-element-property',
    target: input.target,
    [input.field]: input.value,
  }
}

export function EditableProperty({
  target,
  field,
  original,
  multiline = false,
  children,
}: PropsWithChildren<{
  target: Fqn
  field: 'title' | 'description' | 'technology'
  original: string | null
  multiline?: boolean
}>) {
  const { enableReadOnly } = useEnabledFeatures()
  const diagram = useDiagram()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  if (enableReadOnly) {
    return <>{children}</>
  }

  const start = () => {
    setValue(original ?? '')
    setEditing(true)
  }
  const commit = () => {
    const change = buildElementPropertyChange({ target, field, value, original })
    if (change) {
      diagram.triggerModelChange(change)
    }
    setEditing(false)
  }
  const cancel = () => setEditing(false)

  if (!editing) {
    return (
      <div style={{ position: 'relative' }} data-likec4-editable-property={field}>
        {children}
        <ActionIcon
          size="xs"
          variant="subtle"
          aria-label={`Edit ${field}`}
          onClick={start}
          style={{ position: 'absolute', top: 0, right: 0 }}>
          <IconPencil size={12} />
        </ActionIcon>
      </div>
    )
  }

  const inputProps = {
    size: 'xs' as const,
    autoFocus: true,
    value,
    onChange: (e: any) => setValue(e.currentTarget.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        cancel()
      }
      if (e.key === 'Enter' && (multiline ? e.ctrlKey || e.metaKey : true)) {
        commit()
      }
    },
  }
  return multiline
    ? <Textarea {...inputProps} autosize minRows={3} maxRows={12} description="Markdown · Ctrl+Enter to save" />
    : <TextInput {...inputProps} />
}
```

`ElementTagsEditor.tsx` — chips for current tags with a remove `x` (when not read-only) and an add-combobox listing specification tags not yet applied. Tag source: `elementModel.tags` (current); all known tags via `Object.keys(elementModel.$model.specification.tags)` (a `Record<Tag, TagSpecification>`), or `elementModel.$model.tags` (`LikeC4Model.tags`, line ~685) — both exist; pick either:

```tsx
// on remove:  diagram.triggerModelChange({ op: 'change-element-property', target, tag: { remove: tagName } })
// on add:     diagram.triggerModelChange({ op: 'change-element-property', target, tag: { add: tagName } })
```

Wire into `ElementDetailsCard.tsx` Properties panel (the region at lines 418–450). The component does NOT currently read features — add at the top, next to the existing hooks:

```ts
const { enableReadOnly } = useEnabledFeatures()
```

(`elementModel.description` is a `RichTextOrEmpty` — its `.md` getter already falls back to the `txt` variant and returns `''` when empty, so `elementModel.description.md || null` is the correct original-value access here; the `typeof === 'string'` branch is dead code, drop it.)

```tsx
<>
  <PropertyLabel>description</PropertyLabel>
  <EditableProperty
    target={elementModel.id}
    field="description"
    multiline
    original={elementModel.description.md || null}>
    <Markdown value={elementModel.description} emptyText="no description" />
  </EditableProperty>
</>
{(elementModel.technology || !enableReadOnly) && (
  <ElementProperty title="technology">
    <EditableProperty
      target={elementModel.id}
      field="technology"
      original={elementModel.technology ?? null}>
      {elementModel.technology ?? '—'}
    </EditableProperty>
  </ElementProperty>
)}
```

(Adapt the `description` original-value access to the actual `elementModel.description` type — check `RichTextOrEmpty` handling used elsewhere in this card, e.g. how `Markdown value=` consumes it, and extract the raw source the same way.) Title editing lives in the card header — wrap the existing title element in `<EditableProperty target field="title" original={elementModel.title}>`.

- [ ] **Step 4: Run tests, typecheck, end-to-end verification**

```bash
pnpm --filter @likec4/diagram exec vitest run src/overlays src/editor && pnpm --filter @likec4/diagram typecheck
```

End-to-end (the phase's definition of done), via the source-mode dev server:

```bash
pnpm --filter likec4 dev:example-cloud
```
1. Open a view → click a node → Open details → Properties tab shows pencil affordances (edit mode on).
2. Edit description → Ctrl+Enter → within ~1s the card re-renders from HMR; `git diff examples/` shows exactly one `description` change inside the right element in the right file, comments intact.
3. Add then remove a tag; verify DSL.
4. Kill the server mid-edit (or edit a file to be invalid first) → notification appears, diagram restores, no silent divergence.
5. `git checkout examples/` to reset.

- [ ] **Step 5: Changeset + commit**

Create `.changeset/command-center-properties.md`:

```md
---
'@likec4/core': patch
'@likec4/language-server': patch
'@likec4/vite-plugin': patch
'@likec4/diagram': patch
'likec4': patch
---

Edit element properties (title, description, technology, tags) and view properties (title, description) directly from the diagram in `likec4 start`. Edits are written back into the `.c4` source as precise text edits. Failed edits now show a notification and the diagram restores to the source state; the editor sync queue acknowledges applied changes instead of using a fixed timer.
```

```bash
pnpm fmt && git add -A && git commit -m "feat(diagram): editable element properties in details card; relax overlay read-only"
```

---

## Final verification (whole plan)

- [ ] `pnpm typecheck` — clean across the workspace (apps excluded by default filter).
- [ ] `pnpm test` — full suite green.
- [ ] `pnpm lint:errors-only` — clean.
- [ ] The Task 12 end-to-end checklist passes on `examples/cloud-system`.
- [ ] `git log --oneline` shows one focused commit per task, each formatted (dprint) and green at commit time.
