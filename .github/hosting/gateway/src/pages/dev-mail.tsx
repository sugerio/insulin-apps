// Local development only: the mail captured by the test transport. Served when SITE_ENV=test on a *.localhost host.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Container, PageHeader, proseLinks } from "@/components/layout"
import type { Context } from "../context.ts"
import type { CapturedMail } from "../db/mail.ts"
import type { Html } from "./html.ts"
import { page } from "./document.tsx"

export function mailLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => match[0])
}

export function devMailPage(ctx: Context, mails: CapturedMail[]): Html {
  return page(ctx, { title: "Captured mail" }, (
    <Container className="flex flex-col gap-6 py-10 sm:py-12">
      <PageHeader title="Captured mail" description="SITE_ENV=test: these emails were stored instead of sent. Newest first." />
      {mails.length ? (
        mails.map((mail) => (
          <Card key={mail.id}>
            <CardHeader>
              <CardTitle className="leading-snug">
                <h2>{mail.subject}</h2>
              </CardTitle>
              <CardDescription>
                To {mail.recipient} · {new Date(mail.created_at).toISOString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ul className={`flex flex-col gap-1 text-sm break-all ${proseLinks}`}>
                {mailLinks(mail.body_text).map((link, index) => (
                  <li key={index}>
                    <a href={link}>{link}</a>
                  </li>
                ))}
              </ul>
              <pre className="rounded-md bg-muted p-4 font-mono text-xs whitespace-pre-wrap break-words">{mail.body_text}</pre>
            </CardContent>
          </Card>
        ))
      ) : (
        <p className="text-muted-foreground">No mail yet.</p>
      )}
    </Container>
  ))
}
