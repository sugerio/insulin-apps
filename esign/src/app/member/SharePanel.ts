// Who sees a template or an envelope (server/esign/ownership.ts): its owner, everyone in the organization when it is
// shared with them, and the people it is shared with and their roles. Its admins and owner share it with everyone (as
// viewers or editors) or with anyone by email (the organization's people who can use Esign are suggested), change a role, or stop sharing;
// anyone it is shared with by email can remove themselves.
import React, { useEffect, useRef, useState } from 'react'
import { Building2, Lock, UserPlus } from 'lucide-react'
import { Button } from '../components/ui/button.ts'
import { Input } from '../components/ui/input.ts'
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.ts'
import { allows, apiJson, describeError, EMAIL, ownerName, ROLE_NAMES, type Me, type Share, type Sharing } from './api.ts'
import { Field, Notice } from './parts.ts'

const h = React.createElement
const ROLE_HINTS: Record<Share['role'], string> = { viewer: 'Viewer: sees it', editor: 'Editor: also changes it', admin: 'Admin: also shares it' }
type Member = { id: string; email: string; name?: string }
/** General access: only the people it is shared with, or everyone in the organization, as viewers or editors. */
const ACCESS: Record<'' | 'viewer' | 'editor', string> = { '': 'Only the people below', viewer: 'Everyone in your organization can view', editor: 'Everyone in your organization can edit' }

/** An email field that suggests the organization's people who can use Esign (server directory.ts), by name or email. */
export function MemberEmailField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  const [found, setFound] = useState<Member[]>([])
  const latest = useRef(0)
  function typed(text: string) {
    onChange(text)
    const ask = ++latest.current
    if (text.trim().length < 2) { setFound([]); return }
    apiJson<{ members: Member[] }>(`/api/members?limit=6&q=${encodeURIComponent(text.trim())}`)
      .then((data) => { if (ask === latest.current) setFound(data.members.filter((m) => m.email.toLowerCase() !== text.trim().toLowerCase())) })
      .catch(() => { if (ask === latest.current) setFound([]) })
  }
  return h(Field, { label, htmlFor: id },
    h('div', { className: 'relative' },
      h(Input, { id, type: 'email', value, autoComplete: 'off', onChange: (e: React.ChangeEvent<HTMLInputElement>) => typed(e.target.value), onBlur: () => setFound([]) }),
      found.length ? h('ul', { role: 'listbox', 'aria-label': 'Members', className: 'absolute z-20 mt-1 w-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md' },
        ...found.map((member) => h('li', {
          key: member.id, role: 'option', 'aria-selected': false, 'aria-label': `Choose ${member.name ?? member.email} (${member.email})`, className: 'flex cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm hover:bg-accent',
          onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onClick: () => { latest.current++; setFound([]); onChange(member.email) },
        }, h('span', { className: 'font-medium' }, member.name ?? member.email), member.name ? h('span', { className: 'text-xs text-muted-foreground' }, member.email) : null))) : null))
}

