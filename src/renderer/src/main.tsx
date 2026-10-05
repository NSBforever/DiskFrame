import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The app is loaded after the first frame, not before it. Evaluating the bundle
// is one long task, and Chromium does not paint until it ends - so the static
// shell in index.html (the drive page's header) never reached the screen and
// the window stayed blank until React's first render. Yielding one frame lets
// that shell paint while the app itself is still loading.
requestAnimationFrame(() => {
  setTimeout(() => {
    void import('./App').then(({ default: App }) => {
      createRoot(document.getElementById('root')!).render(
        <StrictMode>
          <App />
        </StrictMode>
      )
    })
  }, 0)
})
