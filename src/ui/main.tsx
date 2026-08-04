/* One bundle, three pages.
 *
 * The popup, the onboarding tab and the approval window share a bundle and are told apart by
 * `data-view` on <body>. Three separate bundles would triple React in the package for no benefit —
 * the browser caches nothing across extension pages, so the only cost that matters is the download
 * of the .crx, and that is one file.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup.tsx';
import { Onboarding } from './Onboarding.tsx';
import { Approval } from './Approval.tsx';
import './app.css';

const view = document.body.dataset['view'] ?? 'popup';
const mount = document.getElementById('root');
if (mount === null) throw new Error('ui: no #root on this page');

const App = view === 'onboarding' ? Onboarding : view === 'approval' ? Approval : Popup;

createRoot(mount).render(<StrictMode><App /></StrictMode>);
