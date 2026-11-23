import './app.css'
import { StrictMode, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { Banner, Loading } from './components/Feedback.tsx'
import { LimitProvider } from './components/LimitDialog.tsx'
import { Shell } from './components/Shell.tsx'
import { describeError } from './lib/api.ts'
import type { Me } from './lib/types.ts'
import { AttentionPage } from './pages/AttentionPage.tsx'
import { CollectionPage } from './pages/collection/CollectionPage.tsx'
import { CollectionsPage } from './pages/CollectionsPage.tsx'
import { DocsPage } from './pages/DocsPage.tsx'
import { HealthPage } from './pages/HealthPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { NewCollectionPage } from './pages/NewCollectionPage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'
import { RulesPage } from './pages/RulesPage.tsx'
import { SessionProvider, useSession } from './session.tsx'

// Knowledge's pages inside the shell (components/Shell.tsx): Home, Collections (with each collection's tabs), Needs
// attention, Rules and data and Health for admins, and the in-app Docs, which every role opens, before any collection
// exists too. Every page reads and changes things through the API (src/app/server/), which checks every request.

export function Pages() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/collections" element={<CollectionsPage />} />
      <Route path="/collections/new" element={<NewCollectionPage />} />
      <Route path="/collections/:id" element={<CollectionPage />} />
      <Route path="/collections/:id/:tab" element={<CollectionPage />} />
      <Route path="/attention" element={<AttentionPage />} />
      <Route path="/rules" element={<RulesPage />} />
      <Route path="/health" element={<HealthPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/docs/:topic" element={<DocsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

/** The shell once the person is known; before that a quiet line, and if Knowledge can't be used, why. */
export function Framed({ children }: { children: ReactNode }) {
  const { me, meError, collections } = useSession()
  if (meError) {
    return (
      <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
        <Banner kind="danger" title="Knowledge can't open right now">{describeError(meError)}</Banner>
        <p className="text-sm text-muted-foreground">
          Sign in on insulin-apps.com and open Knowledge from there. If you have just been invited, ask an admin of your organization to give you a role in Knowledge.
        </p>
      </main>
    )
  }
  if (!me) return <Loading label="Opening Knowledge…" />
  return <Shell me={me} collections={collections}>{children}</Shell>
}

export function KnowledgeApp({ me }: { me?: Me }) {
  return (
    <SessionProvider initial={me ? { me } : undefined}>
      <LimitProvider>
        <Framed><Pages /></Framed>
      </LimitProvider>
    </SessionProvider>
  )
}

export default function App() {
  return (
    <StrictMode>
      <BrowserRouter>
        <KnowledgeApp />
      </BrowserRouter>
    </StrictMode>
  )
}
