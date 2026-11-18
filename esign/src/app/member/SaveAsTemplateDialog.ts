// Save as template (POST /api/templates with fromEnvelope): a new template of an envelope sent with a document uploaded
// with it: its PDF and fields, under a name, each role renamed if wanted (its signer shown beside it), and optionally its
// signers as the template's default signers. The envelope is untouched.
import React, { useEffect, useState } from 'react'
import { Button } from '../components/ui/button.ts'
import { checkClass, Input } from '../components/ui/input.ts'
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.ts'
import { apiJson, describeError } from './api.ts'
import { Field, Notice } from './parts.ts'
import { Link } from './router.ts'

const h = React.createElement
const ROLE = /^[A-Za-z0-9_-]{1,64}$/
export type SavedSigner = { role: string; name: string; email: string }

/** Saves the template of an envelope; `signers` are its signers in order, each with their role. */
export async function saveAsTemplate(envelopeId: string, request: { name?: string; roles?: string[]; defaultSigners?: boolean } = {}): Promise<{ id: string; name?: string }> {
  return apiJson<{ id: string; name?: string }>('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromEnvelope: envelopeId, ...request }) })
}

export function SaveAsTemplateDialog({ open, envelopeId, documentName, signers, onClose }: { open: boolean; envelopeId: string; documentName?: string; signers: SavedSigner[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [roles, setRoles] = useState<string[]>([])
  const [keepSigners, setKeepSigners] = useState(false)
  const [message, setMessage] = useState({ text: '', error: false })
  const [saved, setSaved] = useState<{ id: string; name?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(documentName ?? ''); setRoles(signers.map((s) => s.role)); setKeepSigners(false); setMessage({ text: '', error: false }); setSaved(null)
  }, [open, envelopeId])
  function save() {
    const names = roles.map((r) => r.trim())
    if (!name.trim()) { setMessage({ text: 'Name the template.', error: true }); return }
    if (names.some((r) => !ROLE.test(r))) { setMessage({ text: 'Use letters, digits, - and _ in role names (no spaces).', error: true }); return }
    if (new Set(names.map((r) => r.toLowerCase())).size !== names.length) { setMessage({ text: 'Give each role a different name.', error: true }); return }
    setBusy(true); setMessage({ text: '', error: false })
    saveAsTemplate(envelopeId, { name: name.trim(), roles: names, defaultSigners: keepSigners })
      .then(setSaved)
      .catch((error) => setMessage({ text: describeError(error), error: true }))
      .finally(() => setBusy(false))
  }
  return h(Dialog, { open, onOpenChange: (o) => { if (!o) onClose() }, label: 'Save as template', dismissible: !busy, className: 'sm:max-w-xl' },
    open ? [
      h(DialogHeader, { key: 'header' }, h(DialogTitle, null, 'Save as template'),
        h(DialogDescription, null, 'A new template with this envelope\'s PDF and fields, to send again. The envelope is not changed.')),
      saved ? h('p', { key: 'saved', role: 'status', className: 'text-sm' }, 'Saved as the template ', h(Link, { to: `/templates/${saved.id}`, className: 'font-medium underline underline-offset-4' }, saved.name ?? saved.id), '. It is ready to use.')
        : h('div', { key: 'form', className: 'flex flex-col gap-4' },
          h(Notice, { message: message.text, error: message.error }),
          h(Field, { label: 'Template name', htmlFor: 'save-template-name' }, h(Input, { id: 'save-template-name', value: name, maxLength: 200, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value) })),
          h('fieldset', { className: 'flex flex-col gap-3' },
            h('legend', { className: 'mb-1 text-sm font-medium' }, 'Roles, in signing order'),
            ...signers.map((s, i) => h('div', { key: i, className: 'grid items-center gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]' },
              h(Input, { id: `save-template-role-${i}`, 'aria-label': `Role ${i + 1}`, value: roles[i] ?? '', maxLength: 64, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRoles((old) => old.map((r, j) => (j === i ? e.target.value : r))) }),
              h('span', { className: 'text-sm text-muted-foreground' }, `${s.name} (${s.email})`)))),
          h('label', { className: 'flex items-center gap-2 text-sm' },
            h('input', { id: 'save-template-signers', type: 'checkbox', className: checkClass, checked: keepSigners, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKeepSigners(e.target.checked) }),
            'Keep these people as the default signers')),
      h(DialogFooter, { key: 'footer' },
        h(Button, { variant: 'outline', disabled: busy, onClick: onClose }, saved ? 'Close' : 'Cancel'),
        saved ? null : h(Button, { disabled: busy, onClick: save }, busy ? 'Saving…' : 'Save as template')),
    ] : null)
}
