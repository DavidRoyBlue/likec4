import { UriUtils } from 'langium'
import { vol } from 'memfs'
import stripIndent from 'strip-indent'
import { type ExpectStatic, vi } from 'vitest'
import { URI } from 'vscode-uri'
import { WithFileSystem } from '../../filesystem'
import type { ChangeModel, ChangeView } from '../../protocol'
import { createTestServices } from '../../test'

vi.mock('node:fs')
vi.mock('node:fs/promises')

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

  async function changeModelRaw(params: ChangeModel.Params) {
    return await services.likec4.ModelChanges.applyModelChange(params)
  }

  async function changeModel(params: ChangeModel.Params) {
    const res = await changeModelRaw(params)
    if (!res.success) throw new Error(res.error)
    return readFromMemory()
  }

  /**
   * Re-parses the (already updated) documents and returns the parsed element —
   * the only way to assert what the model ACTUALLY sees after an edit, e.g. that
   * a positional string is no longer shadowing a body property.
   */
  async function parsedElement(fqn: string) {
    const model = await services.likec4.ModelBuilder.parseModel()
    return model?.$data.elements[fqn]
  }

  return { change, read, fs, services, changeModel, changeModelRaw, parsedElement }
}
