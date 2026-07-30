import { type scalar, nonNullable } from '@likec4/core'
import {
  type AnyOp,
  indent,
  materialize,
  newline,
  ops,
  print,
  printOperation,
  withctx,
} from '@likec4/generators/likec4'
import { filter, findLast, hasAtLeast, isTruthy, last, map, pipe, piped } from 'remeda'
import { Position, TextEdit } from 'vscode-languageserver-protocol'
import { ast } from '../ast'

// A node whose body has props with $cstNode — both ast.LikeC4View and ast.Element satisfy this
export type PropsBodyNode = {
  $cstNode?: ast.LikeC4View['$cstNode']
  body?: {
    $cstNode?: ast.LikeC4View['$cstNode']
    // key OPTIONAL — ElementProperty includes MetadataProperty (no key assignment);
    // findExistingProperty's `p.key === property` comparison stays sound.
    props: Array<{ key?: string | undefined; $cstNode?: ast.LikeC4View['$cstNode'] }>
    tags?: ast.Tags | undefined
  } | undefined
}

type PropOf = NonNullable<PropsBodyNode['body']>['props'][number]

type WithCst<T extends { $cstNode?: any }> = T & { $cstNode: NonNullable<T['$cstNode']> }

export function findExistingProperty<
  P extends PropOf['key'],
  T extends WithCst<PropOf & { key: P }> = WithCst<PropOf & { key: P }>,
>(
  node: PropsBodyNode,
  property: P,
): T | undefined {
  const props = node.body?.props
  if (!props || !hasAtLeast(props, 1)) {
    return undefined
  }
  return findLast(props, (p): p is T => p.key === property && p.$cstNode !== undefined)
}

export function findInsertPosition(
  node: PropsBodyNode,
  select: (body: NonNullable<PropsBodyNode['body']>) => Position | undefined,
) {
  const body = nonNullable(node.body, 'Node body is required')
  const position = select(body)
  if (!position) {
    return Position.create(0, 0)
  }
  const { line, character } = position
  return Position.create(line, character + 1)
}

export const doubleIndent = (op: AnyOp): AnyOp =>
  piped(
    newline(),
    indent(
      indent(op),
    ),
  )

export function updateTitleProperty(node: PropsBodyNode, title: string): TextEdit {
  const existing = findExistingProperty(node, 'title')

  const titleOut = withctx({ title })(
    ops.props.titleProperty(),
  )

  // Replace existing title property
  if (existing) {
    return TextEdit.replace(
      existing.$cstNode.range,
      printOperation(titleOut),
    )
  }

  // Insert new title property, after tags or at the body start
  return TextEdit.insert(
    findInsertPosition(
      node,
      body =>
        // right after tags
        body.tags?.$cstNode?.range.end
          //  or after "{" (view body start)
          ?? body.$cstNode?.range.start,
    ),
    materialize(
      doubleIndent(titleOut),
    ).trimEnd(),
  )
}

export function updateSummaryProperty(node: PropsBodyNode, summary: string): TextEdit {
  const existing = findExistingProperty(node, 'summary')

  const summaryOut = withctx({ summary })(
    ops.props.summaryProperty(),
  )

  if (existing) {
    return TextEdit.replace(
      existing.$cstNode.range,
      printOperation(summaryOut),
    )
  }

  return TextEdit.insert(
    findInsertPosition(
      node,
      body =>
        body.tags?.$cstNode?.range.end
          ?? body.$cstNode?.range.start,
    ),
    materialize(
      doubleIndent(summaryOut),
    ).trimEnd(),
  )
}

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

function collectAllTagRefs(tags: ast.Tags | undefined): Array<WithCst<ast.TagRef>> {
  // Linked list: body.tags is the last comma-separated group, prev points backward.
  // Within each group, values are in document order.
  // We collect groups in reverse, then reverse the groups (not their contents) to get document order.
  const groups: Array<Array<WithCst<ast.TagRef>>> = []
  let iter = tags
  while (iter) {
    const group: Array<WithCst<ast.TagRef>> = []
    for (const ref of iter.values) {
      if (ref.$cstNode) {
        group.push(ref as WithCst<ast.TagRef>)
      }
    }
    groups.push(group)
    iter = iter.prev
  }
  return groups.reverse().flat()
}

