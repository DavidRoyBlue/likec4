import type { Fqn, ModelChange } from '@likec4/core/types'
import { ActionIcon, Textarea, TextInput } from '@mantine/core'
import { IconPencil } from '@tabler/icons-react'
import { type ChangeEvent, type KeyboardEvent, type PropsWithChildren, useEffect, useState } from 'react'
import { useCanEditModel } from '../../context/DiagramFeatures'
import { useDiagram } from '../../hooks/useDiagram'

/**
 * Builds a `ModelChange.ChangeElementProperty` payload for a single edited field.
 * Returns `null` when the edited value is unchanged from the original, so callers
 * can skip triggering a no-op model change.
 *
 * `description` is always sent as `{ md: value }` — the textarea is labelled
 * "Markdown", and a plain string would be printed as a single-quoted literal and
 * come back as `{ txt }`, rendering the markdown literally. Same ruling as
 * `buildViewPropertyChange` in navigationpanel/editorpanel/EditViewPropertiesButton.
 * `original` stays a plain string on both sides, so the unchanged → `null` guard
 * above is unaffected.
 */
export function buildElementPropertyChange(input: {
  target: Fqn
  field: 'title' | 'description' | 'technology'
  value: string
  original: string | null
}): ModelChange.ChangeElementProperty | null {
  if (input.value === (input.original ?? '')) {
    return null
  }
  if (input.field === 'description') {
    return {
      op: 'change-element-property',
      target: input.target,
      description: { md: input.value },
    }
  }
  return {
    op: 'change-element-property',
    target: input.target,
    [input.field]: input.value,
  }
}

type EditablePropertyProps = PropsWithChildren<{
  target: Fqn
  field: 'title' | 'description' | 'technology'
  original: string | null
  multiline?: boolean
}>

/**
 * Pencil-toggled inline editor for a single element property (title, description, technology).
 * Renders children read-only (no pencil) when the diagram is read-only OR the editor
 * port does not support model changes (see `useCanEditModel`).
 * Commits on blur or Ctrl+Enter (multiline) / Enter (single-line); Esc cancels.
 */
export function EditableProperty({
  target,
  field,
  original,
  multiline = false,
  children,
}: EditablePropertyProps) {
  const canEdit = useCanEditModel()
  const diagram = useDiagram()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  // The overlays actor (see overlaysActor.ts's `hotkeyLogic`) binds a *capture-phase* Escape
  // listener on `document.body` while any overlay is open, which unconditionally closes the
  // whole details card. Capture-phase listeners run outer-to-inner, so that listener fires
  // before our field-level `onKeyDown` below (a bubble-phase React handler on the input) ever
  // gets a chance to run -- `stopPropagation()` there is too late. Intercept on `document`
  // (an ancestor of `document.body` in the capture chain) while editing, so this runs first.
  useEffect(() => {
    if (!editing) {
      return
    }
    const onDocumentKeyDownCapture = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setEditing(false)
      }
    }
    document.addEventListener('keydown', onDocumentKeyDownCapture, { capture: true })
    return () => document.removeEventListener('keydown', onDocumentKeyDownCapture, { capture: true })
  }, [editing])

  if (!canEdit) {
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
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.currentTarget.value),
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Prevent the native <dialog>'s default Escape-to-close action (a browser default
        // outside React's synthetic event system, so stopPropagation() alone doesn't stop it)
        // from closing the whole details card — only this field's edit should cancel.
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
      if (e.key === 'Enter' && (multiline ? (e.ctrlKey || e.metaKey) : true)) {
        commit()
      }
    },
  }
  return multiline
    ? <Textarea {...inputProps} autosize minRows={3} maxRows={12} description="Markdown · Ctrl+Enter to save" />
    : <TextInput {...inputProps} />
}
