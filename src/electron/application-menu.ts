/**
 * @fileoverview Application menu configuration for ONIXPlayer.
 *
 * Defines the native menu bar structure for macOS and other platforms.
 * Some menu items are placeholders for future functionality.
 *
 * @module electron/application-menu
 */

import {app, Menu} from 'electron';
import type {MenuItemConstructorOptions} from 'electron';
import type {RecentItem} from './settings-manager.js';

/**
 * Available visualization types organized by category.
 * Each category becomes a submenu in the Visualizations menu.
 */
const VISUALIZATION_CATEGORIES: ReadonlyArray<{
  category: string;
  items: ReadonlyArray<{id: string; name: string}>;
}> = [
  {
    category: 'Bars',
    items: [
      {id: 'bars', name: 'Analyzer'},
      {id: 'tether', name: 'Spectre'},
    ],
  },
  {
    category: 'Waves',
    items: [
      {id: 'waveform', name: 'Classic'},
      {id: 'modern', name: 'Modern'},
      {id: 'tunnel', name: 'Plasma'},
      {id: 'infinity', name: 'Infinity'},
      {id: 'neon', name: 'Neon'},
      {id: 'onix', name: 'Onix'},
      {id: 'pulsar', name: 'Pulsar'},
      {id: 'water', name: 'Water'},
    ],
  },
];

/**
 * Available video aspect ratio options for the Playback menu.
 */
const ASPECT_RATIO_OPTIONS: ReadonlyArray<{id: string; name: string}> = [
  {id: 'default', name: 'Default'},
  {id: '4:3', name: 'Forced (4:3)'},
  {id: '16:9', name: 'Forced (16:9)'},
  {id: 'fit', name: 'Fit to Screen'},
];

/**
 * Callback functions for menu actions.
 */
export interface MenuCallbacks {
  onShowConfig: () => void;
  onShowAbout: () => void;
  onShowHelp: () => void;
  onOpenFile: () => void;
  onOpenPlaylist: () => void;
  onOpenRecentFile: (filePath: string) => void;
  onOpenRecentPlaylist: (playlistPath: string) => void;
  onClearRecent: () => void;
  onSavePlaylist: () => void;
  onSavePlaylistAs: () => void;
  onCloseMedia: () => void;
  onClosePlaylist: () => void;
  onToggleFullscreen: () => void;
  onTogglePlayPause: () => void;
  onStop: () => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  onSelectVisualization: (id: string) => void;
  onSelectAspectMode: (mode: string) => void;
}

/**
 * Menu state for checkboxes and enabled states.
 */
export interface MenuState {
  shuffleEnabled: boolean;
  repeatEnabled: boolean;
  hasMedia: boolean;
  isPlaying: boolean;
  isVideo: boolean;
  openEnabled: boolean;
  recentFiles: readonly RecentItem[];
  recentPlaylists: readonly RecentItem[];
}

/** Stored callbacks for menu recreation */
let storedCallbacks: MenuCallbacks | null = null;

/** Current menu state */
let currentState: MenuState = {shuffleEnabled: false, repeatEnabled: false, hasMedia: false, isPlaying: false, isVideo: false, openEnabled: true, recentFiles: [], recentPlaylists: []};

/**
 * Updates the menu state and rebuilds the menu.
 *
 * @param state - New state for menu checkboxes
 */
export function updateMenuState(state: Partial<MenuState>): void {
  currentState = {...currentState, ...state};
  if (storedCallbacks) {
    buildMenu(storedCallbacks, currentState);
  }
}

/**
 * Builds the Recent Items submenu.
 *
 * Structure:
 * - Recent Files (up to 10 items)
 * - Separator
 * - Recent Playlists (up to 5 items)
 * - Separator
 * - Clear Recent
 *
 * @param callbacks - Callback functions for menu actions
 * @param state - Current menu state with recent items
 * @returns Array of menu items for the submenu
 */
function buildRecentItemsSubmenu(callbacks: MenuCallbacks, state: MenuState): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const hasRecentFiles: boolean = state.recentFiles.length > 0;
  const hasRecentPlaylists: boolean = state.recentPlaylists.length > 0;
  const hasAnyRecent: boolean = hasRecentFiles || hasRecentPlaylists;

  // Recent Files section
  if (hasRecentFiles) {
    state.recentFiles.forEach((file: RecentItem): void => {
      items.push({
        label: file.displayName,
        click: (): void => callbacks.onOpenRecentFile(file.path)
      });
    });
  } else {
    items.push({
      label: 'No Recent Files',
      enabled: false
    });
  }

  items.push({type: 'separator'});

  // Recent Playlists section
  if (hasRecentPlaylists) {
    state.recentPlaylists.forEach((playlist: RecentItem): void => {
      items.push({
        label: playlist.displayName,
        click: (): void => callbacks.onOpenRecentPlaylist(playlist.path)
      });
    });
  } else {
    items.push({
      label: 'No Recent Playlists',
      enabled: false
    });
  }

  items.push({type: 'separator'});

  // Clear Recent option
  items.push({
    label: 'Clear Recent',
    enabled: hasAnyRecent,
    click: callbacks.onClearRecent
  });

  return items;
}

