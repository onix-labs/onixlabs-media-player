/**
 * @fileoverview Application menu configuration for ONIXPlayer.
 *
 * Defines the native menu bar structure for macOS and other platforms.
 * Some menu items are placeholders for future functionality.
 *
 * @module electron/application-menu
 */

import {app, Menu, BrowserWindow, shell} from 'electron';
import type {MenuItemConstructorOptions} from 'electron';

/**
 * Available visualization types for the Visualizations submenu.
 * IDs must match VisualizationType in the Angular app.
 */
const VISUALIZATIONS: ReadonlyArray<{id: string; name: string}> = [
  {id: 'bars', name: 'Frequency Bars'},
  {id: 'waveform', name: 'Waveform'},
  {id: 'tunnel', name: 'Tunnel'},
  {id: 'neon', name: 'Neon'},
  {id: 'pulsar', name: 'Pulsar'},
  {id: 'water', name: 'Water'}
];

/**
 * Creates and sets the application menu.
 *
 * @param callbacks - Callback functions for menu actions
 */
export function createApplicationMenu(callbacks: {
  onShowConfig: () => void;
  onOpenFile: () => void;
  onCloseMedia: () => void;
  onToggleFullscreen: () => void;
  onTogglePlayPause: () => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  onSelectVisualization: (id: string) => void;
}): void {
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
        submenu: VISUALIZATIONS.map((viz: {id: string; name: string}): MenuItemConstructorOptions => ({
          label: viz.name,
          click: (): void => callbacks.onSelectVisualization(viz.id)
        }))
      }
    ]
  });

  // Playback Menu
  template.push({
    label: 'Playback',
    submenu: [
      {
        label: 'Play / Pause',
        accelerator: 'Space',
        click: callbacks.onTogglePlayPause
      },
      {
        label: 'Stop',
        enabled: false // Placeholder
      },
      {type: 'separator'},
      {
        label: 'Play Speed',
        enabled: false, // Placeholder
        submenu: [
          {label: '0.5x', enabled: false},
          {label: '1.0x', enabled: false},
          {label: '1.5x', enabled: false},
          {label: '2.0x', enabled: false}
        ]
      },
      {type: 'separator'},
      {
        label: 'Shuffle',
        type: 'checkbox',
        checked: false,
        click: callbacks.onToggleShuffle
      },
      {
        label: 'Repeat',
        type: 'checkbox',
        checked: false,
        click: callbacks.onToggleRepeat
      },
      {type: 'separator'},
      {
        label: 'Options',
        accelerator: isMac ? undefined : 'Ctrl+,',
        click: callbacks.onShowConfig
      }
    ]
  });

  // Window Menu
  template.push({
    label: 'Window',
    submenu: [
      {role: 'minimize'},
      {role: 'zoom'},
      ...(isMac ? [
        {type: 'separator'} as MenuItemConstructorOptions,
        {role: 'front'} as MenuItemConstructorOptions,
        {type: 'separator'} as MenuItemConstructorOptions,
        {role: 'window'} as MenuItemConstructorOptions
      ] : [
        {role: 'close'} as MenuItemConstructorOptions
      ])
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
        click: (): void => {
          const window: BrowserWindow | null = BrowserWindow.getFocusedWindow();
          if (window) {
            // TODO: Show proper about dialog
            shell.openExternal('https://github.com/onix-labs/onixlabs-media-player');
          }
        }
      }
    ]
  });

  const menu: Menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
