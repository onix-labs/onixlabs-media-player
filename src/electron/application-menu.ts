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
      {id: 'tunnel', name: 'Flare'},
      {id: 'infinity', name: 'Infinity'},
      {id: 'neon', name: 'Neon'},
      {id: 'onix', name: 'Onix'},
      {id: 'pulsar', name: 'Pulsar'},
      {id: 'water', name: 'Water'},
    ],
  },
];

/**
 * Callback functions for menu actions.
 */
export interface MenuCallbacks {
  onShowConfig: () => void;
  onShowAbout: () => void;
  onOpenFile: () => void;
  onCloseMedia: () => void;
  onToggleFullscreen: () => void;
  onTogglePlayPause: () => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  onSelectVisualization: (id: string) => void;
}

/**
 * Menu state for checkboxes and enabled states.
 */
export interface MenuState {
  shuffleEnabled: boolean;
  repeatEnabled: boolean;
  hasMedia: boolean;
  isPlaying: boolean;
}

/** Stored callbacks for menu recreation */
let storedCallbacks: MenuCallbacks | null = null;

/** Current menu state */
let currentState: MenuState = {shuffleEnabled: false, repeatEnabled: false, hasMedia: false, isPlaying: false};

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
        click: callbacks.onOpenFile
      },
      {
        label: 'Open URL...',
        accelerator: 'CmdOrCtrl+U',
        enabled: false // Placeholder
      },
      {type: 'separator'},
      {
        label: 'Close',
        accelerator: 'CmdOrCtrl+W',
        click: callbacks.onCloseMedia
      },
      {type: 'separator'},
      {
        label: 'New Playlist',
        accelerator: 'CmdOrCtrl+N',
        enabled: false // Placeholder
      },
      {
        label: 'Edit Current Playlist',
        enabled: false // Placeholder
      },
      {type: 'separator'},
      {
        label: 'Save As...',
        accelerator: 'CmdOrCtrl+Shift+S',
        enabled: false // Placeholder
      },
      {
        label: 'Save Playlist',
        accelerator: 'CmdOrCtrl+S',
        enabled: false // Placeholder
      },
      {
        label: 'Save Playlist As...',
        enabled: false // Placeholder
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
        click: callbacks.onToggleFullscreen
      },
      {
        label: 'Mini Player',
        enabled: false // Placeholder
      },
      {type: 'separator'},
      {
        label: 'Visualizations',
        submenu: VISUALIZATION_CATEGORIES.map((cat): MenuItemConstructorOptions => ({
          label: cat.category,
          submenu: cat.items.map((viz): MenuItemConstructorOptions => ({
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
      }
    ]
  });

  // Help Menu
  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Help Topics',
        enabled: false // Placeholder
      },
      {
        label: 'Getting Started',
        enabled: false // Placeholder
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
