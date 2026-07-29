import type { scalar, ViewChange, ViewId } from '@likec4/core'
import type { TextEdit } from 'vscode-languageserver-protocol'
import { type ParsedLikeC4LangiumDocument, ast } from '../ast'
import type { LikeC4Services } from '../module'
import type { ChangeView } from '../protocol'
import type { ProjectData } from '../workspace/ProjectsManager'
import { updateDescriptionProperty, updateTags, updateTitleProperty } from './propertyEdits'

export type ViewChangePayload<Op extends ViewChange['op']> = {
  viewId: ViewId
  project: ProjectData
  doc: ParsedLikeC4LangiumDocument
  viewAst: ast.LikeC4View
  change: Extract<ViewChange, { op: Op }>
  services: LikeC4Services
  workspace: LikeC4Services['shared']['workspace']
}

export function preparePayload(request: ChangeView.Params, services: LikeC4Services): AnyPayload {
  const workspace = services.shared.workspace
  let { viewId, projectId: _projectId, change } = request
  const project = workspace.ProjectsManager.ensureProject(_projectId as scalar.ProjectId)
  const lookup = services.likec4.ModelLocator.locateViewAst(viewId, project.id)
  if (!lookup) {
    throw new Error(`View ${viewId} not found in project ${project.id}`)
  }
  return {
    viewId,
    change,
    services,
    project,
    doc: lookup.doc,
    viewAst: lookup.viewAst,
    workspace,
  }
}

export type AnyPayload = ViewChangePayload<ViewChange['op']>

export type ViewChangeHandlerResult = TextEdit | TextEdit[]

export interface ViewChangeHandler<Op extends ViewChange['op']> {
  (args: ViewChangePayload<Op>): ViewChangeHandlerResult
}

export function viewChangeHandler<Op extends ViewChange['op']>(
  op: Op,
  handler: ViewChangeHandler<Op>,
) {
  return (payload: AnyPayload): undefined | ViewChangeHandlerResult => {
    if (payload.change.op !== op) {
      return undefined
    }
    return handler(payload as ViewChangePayload<Op>)
  }
}

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
