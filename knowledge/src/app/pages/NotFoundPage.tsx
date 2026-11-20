import { Link } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '../components/Feedback.tsx'
import { Page, PageHead } from '../components/Page.tsx'

export function NotFoundPage() {
  return (
    <Page title="Not found">
      <PageHead title="There's nothing here" />
      <p className="text-sm text-muted-foreground">The link may be wrong, or the page was moved.</p>
      <div><Button asChild variant="outline"><Link to="/">Go to Home</Link></Button></div>
    </Page>
  )
}

/** A page that needs a permission the person's role in Knowledge doesn't have. */
export function NoPermissionPage({ title, message }: { title: string; message: string }) {
  return (
    <Page title={title}>
      <PageHead title={title} />
      <Banner kind="info" title="Your role doesn't include this page">{message}</Banner>
      <div><Button asChild variant="outline"><Link to="/">Go to Home</Link></Button></div>
    </Page>
  )
}
