// A list's filters by ownership and by the member's own tags (server/esign/ownership.ts, tags.ts): everything they
// see, theirs, or what is shared with them; and only what has every tag typed.
import React, { useState } from 'react'
import { Input } from '../components/ui/input.ts'
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.ts'
import { tagsOf, type Scope } from './api.ts'

const h = React.createElement

export function ListFilters({ id, scope, onScope, onTags }: { id: string; scope: Scope; onScope: (scope: Scope) => void; onTags: (tags: string[]) => void }) {
  const [text, setText] = useState('')
  // Filtered when the field is left or Enter is pressed, not at each keystroke.
  const apply = () => onTags(tagsOf(text).slice(0, 5))
  return h('div', { className: 'flex flex-wrap items-end gap-4' },
    h('div', { className: 'flex w-56 flex-col gap-2' },
      h('label', { htmlFor: `${id}-scope`, className: 'text-sm font-medium' }, 'Show'),
      h(NativeSelect, { id: `${id}-scope`, value: scope, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onScope(e.target.value as Scope) },
        h(NativeSelectOption, { value: '' }, 'All I can see'),
        h(NativeSelectOption, { value: 'mine' }, 'Mine'),
        h(NativeSelectOption, { value: 'shared' }, 'Shared with me'))),
    h('div', { className: 'flex w-64 flex-col gap-2' },
      h('label', { htmlFor: `${id}-tags`, className: 'text-sm font-medium' }, 'With your tags'),
      h(Input, { id: `${id}-tags`, value: text, placeholder: 'nda, partners', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value), onBlur: apply, onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') apply() } })))
}
