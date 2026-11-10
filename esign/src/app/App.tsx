import './styles.css'
import { StrictMode } from 'react'
import { CopyPage } from './ui/CopyPage.ts'
import { DemoPage } from './ui/DemoPage.ts'
import { EditorPage } from './ui/EditorPage.ts'
import { RecipientPage } from './ui/RecipientPage.ts'

/**
 * The pages, by path. Three are for people outside the organization and need no sign-in (the
 * paths are public in package.json `insulin.publicPaths`): the signing page a host embeds
 * (/sign#code=…), the field editor a host embeds (/editor/page/:id#…) and the signed-copy link
 * (/copy#token=…). Everything else is for the organization's members, behind the platform's
 * sign-in.
 */
export function pageFor(pathname: string) {
  if (pathname === '/sign' || pathname === '/sign/') return RecipientPage
  if (/^\/editor\/page\/[a-f0-9]{64}\/?$/.test(pathname)) return EditorPage
  if (pathname === '/copy' || pathname === '/copy/') return CopyPage
  return DemoPage
}

export default function App() {
  const Page = pageFor(window.location.pathname)
  return (
    <StrictMode>
      <Page />
    </StrictMode>
  )
}
