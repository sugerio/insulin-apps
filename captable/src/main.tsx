import { createRoot } from 'react-dom/client'
// First: the AppBuilder's preview bridge observes the app from its first module on.
import { SugerAppBuilderRuntime } from './suger-app-builder-runtime'
import App from './app/App'

createRoot(document.getElementById('root') as HTMLElement).render(
  <SugerAppBuilderRuntime>
    <App />
  </SugerAppBuilderRuntime>,
)