/**
 * Builds and sets the application menu.
 *
 * @param callbacks - Callback functions for menu actions
 * @param state - Current state for checkboxes
 */
function buildMenu(callbacks: MenuCallbacks, state: MenuState): void {
  const isMac: boolean = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  // macOS App Menu
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        {
          label: 'Settings',
          accelerator: 'Cmd+,',
          click: callbacks.onShowConfig
        },
        {type: 'separator'},
        {role: 'services'},
        {type: 'separator'},
        {role: 'hide'},
        {role: 'hideOthers'},
        {role: 'unhide'},
        {type: 'separator'},
        {role: 'quit'}
      ]
    });
  }

  // File Menu
  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Open',
        accelerator: 'CmdOrCtrl+O',
        enabled: state.openEnabled,
        click: callbacks.onOpenFile
      },
      {
        label: 'Open Playlist',
        accelerator: 'CmdOrCtrl+Shift+O',
        enabled: state.openEnabled,
        click: callbacks.onOpenPlaylist
      },
      {
        label: 'Recent Items',
        submenu: buildRecentItemsSubmenu(callbacks, state)
      },
      {type: 'separator'},
      {
        label: 'Save Playlist As...',
        accelerator: 'CmdOrCtrl+Shift+S',
        enabled: state.hasMedia,
        click: callbacks.onSavePlaylistAs
      },
      {
        label: 'Save Playlist',
        accelerator: 'CmdOrCtrl+S',
        enabled: state.hasMedia,
        click: callbacks.onSavePlaylist
      },
      {type: 'separator'},
      {
        label: 'Close',
        accelerator: 'CmdOrCtrl+W',
        enabled: state.hasMedia,
        click: callbacks.onCloseMedia
      },
      {
        label: 'Close Playlist',
        accelerator: 'CmdOrCtrl+Shift+W',
        enabled: state.hasMedia,
        click: callbacks.onClosePlaylist
      },
      ...(!isMac ? [
        {type: 'separator'} as MenuItemConstructorOptions,
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          click: (): void => app.quit()
        } as MenuItemConstructorOptions
      ] : [])
    ]
  });

  // View Menu
  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Full Screen',
        accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
        enabled: state.hasMedia,
        click: callbacks.onToggleFullscreen
      },
      {
        label: 'Mini Player',
        enabled: false // Placeholder
      },
      {type: 'separator'},
      {
        label: 'Visualizations',
        submenu: VISUALIZATION_CATEGORIES.map((cat: {category: string; items: ReadonlyArray<{id: string; name: string}>}): MenuItemConstructorOptions => ({
          label: cat.category,
          submenu: cat.items.map((viz: {id: string; name: string}): MenuItemConstructorOptions => ({
            label: viz.name,
            click: (): void => callbacks.onSelectVisualization(viz.id)
          }))
        }))
      },
      {type: 'separator'},
      {
        label: 'Options',
        accelerator: isMac ? undefined : 'Ctrl+,',
        click: callbacks.onShowConfig
      }
    ]
  });

  // Playback Menu
  template.push({
    label: 'Playback',
    submenu: [
      {
        label: state.isPlaying ? 'Pause' : 'Play',
        accelerator: 'Space',
        enabled: state.hasMedia,
        click: callbacks.onTogglePlayPause
      },
      {
        label: 'Stop',
        accelerator: 'Shift+Space',
        enabled: state.hasMedia,
        click: callbacks.onStop
      },
      {type: 'separator'},
      {
        label: 'Shuffle',
        type: 'checkbox',
        checked: state.shuffleEnabled,
        enabled: state.hasMedia,
        click: callbacks.onToggleShuffle
      },
      {
        label: 'Repeat',
        type: 'checkbox',
        checked: state.repeatEnabled,
        enabled: state.hasMedia,
        click: callbacks.onToggleRepeat
      },
      {type: 'separator'},
      {
        label: 'Aspect Ratio',
        enabled: state.isVideo,
        submenu: ASPECT_RATIO_OPTIONS.map((option: Readonly<{id: string; name: string}>): MenuItemConstructorOptions => ({
          label: option.name,
          click: (): void => callbacks.onSelectAspectMode(option.id)
        }))
      }
    ]
  });

  // Help Menu
  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Help Topics',
        click: callbacks.onShowHelp
      },
      {type: 'separator'},
      {
        label: 'About ONIXPlayer',
        click: callbacks.onShowAbout
      }
    ]
  });

  const menu: Menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Creates and sets the application menu.
 * Stores callbacks so the menu can be rebuilt when state changes.
 *
 * @param callbacks - Callback functions for menu actions
 * @param initialState - Initial state for checkboxes (optional)
 */
export function createApplicationMenu(
  callbacks: MenuCallbacks,
  initialState?: Partial<MenuState>
): void {
  storedCallbacks = callbacks;
  if (initialState) {
    currentState = {...currentState, ...initialState};
  }
  buildMenu(callbacks, currentState);
}
