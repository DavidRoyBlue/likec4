import { type ProjectId, type ViewChange, invariant, nonexhaustive } from '@likec4/core'
import { loggable, wrapError } from '@likec4/log'
import { TextDocument } from 'langium'
import { Range, TextEdit } from 'vscode-languageserver-types'
import type { ParsedLikeC4LangiumDocument } from '../ast'
import { logger as mainLogger } from '../logger'
import type { LikeC4ModelLocator, ViewLocateResult } from '../model'
import type { LikeC4Services } from '../module'
import type { ChangeModel, ChangeView } from '../protocol'
import { changeElementProperty } from './changeElementProperty'
import { changeElementStyle } from './changeElementStyle'
import { changeViewLayout } from './changeViewLayout'
import { changePropertyHandler, preparePayload } from './viewChange'

const logger = mainLogger.getChild('model-changes')

export class LikeC4ModelChanges {
  private locator: LikeC4ModelLocator

  constructor(private services: LikeC4Services) {
    this.locator = services.likec4.ModelLocator
  }

  public async applyChange(changeView: ChangeView.Params): Promise<ChangeView.Res> {
    let { viewId, projectId: _projectId, change, changeId } = changeView

    if (change.op === 'change-property') {
      try {
        const payload = preparePayload(changeView, this.services)
        const expectedVersion = payload.doc.textDocument.version
        const res = changePropertyHandler(payload)
        if (!res) {
          return {
            success: false,
            error: 'No changes to apply',
            ...(changeId !== undefined && { changeId }),
          }
        }
        const edits = Array.isArray(res) ? res : [res]
        const applyResult = await this.applyTextEdits(payload.doc, edits, expectedVersion)
        if (!applyResult) {
          return {
            success: false,
            error: 'Failed to apply text edits',
            ...(changeId !== undefined && { changeId }),
          }
        }
        return {
          success: true,
          location: null,
          ...(changeId !== undefined && { changeId }),
        }
      } catch (err) {
        const error = loggable(
          wrapError(
            err,
            `Failed to apply change ${changeView.change.op} ${changeView.viewId}`,
          ),
        )
        logger.warn(error)
        return {
          success: false,
          error,
          ...(changeId !== undefined && { changeId }),
        }
      }
    }

    const workspace = this.services.shared.workspace

    try {
      const project = workspace.ProjectsManager.ensureProject(_projectId as ProjectId)
      logger.debug`Applying model change ${change.op} to view ${viewId} in project ${project.id}`
      const lookup = this.locator.locateViewAst(viewId, project.id)
      if (!lookup) {
        throw new Error(`View ${viewId} not found in project ${project.id}`)
      }
      const expectedVersion = lookup.doc.textDocument.version
      const textDocument = {
        uri: lookup.doc.textDocument.uri,
        version: lookup.doc.textDocument.version,
      }
      // TODO refactor to use separate methods for save/reset operations
      if (change.op === 'save-view-snapshot') {
        invariant(
          viewId === change.layout.id,
          'View ID does not match, expected ' + viewId + ', got ' + change.layout.id,
        )
        const location = await workspace.ManualLayouts.write(project, change.layout)
        return {
          success: true,
          location,
          ...(changeId !== undefined && { changeId }),
        }
      }

      if (change.op === 'reset-manual-layout') {
        const location = await workspace.ManualLayouts.remove(project, viewId)
        return {
          success: true,
          location,
          ...(changeId !== undefined && { changeId }),
        }
      }

      // Convert the view change to text edits
      const { edits, modifiedRange } = this.convertToTextEdit({
        lookup,
        change,
      })
      if (!edits.length) {
        return {
          success: false,
          error: 'No changes to apply',
          ...(changeId !== undefined && { changeId }),
        }
      }

      // Apply the text edits to the document
      const applyResult = await this.applyTextEdits(lookup.doc, edits, expectedVersion)
      if (!applyResult) {
        return {
          success: false,
          error: `Failed to apply changes`,
          ...(changeId !== undefined && { changeId }),
        }
      }

      return {
        success: true,
        location: {
          uri: textDocument.uri,
          range: modifiedRange,
        },
        ...(changeId !== undefined && { changeId }),
      }
    } catch (err) {
      const error = loggable(
        wrapError(
          err,
          `Failed to apply change ${changeView.change.op} ${changeView.viewId}`,
        ),
      )
      logger.warn(error)
      return {
        success: false,
        error,
        ...(changeId !== undefined && { changeId }),
      }
    }
  }

