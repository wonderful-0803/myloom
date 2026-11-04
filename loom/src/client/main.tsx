import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { LiveApp } from './LiveApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.pathname.startsWith('/orchestrator/loom') ? <LiveApp /> : <App />}
  </React.StrictMode>
);
