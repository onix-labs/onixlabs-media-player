/**
 * @fileoverview Angular application configuration.
 *
 * This module defines the application-wide configuration for the Angular app,
 * including all root-level providers. Using ApplicationConfig with standalone
 * components replaces the traditional AppModule approach.
 *
 * Configuration includes:
 * - Global error listeners for unhandled errors and promise rejections
 * - Router configuration (currently empty as this is a single-view app)
 *
 * Note: This app doesn't use traditional Angular routing because it's a
 * media player with a single main view. The router is included for future
 * extensibility (e.g., settings page, library view).
 *
 * @module app/app.config
 */

import {ApplicationConfig, provideBrowserGlobalErrorListeners} from '@angular/core';
import {provideRouter} from '@angular/router';

import {routes} from './app.routes';

/**
 * Application configuration object for Angular's bootstrapApplication.
 *
 * This configuration is passed to bootstrapApplication() in main.ts and
 * provides all the dependency injection tokens needed at the application root.
 *
 * Providers included:
 * - `provideBrowserGlobalErrorListeners()` - Sets up global error handling
 *   for uncaught errors and unhandled promise rejections
 * - `provideRouter(routes)` - Configures the Angular router with the app's
 *   route definitions
 *
 * @example
 * // In main.ts
 * bootstrapApplication(Root, appConfig);
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes)
  ]
};
