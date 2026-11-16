import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { quotaOf } from '../lib/api.ts'
import { supportAddress } from '../lib/format.ts'

// The awake-hours stop (design section 12, LIM-01): at 100% of this month's awake hours Knowledge stops answering until
// the 1st, and the site says so in a pop-up with the API's own message, which names Insulin Apps support's address when
// the deploy configured one (SUGER_SUPPORT_EMAIL). Every other limit is shown where it happened, in the API's words.

interface LimitContext {
  /** Opens the pop-up for an awake-hours stop; true when `error` was one. */
  stopIfAwakeHours: (error: unknown) => boolean
}

const Context = createContext<LimitContext>({ stopIfAwakeHours: () => false })

export function LimitProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const stopIfAwakeHours = useCallback((error: unknown) => {
    const quota = quotaOf(error)
    if (!quota || quota.limit !== 'awake_hours_month') return false
    setCopied('')
    setMessage(quota.message)
    return true
  }, [])
  const value = useMemo(() => ({ stopIfAwakeHours }), [stopIfAwakeHours])
  const address = message ? supportAddress(message) : null
  async function copy() {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied('Copied the address.')
    } catch {
      setCopied(`Select and copy: ${address}`)
    }
  }
  return (
    <Context value={value}>
      {children}
      <Dialog open={message !== null} onOpenChange={(open) => { if (!open) setMessage(null) }}>
        <DialogContent data-limit-dialog="">
          <DialogHeader>
            <DialogTitle>Knowledge has stopped for this month</DialogTitle>
            <DialogDescription>{message}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Everything your organization has learned is kept. Questions work again on the 1st of next month, or sooner if Insulin Apps raises the limit.
          </p>
          <p className="text-sm text-muted-foreground empty:hidden" role="status">{copied}</p>
          <DialogFooter>
            {address ? <Button type="button" variant="outline" onClick={() => void copy()}>Copy the address</Button> : null}
            <Button type="button" onClick={() => setMessage(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context>
  )
}

export const useLimitStop = () => useContext(Context)
