import { type ModelChange, nonNullable } from '@likec4/core'
import { ops, printOperation, withctx } from '@likec4/generators/likec4'
import { GrammarUtils } from 'langium'
import { type Position, type Range, TextEdit } from 'vscode-languageserver-types'
import { type ParsedLikeC4LangiumDocument, ast } from '../ast'
import type { LikeC4Services } from '../module'
import {
  updateDescriptionProperty,
  updateTags,
  updateTechnologyProperty,
  updateTitleProperty,
} from './propertyEdits'

const { findNodeForProperty } = GrammarUtils

/**
 * Union of every edit range — reported back as `location` (same convention
 * as changeElementStyle's modifiedRange).
 */
function includeRanges(edits: TextEdit[]): Range | undefined {
  const first = edits[0]
  if (!first) {
    return undefined
  }
  let { start, end } = first.range
  for (const e of edits.slice(1)) {
    if (e.range.start.line < start.line) start = e.range.start
    if (e.range.end.line > end.line) end = e.range.end
  }
  return { start, end }
}

function laterPosition(a: Position, b: Position): Position {
  if (a.line !== b.line) return a.line > b.line ? a : b
  return a.character > b.character ? a : b
}

/**
 * Positional title handling: grammar allows `sys = system 'Title' { ... }`
 * where the positional string OVERRIDES any body `title` property (see
 * ModelParser Base.ts:598). Editing the title must therefore DELETE the
 * positional literal, then upsert the body property.
 *
 * Grammar assigns positional strings as `props+=String` (like-c4.langium:126-138),
 * so `ast.Element.props` is `Array<string>` — a plain string, not an AST node with
 * `$cstNode`. The CST node for the first positional entry must be recovered via
 * `findNodeForProperty(elementAst.$cstNode, 'props', 0)`. The deletion range is
 * widened to start at the end of whichever of `kind`/`name` sits immediately
 * before it, so the stray separating space is removed too.
 */
function removePositionalTitle(elementAst: ast.Element): TextEdit | undefined {
  if (!elementAst.props || elementAst.props.length === 0) {
    return undefined
  }
  const literalNode = findNodeForProperty(elementAst.$cstNode, 'props', 0)
  if (!literalNode) {
    return undefined
  }
  const kindNode = findNodeForProperty(elementAst.$cstNode, 'kind')
  const nameNode = findNodeForProperty(elementAst.$cstNode, 'name')
  let start = literalNode.range.start
  if (kindNode && nameNode) {
    start = laterPosition(kindNode.range.end, nameNode.range.end)
  } else if (kindNode) {
    start = kindNode.range.end
  } else if (nameNode) {
    start = nameNode.range.end
  }
  return TextEdit.del({ start, end: literalNode.range.end })
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

export function changeElementProperty(
  services: LikeC4Services,
  { doc, elementAst, change }: {
    doc: ParsedLikeC4LangiumDocument
    elementAst: ast.Element
    change: ModelChange.ChangeElementProperty
  },
): { edits: TextEdit[]; modifiedRange: Range; warnings: string[] } {
  const warnings = collectExtendTagWarnings(services, doc, change)
  const fallbackRange = nonNullable(elementAst.$cstNode, 'element cst').range

  if (!elementAst.body) {
    const edits: TextEdit[] = []
    if (change.title !== undefined) {
      const dropPositional = removePositionalTitle(elementAst)
      if (dropPositional) {
        edits.push(dropPositional)
      }
    }
    edits.push(bracelessBodyEdit(elementAst, change))
    return { edits, modifiedRange: includeRanges(edits) ?? fallbackRange, warnings }
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
  return { edits, modifiedRange: includeRanges(edits) ?? fallbackRange, warnings }
}

/**
 * Detect tags that already arrive through `extend <fqn> { #tag }` in any
 * document of the project — the edit still applies (tags dedupe on merge),
 * but the user should know the tag is ALSO set elsewhere.
 */
function collectExtendTagWarnings(
  services: LikeC4Services,
  doc: ParsedLikeC4LangiumDocument,
  change: ModelChange.ChangeElementProperty,
): string[] {
  const toAdd = change.tag?.add
    ? (Array.isArray(change.tag.add) ? change.tag.add : [change.tag.add])
    : []
  if (toAdd.length === 0) return []
  const warnings: string[] = []
  const projectDocs = services.shared.workspace.LangiumDocuments.projectDocuments(doc.likec4ProjectId)
  for (const projectDoc of projectDocs) {
    for (const ext of projectDoc.c4ExtendElements ?? []) {
      if (ext.id !== change.target) continue
      for (const tag of toAdd) {
        if (ext.tags?.includes(tag)) {
          warnings.push(`Tag #${tag} is already added to ${change.target} via an extend block`)
        }
      }
    }
  }
  return warnings
}
