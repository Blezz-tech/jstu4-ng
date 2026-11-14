import './styles/main.css';

import { mountApp, type MountedApp } from './app';

export { mountApp, type MountedApp };

export const app: MountedApp = mountApp(document);
