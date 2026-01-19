/**
 * @fileoverview Angular application entry point.
 *
 * This is the bootstrap file that initializes the Angular application within
 * the Electron renderer process. It uses Angular's standalone component
 * architecture (no NgModule required).
 *
 * The bootstrap process:
 * 1. Imports the Root component (the application shell)
 * 2. Imports the application configuration (providers, routing)
 * 3. Calls bootstrapApplication to mount the app to the DOM
 *
 * Error handling: Any bootstrap errors are logged to the console, which
 * appears in Electron's DevTools for debugging.
 *
 * @module src/main
 */

import {bootstrapApplication} from '@angular/platform-browser';
import {appConfig} from './angular/app.config';
import {Root} from './angular/components/root/root';

/**
 * Bootstrap the Angular application.
 *
 * This call mounts the Root component to the DOM element matching the
 * 'app-root' selector (defined in index.html). The appConfig provides
 * all necessary Angular providers including routing.
 *
 * @see {@link Root} - The root component that serves as the application shell
 * @see {@link appConfig} - Application-wide configuration and providers
 */
bootstrapApplication(Root, appConfig).catch((error: unknown): void => console.error(error));
