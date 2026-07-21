import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

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
