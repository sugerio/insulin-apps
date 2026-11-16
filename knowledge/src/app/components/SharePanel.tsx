import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { appRoleLabel, ROLE_LABEL } from '../lib/format.ts'
import type { CollectionSummary, Member, Share, Sharing } from '../lib/types.ts'
import { useResource } from '../lib/useResource.ts'
import { ActionError, Badge, ErrorState, Loading, Note } from './Feedback.tsx'
import { Card } from './Page.tsx'

// Sharing, like a shared document (design J7, ACC-07 to ACC-09): specific people (and the organization's API clients)
// with their own roles, and everyone in the organization who can use Knowledge with one role, up to Editor; the
// highest wins. Someone whose role in Knowledge is Viewer "acts as Viewer" whatever they are given. Sharing lives
// outside the collection's content, so going back never changes it. Only the owner and admins change it.

type Role = 'VIEWER' | 'EDITOR' | 'ADMIN'
const ROLES: Role[] = ['VIEWER', 'EDITOR', 'ADMIN']

export function MemberSearch({ onPick, label, filter, placeholder = 'Search people by name or e-mail' }: {
  onPick: (member: Member) => void
  label: string
  filter?: (member: Member) => boolean
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Member[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api.get<{ members: Member[] }>(`/api/members?q=${encodeURIComponent(q.trim())}`).then(
        (body) => { if (live) { setFound(body.members); setError(null) } },
        (failure) => { if (live) setError(failure) },
      )
    }, 200)
    return () => { live = false; clearTimeout(timer) }
  }, [q])
  const list = (found ?? []).filter((member) => (filter ? filter(member) : true))
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="member-search">{label}</Label>
      <Input id="member-search" type="search" autoComplete="off" placeholder={placeholder} value={q} onChange={(event) => setQ(event.target.value)} />
      {error ? <ActionError error={error} kept={null} /> : null}
      {found && list.length === 0 ? <Note>No one found who can use Knowledge. People are invited on insulinapps.com, in Settings › People.</Note> : null}
      {list.length ? (
        <ul className="flex max-h-56 flex-col divide-y overflow-y-auto rounded-lg border" aria-label="People">
          {list.map((member) => (
            <li key={`${member.type}:${member.id}`}>
              <button type="button" className="flex w-full min-w-0 flex-col items-start px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => onPick(member)}>
                <span className="font-medium [overflow-wrap:anywhere]">{member.name}{member.type === 'client' ? ' (API client)' : ''}</span>
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{[member.email, `${appRoleLabel(member.appRole)} in Knowledge`].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function SharePanel({ collection, canShare, roleNote }: { collection: CollectionSummary; canShare: boolean; roleNote?: string }) {
  const sharing = useResource<Sharing>(collectionPath(collection.id, '/sharing'))
  const [picked, setPicked] = useState<Member | null>(null)
  const [role, setRole] = useState<Role>('VIEWER')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function change(run: () => Promise<unknown>, done: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await run()
      setNotice(done)
      await sharing.reload()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  async function share(event: FormEvent) {
    event.preventDefault()
    if (!picked) return
    const who = picked
    await change(() => api.put(collectionPath(collection.id, `/sharing/${who.type}/${encodeURIComponent(who.id)}`), { role }), `Shared with ${who.name} as ${ROLE_LABEL[role]}.${who.type === 'person' ? ' They get an e-mail with a link.' : ''}`)
    setPicked(null)
    setRole('VIEWER')
  }

  const data = sharing.data
  return (
    <Card title={`Share “${collection.name}”`}>
      {sharing.loading ? <Loading /> : sharing.error || !data ? <ErrorState error={sharing.error} onRetry={() => void sharing.reload()} /> : (
        <>
          {canShare ? (
            picked ? (
              <form className="flex flex-col gap-2 rounded-lg border p-3" onSubmit={(event) => void share(event)}>
                <p className="text-sm"><b>{picked.name}</b>{picked.email ? ` · ${picked.email}` : ''} · {appRoleLabel(picked.appRole)} in Knowledge</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="share-role">Role</Label>
                    <NativeSelect id="share-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                      {ROLES.map((value) => (
                        <NativeSelectOption key={value} value={value}>{ROLE_LABEL[value]}{picked.appRole === 'VIEWER' && value !== 'VIEWER' ? ' (acts as Viewer)' : ''}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  <Button type="submit" disabled={busy}>Share</Button>
                  <Button type="button" variant="ghost" onClick={() => setPicked(null)}>Cancel</Button>
                </div>
                {picked.appRole === 'VIEWER' ? <Note>{picked.name} can only read: their role in Knowledge is Viewer.</Note> : null}
              </form>
            ) : <MemberSearch label="Share with a person" onPick={setPicked} filter={(member) => member.id !== data.owner.id && !data.shares.some((entry) => entry.id === member.id && entry.type === member.type)} />
          ) : null}
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-muted-foreground">People with access</h3>
            <ul className="flex flex-col divide-y rounded-lg border" aria-label="People with access">
              <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 grow basis-48">
                  <b className="[overflow-wrap:anywhere]">{data.owner.name ?? 'The owner'}</b>
                  <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{data.owner.email ?? ''}{data.owner.actsAsViewer ? ' · acts as Viewer: their role in Knowledge is Viewer' : ''}</span>
                </span>
                <span className="text-muted-foreground">Owner</span>
              </li>
              {data.shares.map((entry) => (
                <ShareRow key={`${entry.type}:${entry.id}`} entry={entry} canShare={canShare} busy={busy}
                  onRole={(value) => void change(() => api.put(collectionPath(collection.id, `/sharing/${entry.type}/${encodeURIComponent(entry.id)}`), { role: value }), `${entry.name ?? 'Their'} role is now ${ROLE_LABEL[value]}.`)}
                  onRemove={() => void change(() => api.delete(collectionPath(collection.id, `/sharing/${entry.type}/${encodeURIComponent(entry.id)}`)), `Stopped sharing with ${entry.name ?? 'them'}.`)} />
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium text-muted-foreground">General access</h3>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
              <span className="min-w-0 grow basis-48">
                <label htmlFor="general-access" className="font-medium">Everyone in your organization who can use Knowledge</label>
                <span className="block text-xs text-muted-foreground">
                  {data.general ? `Each gets ${ROLE_LABEL[data.general]}, as well as anything shared with them above. Viewers in Knowledge can only read.` : 'No access: only the people above can open it.'}
                </span>
              </span>
              <NativeSelect id="general-access" size="sm" value={data.general ?? ''} disabled={!canShare || busy}
                onChange={(event) => {
                  const value = event.target.value === '' ? null : event.target.value
                  void change(() => api.put(collectionPath(collection.id, '/sharing/general'), { role: value }), value ? `Everyone in your organization now gets ${ROLE_LABEL[value as Role]}.` : 'Only the people above can open it now.')
                }}>
                <NativeSelectOption value="">No access</NativeSelectOption>
                <NativeSelectOption value="VIEWER">Viewer</NativeSelectOption>
                <NativeSelectOption value="EDITOR">Editor</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">{notice}</p> : null}
          <ActionError error={error} />
          <Note>
            {roleNote ? `${roleNote} ` : ''}Owners and admins share it and change its settings; editors change what's in it; viewers ask and read. Admin is given only to named people. Sharing changes aren't restore points: going back never changes who has access.
            If the owner leaves your organization or becomes a Viewer, an owner of the organization becomes its owner; people who leave get their access back if they return.
          </Note>
        </>
      )}
    </Card>
  )
}

function ShareRow({ entry, canShare, busy, onRole, onRemove }: { entry: Share; canShare: boolean; busy: boolean; onRole: (role: Role) => void; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 py-2 text-sm" data-share={entry.id}>
      <span className="flex min-w-0 grow basis-48 flex-col items-start gap-1">
        <span><b className="[overflow-wrap:anywhere]">{entry.name ?? 'Someone'}</b>{entry.type === 'client' ? ' (API client)' : ''}</span>
        {entry.email ? <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{entry.email}</span> : null}
        {entry.actsAsViewer ? <Badge tone="grey">Acts as Viewer: their role in Knowledge is Viewer, so they can only read</Badge> : null}
        {entry.status === 'on_hold' ? <Badge tone="amber">On hold: not in your organization right now; it comes back if they return</Badge> : null}
      </span>
      {canShare ? (
        <span className="flex shrink-0 items-center gap-2">
          <NativeSelect size="sm" aria-label={`Role for ${entry.name ?? 'this person'}`} value={entry.role} disabled={busy} onChange={(event) => onRole(event.target.value as Role)}>
            {ROLES.map((value) => <NativeSelectOption key={value} value={value}>{ROLE_LABEL[value]}{entry.actsAsViewer && value !== 'VIEWER' ? ' (acts as Viewer)' : ''}</NativeSelectOption>)}
          </NativeSelect>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>Remove</Button>
        </span>
      ) : <span className="text-muted-foreground">{ROLE_LABEL[entry.role]}{entry.actsAsViewer ? ' (acts as Viewer)' : ''}</span>}
    </li>
  )
}