function addTag(node: PropsBodyNode, body: NonNullable<PropsBodyNode['body']>, tagName: scalar.Tag): TextEdit {
  const tagsNode = body.tags

  // Append to existing tags
  if (tagsNode?.$cstNode) {
    return TextEdit.insert(
      tagsNode.$cstNode.range.end,
      `, #${tagName}`,
    )
  }

  // Insert new tags line at body start (right after "{")
  return TextEdit.insert(
    findInsertPosition(
      node,
      body => body.$cstNode?.range.start,
    ),
    materialize(
      doubleIndent(
        print(`#${tagName}`),
      ),
    ).trimEnd(),
  )
}

function removeTag(body: NonNullable<PropsBodyNode['body']>, tagName: scalar.Tag): TextEdit | undefined {
  const allRefs = collectAllTagRefs(body.tags)
  const targetIndex = allRefs.findIndex(ref => ref.tag.ref?.name === tagName)

  if (targetIndex < 0) {
    return undefined
  }

  // Only one tag — remove the entire tags line (including its trailing newline)
  if (allRefs.length === 1) {
    const tagsNode = body.tags
    if (tagsNode?.$cstNode) {
      const { start } = tagsNode.$cstNode.range
      return TextEdit.del({
        start: Position.create(start.line, 0),
        end: Position.create(start.line + 1, 0),
      })
    }
    return undefined
  }

  const target = allRefs[targetIndex]!

  if (targetIndex > 0) {
    // Not first — remove from previous tag end to this tag end
    const prev = allRefs[targetIndex - 1]!
    return TextEdit.del({
      start: prev.$cstNode.range.end,
      end: target.$cstNode.range.end,
    })
  }

  // First tag — remove from this tag start to next tag start
  const next = allRefs[targetIndex + 1]!
  return TextEdit.del({
    start: target.$cstNode.range.start,
    end: next.$cstNode.range.start,
  })
}

export function updateTags(
  node: PropsBodyNode,
  tag: {
    add?: scalar.Tag | scalar.Tag[] | undefined
    remove?: scalar.Tag | scalar.Tag[] | undefined
  },
): TextEdit[] {
  const edits: TextEdit[] = []
  const body = nonNullable(node.body, 'Node body is required')

  if (tag.add) {
    const names = Array.isArray(tag.add) ? tag.add : [tag.add]
    for (const name of names) {
      if (name) {
        edits.push(addTag(node, body, name))
      }
    }
  }
  if (tag.remove) {
    const names = Array.isArray(tag.remove) ? tag.remove : [tag.remove]
    for (const name of names) {
      const edit = name ? removeTag(body, name) : undefined
      if (edit) {
        edits.push(edit)
      }
    }
  }

  return edits
}

export function updateDescriptionProperty(
  node: PropsBodyNode,
  description: scalar.MarkdownOrString | string,
): TextEdit[] {
  const existing = findExistingProperty(node, 'description')

  const descriptionOut = withctx(
    { description },
    indent(
      indent(
        ops.props.descriptionProperty(),
      ),
    ),
  )

  // Replace existing description property
  if (existing) {
    return [TextEdit.replace(
      {
        start: {
          line: existing.$cstNode.range.start.line,
          character: 0,
        },
        end: existing.$cstNode.range.end,
      },
      materialize(
        descriptionOut,
      ).trimEnd(),
    )]
  }
  // Insert new description
  const insertPosition = findInsertPosition(
    node,
    body =>
      // After last property
      pipe(
        body.props,
        map(p => p.$cstNode?.range.end),
        filter(isTruthy),
        last(),
      )
        // or after tags
        ?? body.tags?.$cstNode?.range.end
        //  or after "{" (view body start)
        ?? body.$cstNode?.range.start,
  )
  // Move to the next line and add the description
  return [
    TextEdit.insert(
      {
        line: insertPosition.line + 1,
        character: 0,
      },
      materialize(descriptionOut),
    ),
  ]
}