  public async applyModelChange(params: ChangeModel.Params): Promise<ChangeModel.Res> {
    const workspace = this.services.shared.workspace
    const changeId = params.changeId
    try {
      const project = workspace.ProjectsManager.ensureProject(params.projectId as ProjectId)
      const change = params.change
      switch (change.op) {
        case 'change-element-property': {
          const located = this.locator.locateElementAst(change.target, project.id)
          if (!located) {
            throw new Error(`Element ${change.target} not found in project ${project.id}`)
          }
          const expectedVersion = located.doc.textDocument.version
          const { edits, modifiedRange, warnings } = changeElementProperty(this.services, {
            doc: located.doc,
            elementAst: located.elementAst,
            change,
          })
          if (!edits.length) {
            return { success: false, error: 'No changes to apply', ...(changeId !== undefined && { changeId }) }
          }
          const applied = await this.applyTextEdits(located.doc, edits, expectedVersion)
          if (!applied) {
            return { success: false, error: 'Failed to apply changes', ...(changeId !== undefined && { changeId }) }
          }
          return {
            success: true,
            location: { uri: located.doc.textDocument.uri, range: modifiedRange },
            ...(changeId !== undefined && { changeId }),
            ...(warnings.length > 0 && { warnings }),
          }
        }
        default:
          nonexhaustive(change.op)
      }
    } catch (err) {
      const error = loggable(wrapError(err, `Failed to apply model change ${params.change.op}`))
      logger.warn(error)
      return { success: false, error, ...(changeId !== undefined && { changeId }) }
    }
  }

  protected convertToTextEdit({ lookup, change }: {
    lookup: ViewLocateResult
    change: Exclude<ViewChange, ViewChange.SaveViewSnapshot | ViewChange.ResetManualLayout | ViewChange.ChangeProperty>
  }): {
    modifiedRange: Range
    edits: TextEdit[]
  } {
    switch (change.op) {
      case 'change-element-style': {
        return changeElementStyle(this.services, {
          ...lookup,
          targets: change.targets,
          style: change.style,
        })
      }
      case 'change-autolayout': {
        const edit = changeViewLayout(this.services, {
          ...lookup,
          layout: change.layout,
        })
        return {
          modifiedRange: edit.range,
          edits: [edit],
        }
      }
      default:
        nonexhaustive(change)
    }
  }

  protected async applyTextEdits(
    doc: ParsedLikeC4LangiumDocument,
    edits: TextEdit[],
    expectedVersion?: number,
  ): Promise<boolean> {
    if (expectedVersion !== undefined && doc.textDocument.version !== expectedVersion) {
      // THROW (not `return false`): the callers' try/catch converts this into
      // {success:false, error} with THIS message — a plain false is
      // indistinguishable from an applyEdit failure and would report the wrong error.
      throw new Error('Document changed underneath — retry the edit')
    }
    const lsp = this.services.shared.lsp.Connection
    const workspace = this.services.shared.workspace
    if (!lsp) {
      // fallback to direct text document edit if LSP connection is not available (e.g. wdhen running in MCP/CLI)
      let text = TextDocument.applyEdits(doc.textDocument, edits)
      await workspace.FileSystemProvider.writeFile(doc.uri, text)

      await workspace.DocumentBuilder.update([doc.uri], [])

      // const formatEdits = await this.services.lsp.Formatter.formatDocument(doc, {
      //   options: {
      //     insertSpaces: true,
      //     tabSize: 2,
      //   },
      //   textDocument: {
      //     uri: doc.textDocument.uri,
      //   },
      // })

      // if (formatEdits.length > 0) {
      //   text = TextDocument.applyEdits(doc.textDocument, formatEdits)
      //   TextDocument.update(doc.textDocument, [{ text }], doc.textDocument.version + 1)
      // }

      // try {
      //   await workspace.FileSystemProvider.writeFile(doc.uri, text)
      // } catch (err) {
      //   logger.warn(err)
      // }
      return true
    }
    const applyResult = await lsp.workspace.applyEdit({
      label: `LikeC4 - change view`,
      edit: {
        changes: {
          [doc.textDocument.uri]: edits,
        },
      },
    })
    if (!applyResult.applied) {
      logger.warn`Failed to apply text edits to document ${doc.textDocument.uri}: ${applyResult.failureReason}`
      lsp.window.showErrorMessage(`Failed to apply changes: ${applyResult.failureReason}`)
      return false
    }
    await workspace.DocumentBuilder.update([doc.uri], [])
    return applyResult.applied
  }
}