/** The sharing of one template (`kind` templates) or envelope. `onLeft`: the member removed themselves and no longer sees it. */
export function SharePanel({ kind, id, me, onLeft }: { kind: 'templates' | 'envelopes'; id: string; me: Me; onLeft?: () => void }) {
  const [sharing, setSharing] = useState<Sharing | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Share['role']>('viewer')
  const [message, setMessage] = useState({ text: '', error: false })
  const [busy, setBusy] = useState(false)
  const base = `/api/${kind}/${id}/shares`

  useEffect(() => { apiJson<Sharing>(base).then(setSharing).catch((error) => setMessage({ text: describeError(error), error: true })) }, [base])
  async function send(path: string, body: unknown, done: string) {
    setBusy(true); setMessage({ text: '', error: false })
    try {
      const answer = await apiJson<Sharing | { removed: true }>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if ('removed' in answer) { onLeft?.(); return }
      setSharing(answer); setMessage({ text: done, error: false })
    } catch (error) { setMessage({ text: describeError(error), error: true }) }
    finally { setBusy(false) }
  }
  function share() {
    const to = email.trim()
    if (!EMAIL.test(to)) { setMessage({ text: 'Enter the email address of the person to share with.', error: true }); return }
    void send(base, { email: to, role }, `Shared with ${to} as ${ROLE_NAMES[role].toLowerCase()}.`).then(() => setEmail(''))
  }

  if (!sharing) return h(Notice, { message: message.text || 'Loading who sees it…', error: message.error })
  const admin = allows(sharing.myRole, 'admin')
  const own = me.user?.email?.toLowerCase()
  const everyone = sharing.organization?.role ?? ''
  function setAccess(to: '' | 'viewer' | 'editor') {
    if (to === everyone) return
    void (to ? send(base, { organization: true, role: to }, `${ACCESS[to]} it.`) : send(`${base}/delete`, { organization: true }, 'No longer shared with everyone in your organization.'))
  }
  return h('div', { className: 'flex flex-col gap-4' },
    h('p', { className: 'text-sm text-muted-foreground' }, 'Owner: ', h('span', { className: 'font-medium text-foreground' }, ownerName(sharing.owner, me)),
      sharing.owner.kind === 'client' ? ' (an API client)' : '', `. Your role: ${ROLE_NAMES[sharing.myRole]}.`),
    h(Notice, { message: message.text, error: message.error }),
    h('section', { className: 'flex items-center gap-3 rounded-md border p-3' },
      h(everyone ? Building2 : Lock, { className: 'size-4 shrink-0 text-muted-foreground', 'aria-hidden': true }),
      h('div', { className: 'flex min-w-0 flex-1 flex-col gap-1' },
        h('span', { className: 'text-sm font-medium' }, 'General access'),
        admin ? h(NativeSelect, { id: `${kind}-${id}-access`, 'aria-label': 'General access', value: everyone, disabled: busy, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setAccess(e.target.value as '' | 'viewer' | 'editor') },
          ...(['', 'viewer', 'editor'] as const).map((r) => h(NativeSelectOption, { key: r || 'none', value: r }, ACCESS[r])))
          : h('span', { className: 'text-sm text-muted-foreground' }, `${ACCESS[everyone]}.`),
        h('span', { className: 'text-xs text-muted-foreground' }, everyone ? 'Everyone who signs in to Esign from your organization finds it in their lists. Someone shared below as well gets the higher role.' : 'Only its owner and the people it is shared with see it.'))),
    // Owned by an API client: the people its settings name see it too, as admins (set on the platform's API access page).
    sharing.client ? h('section', { 'aria-label': 'From the API client\'s settings', className: 'flex flex-col gap-1 rounded-md border p-3 text-sm' },
      h('span', { className: 'font-medium' }, 'From the API client\'s settings'),
      h('span', { className: 'text-muted-foreground' }, `Admin: ${sharing.client.people.map((p) => (p.name ? `${p.name} (${p.email})` : p.email)).join(', ')}`),
      h('span', { className: 'text-xs text-muted-foreground' }, 'Everything this API client creates is theirs to see. Change who on API access, in Esign\'s settings.')) : null,
    sharing.shares.length === 0 ? h('p', { className: 'text-sm text-muted-foreground' }, 'Not shared with anyone by email.')
      : h(Table, { 'aria-label': 'Shared with' },
        h(TableHeader, null, h(TableRow, null, h(TableHead, null, 'Shared with'), h(TableHead, null, 'Role'), h(TableHead, null, h('span', { className: 'sr-only' }, 'Actions')))),
        h(TableBody, null, ...sharing.shares.map((s) => {
          const self = s.email.toLowerCase() === own
          return h(TableRow, { key: s.email.toLowerCase() },
            h(TableCell, { className: 'whitespace-normal' }, s.name ? h('div', { className: 'font-medium' }, s.name) : null, h('div', { className: s.name ? 'text-xs text-muted-foreground' : '' }, s.email)),
            h(TableCell, null, admin ? h(NativeSelect, { 'aria-label': `Role of ${s.email}`, value: s.role, disabled: busy, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void send(base, { email: s.email, role: e.target.value }, `${s.email} is now ${ROLE_NAMES[e.target.value as Share['role']].toLowerCase()}.`) },
              ...(['viewer', 'editor', 'admin'] as const).map((r) => h(NativeSelectOption, { key: r, value: r }, ROLE_NAMES[r]))) : ROLE_NAMES[s.role]),
            h(TableCell, { className: 'text-right' }, admin || self ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, 'aria-label': self ? 'Stop sharing with me' : `Stop sharing with ${s.email}`, onClick: () => void send(`${base}/delete`, { email: s.email }, `No longer shared with ${s.email}.`) }, self ? 'Leave' : 'Remove') : null))
        }))),
    admin ? h('div', { className: 'grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]' },
      h(MemberEmailField, { id: `${kind}-${id}-share-email`, label: 'Share with (email)', value: email, onChange: setEmail }),
      h(Field, { label: 'Role', htmlFor: `${kind}-${id}-share-role` },
        h(NativeSelect, { id: `${kind}-${id}-share-role`, value: role, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setRole(e.target.value as Share['role']) },
          ...(['viewer', 'editor', 'admin'] as const).map((r) => h(NativeSelectOption, { key: r, value: r }, ROLE_HINTS[r])))),
      h(Button, { disabled: busy, onClick: share }, h(UserPlus, { 'aria-hidden': true }), 'Share')) : null)
}
