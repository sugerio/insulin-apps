// /super/audit: everything operators did, and every sign-in to the console, newest first, with the reason each gave.
// The same table shows one organization's or account's history on its page.
import { Card, CardContent } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Context } from "../../context.ts"
import type { OperatorSession } from "../../super/auth.ts"
import type { AuditRow } from "../../super/db.ts"
import { superPage } from "./layout.tsx"
import { when } from "./parts.tsx"

const ACTIONS: Record<string, string> = {
  sign_in: "Signed in",
  "org.suspend": "Suspended the organization",
  "org.disable": "Disabled the organization",
  "org.reinstate": "Reinstated the organization",
  "org.create": "Created the organization for someone",
  "user.suspend": "Suspended the account",
  "user.disable": "Disabled the account",
  "user.reinstate": "Reinstated the account",
}

function Target({ row }: { row: AuditRow }) {
  if (!row.target_type || !row.target_id) return <>–</>
  const href = row.target_type === "org" ? `/super/orgs/${row.target_id}` : `/super/users/${row.target_id}`
  return <a href={href} className="underline-offset-4 hover:underline">{row.target_label ?? row.target_id}</a>
}

export function AuditTable({ rows, showTarget = true }: { rows: AuditRow[]; showTarget?: boolean }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing yet.</p>
  return (
    <Table>
      <TableCaption className="sr-only">Audit log</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Operator</TableHead>
          <TableHead>What</TableHead>
          {showTarget ? <TableHead>Of</TableHead> : null}
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-nowrap">{when(row.at)}</TableCell>
            <TableCell className="max-w-56 truncate">{row.operator_email}</TableCell>
            <TableCell>{ACTIONS[row.action] ?? row.action}</TableCell>
            {showTarget ? <TableCell className="max-w-64 truncate"><Target row={row} /></TableCell> : null}
            <TableCell className="min-w-48 whitespace-normal">{row.reason ?? ""}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function auditPage(ctx: Context, session: OperatorSession, rows: AuditRow[]): Response {
  const last = rows[rows.length - 1]
  return superPage(ctx, session, { title: "Audit log", current: "audit", description: "What operators did, and every sign-in to the console. Kept for good." }, (
    <>
      <Card className="py-0">
        <CardContent className="px-0">
          <AuditTable rows={rows} />
        </CardContent>
      </Card>
      {rows.length === 100 && last ? (
        <div>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={`/super/audit?before=${last.id}`}>Older</a>
        </div>
      ) : null}
    </>
  ))
}
