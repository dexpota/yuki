import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/almarai/latin-400.css';
import '@fontsource/almarai/latin-700.css';
import '@fontsource/almarai/latin-800.css';
import { App } from './shared/app/App.js';
import './shared/app/app.css';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('The application root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
