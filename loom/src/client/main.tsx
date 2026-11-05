import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';

// Separate chunks keep the demo's and the live workspace's stylesheets from loading together.
const live = window.location.pathname.startsWith('/orchestrator/loom');
const Root = live ? lazy(() => import('./LiveApp').then(m => ({ default: m.LiveApp }))) : lazy(() => import('./App').then(m => ({ default: m.App })));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={null}><Root /></Suspense>
  </React.StrictMode>
);
