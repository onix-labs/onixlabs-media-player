/**
 * @fileoverview Angular route definitions.
 *
 * This module defines the application's routing configuration. Currently empty
 * because the media player is a single-view application - all UI is rendered
 * directly in the Root component hierarchy.
 *
 * The routes array is kept as a placeholder for future extensibility:
 * - Settings/preferences page
 * - Media library browser
 * - Playlist management view
 * - About/help page
 *
 * Navigation in the current app is handled through component visibility
 * toggling (e.g., playlist panel) rather than route changes.
 *
 * @module app/app.routes
 */

import {Routes} from '@angular/router';

/**
 * Application route definitions.
 *
 * Currently an empty array as the app uses a single-view architecture.
 * All navigation is handled through component state (showing/hiding panels)
 * rather than Angular routing.
 *
 * @example
 * // Future route additions might look like:
 * // export const routes: Routes = [
 * //   { path: '', component: PlayerView },
 * //   { path: 'settings', component: SettingsView },
 * //   { path: 'library', component: LibraryView }
 * // ];
 */
export const routes: Routes = [];
