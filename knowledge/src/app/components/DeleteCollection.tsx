import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { api, collectionPath } from '../lib/api.ts'
import { ActionError } from './Feedback.tsx'

// Deleting a collection (design J7b, DEL-02): its owner, or an owner of the organization, one at a time, after typing
// its name. The server checks both again; when an organization owner deletes someone else's collection, its owner gets
// an e-mail.

export function DeleteCollectionDialog({ collection, byOrgOwner, open, onOpenChange, onDeleted }: {
  collection: { id: string; name: string; ownerName: string | null }
  /** An organization owner deleting a collection they don't own (and can't open). */
  byOrgOwner: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (state: 'deleting' | 'deleted') => void
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = await api.delete<{ state: 'deleting' | 'deleted' }>(collectionPath(collection.id), { confirmName: typed })
      onDeleted(body.state)
      onOpenChange(false)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(value) => { setTyped(''); setError(null); onOpenChange(value) }}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="[overflow-wrap:anywhere]">Delete “{collection.name}”?</DialogTitle>
            <DialogDescription>This can't be undone.</DialogDescription>
          </DialogHeader>
          <ul className="list-disc pl-5 text-sm">
            <li>Its files, notes, facts and backups are removed now. Saved restore points can't be opened afterwards and expire within 30 days.</li>
            <li>Everyone it's shared with loses access{byOrgOwner ? `, and ${collection.ownerName ?? 'its owner'}, its owner, gets an e-mail that an owner of your organization deleted it` : ''}.</li>
            <li>{byOrgOwner ? "You can't export it first: you don't have access to its content." : 'Export it first, from Sharing, if you might need it.'}</li>
          </ul>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-name">Type the collection's name to confirm</Label>
            <Input id="delete-name" autoComplete="off" value={typed} placeholder={collection.name} onChange={(event) => setTyped(event.target.value)} />
          </div>
          <ActionError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={busy || typed.trim() !== collection.name}>{busy ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
