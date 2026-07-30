import { type ModelChange, nonNullable } from '@likec4/core'
import { ops, printOperation, withctx } from '@likec4/generators/likec4'
import { GrammarUtils } from 'langium'
import { type Position, type Range, TextEdit } from 'vscode-languageserver-types'
import { type ParsedLikeC4LangiumDocument, ast } from '../ast'
import type { LikeC4Services } from '../module'
import {
  updateDescriptionProperty,
  updateSummaryProperty,
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
 * Positional strings on the element declaration line, e.g.
 * `customer = actor 'Title' 'Summary' 'Technology'`.
 *
 * The grammar (like-c4.langium:126-138) allows up to FOUR of them, nested so
 * that a slot can only exist when every preceding slot exists. ModelParser
 * (ModelParser.ts:96-109) maps them as:
 *
 *   props[0] → title, props[1] → summary, props[2] → technology,
 *   props[3] → tags (parsed for Structurizr compatibility, IGNORED by LikeC4)
 *
 * and feeds them to `parseBaseProps` as the `override` argument — meaning each
 * positional takes PRECEDENCE over the matching body property (Base.ts:579-616).
 *
 * Two consequences drive the handling below:
 *  - deleting only `props[0]` is unsound: the run shifts left and the old
 *    SUMMARY is promoted into the title slot, silently overriding the body
 *    `title` that was just written;
 *  - a body `technology` is silently shadowed whenever `props[2]` exists.
 *
 * So as soon as an edit touches a property a positional would shadow, the WHOLE
 * run is removed and every displaced value is re-emitted as a body property
 * (via the generators' ops printers — never hand-rolled strings).
 *
 * Body `description` is never shadowed (slot 1 is `summary`, not `description`),
 * and tags are never shadowed (slot 3 is ignored by LikeC4), so those edits keep
 * the positional run untouched.
 */
type PositionalValues = {
  title?: string
  summary?: string
  technology?: string
}

/**
 * True when the change writes a body property that a still-present positional
 * would override.
 */
function isShadowedByPositionals(props: string[], change: ModelChange.ChangeElementProperty): boolean {
  return (change.title !== undefined && props.length >= 1)
    || (change.technology !== undefined && props.length >= 3)
}

/**
 * Values that must be re-emitted as body properties once the positional run is
 * gone. A slot the change itself overwrites is skipped — the change wins.
 *
 * NOTE: `props[3]` (Structurizr tag list) has no LikeC4 counterpart and is
 * dropped with the run; it never contributed to the parsed model.
 */
function displacedPositionals(props: string[], change: ModelChange.ChangeElementProperty): PositionalValues {
  const [title, summary, technology] = props
  return {
    ...(change.title === undefined && title !== undefined && { title }),
    ...(summary !== undefined && { summary }),
    ...(change.technology === undefined && technology !== undefined && { technology }),
  }
}

/**
 * Grammar assigns positional strings as `props+=String`, so `ast.Element.props`
 * is `Array<string>` — plain strings, not AST nodes with `$cstNode`. Their CST
 * nodes must be recovered via `findNodeForProperty(cst, 'props', index)`.
 *
 * The deletion range spans the ENTIRE run and is widened to start at the end of
 * whichever of `kind`/`name` sits immediately before it, so the stray separating
 * space is removed too.
 */
function removePositionalRun(elementAst: ast.Element): TextEdit | undefined {
  const count = elementAst.props?.length ?? 0
  if (count === 0) {
    return undefined
  }
  const firstNode = findNodeForProperty(elementAst.$cstNode, 'props', 0)
  const lastNode = findNodeForProperty(elementAst.$cstNode, 'props', count - 1)
  if (!firstNode || !lastNode) {
    return undefined
  }
  const kindNode = findNodeForProperty(elementAst.$cstNode, 'kind')
  const nameNode = findNodeForProperty(elementAst.$cstNode, 'name')
  let start = firstNode.range.start
  if (kindNode && nameNode) {
    start = laterPosition(kindNode.range.end, nameNode.range.end)
  } else if (kindNode) {
    start = kindNode.range.end
  } else if (nameNode) {
    start = nameNode.range.end
  }
  return TextEdit.del({ start, end: lastNode.range.end })
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
  displaced: PositionalValues,
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
  const title = change.title ?? displaced.title
  if (title !== undefined) {
    parts.push(printOperation(withctx({ title }, ops.props.titleProperty())))
  }
  if (displaced.summary !== undefined) {
    parts.push(printOperation(withctx({ summary: displaced.summary }, ops.props.summaryProperty())))
  }
  const technology = change.technology ?? displaced.technology
  if (technology !== undefined) {
    parts.push(printOperation(withctx({ technology }, ops.props.technologyProperty())))
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

  const positionals = elementAst.props ?? []
  // Only touch the positional run when it would shadow what we are about to write.
  const dropPositionals = isShadowedByPositionals(positionals, change)
    ? removePositionalRun(elementAst)
    : undefined
  // If the run survives (no CST), leave the values where they are — re-emitting
  // them would duplicate, not displace.
  const displaced = dropPositionals ? displacedPositionals(positionals, change) : {}

  if (!elementAst.body) {
    const edits: TextEdit[] = []
    if (dropPositionals) {
      edits.push(dropPositionals)
    }
    edits.push(bracelessBodyEdit(elementAst, change, displaced))
    return { edits, modifiedRange: includeRanges(edits) ?? fallbackRange, warnings }
  }

  const edits: TextEdit[] = []
  if (dropPositionals) {
    edits.push(dropPositionals)
  }
  const title = change.title ?? displaced.title
  if (title !== undefined) {
    edits.push(updateTitleProperty(elementAst, title))
  }
  if (displaced.summary !== undefined) {
    edits.push(updateSummaryProperty(elementAst, displaced.summary))
  }
  if (change.description !== undefined) {
    edits.push(...updateDescriptionProperty(elementAst, change.description))
  }
  const technology = change.technology ?? displaced.technology
  if (technology !== undefined) {
    edits.push(updateTechnologyProperty(elementAst, technology))
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
