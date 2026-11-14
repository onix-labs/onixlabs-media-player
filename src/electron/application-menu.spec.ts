/**
 * @fileoverview Tests for application menu construction and state management.
 *
 * Tests cover:
 * - createApplicationMenu builds and sets the native menu
 * - Menu template structure (File, View, Playback, Help menus and their items)
 * - updateMenuState rebuilds the menu with updated checkbox/label/enabled states
 * - Menu item click handlers invoke the correct callbacks
 *
 * The approach captures the template array passed to Menu.buildFromTemplate
 * and inspects it for structure and callback wiring.
 *
 * @module electron/application-menu.spec
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: (): string => '/tmp/onixplayer-test',
    name: 'ONIXPlayer',
    quit: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn().mockReturnValue({}),
    setApplicationMenu: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { app, Menu } from 'electron';
import { createApplicationMenu, updateMenuState } from './application-menu.js';
import type { MenuCallbacks, MenuState } from './application-menu.js';
import type { RecentItem } from './settings-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a full set of mock callbacks for menu construction. */
function createMockCallbacks(): MenuCallbacks {
  return {
    onShowConfig: vi.fn(),
    onShowAbout: vi.fn(),
    onShowHelp: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenUrl: vi.fn(),
    onOpenPlaylist: vi.fn(),
    onOpenRecentFile: vi.fn(),
    onOpenRecentPlaylist: vi.fn(),
    onClearRecent: vi.fn(),
    onSavePlaylist: vi.fn(),
    onSavePlaylistAs: vi.fn(),
    onCloseMedia: vi.fn(),
    onClosePlaylist: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onTogglePlayPause: vi.fn(),
    onStop: vi.fn(),
    onToggleShuffle: vi.fn(),
    onToggleRepeat: vi.fn(),
    onSelectVisualization: vi.fn(),
    onSelectAspectMode: vi.fn(),
  };
}

/**
 * Returns the most recent template array passed to Menu.buildFromTemplate.
 * Each element is a top-level menu (File, View, Playback, Help, etc.).
 */
function getCapturedTemplate(): Record<string, unknown>[] {
  const mock = vi.mocked(Menu.buildFromTemplate);
  const lastCall: unknown[] | undefined = mock.mock.calls[mock.mock.calls.length - 1];
  return (lastCall?.[0] ?? []) as Record<string, unknown>[];
}

/** Finds a top-level menu entry by its label. */
function findMenu(template: Record<string, unknown>[], label: string): Record<string, unknown> | undefined {
  return template.find((entry: Record<string, unknown>): boolean => entry['label'] === label);
}

/** Returns the submenu array from a menu entry. */
function getSubmenu(menu: Record<string, unknown>): Record<string, unknown>[] {
  return (menu['submenu'] ?? []) as Record<string, unknown>[];
}

/** Finds an item within a submenu by its label. */
function findSubmenuItem(submenu: Record<string, unknown>[], label: string): Record<string, unknown> | undefined {
  return submenu.find((item: Record<string, unknown>): boolean => item['label'] === label);
}

/** The state a freshly loaded menu module starts with. */
const INITIAL_STATE: MenuState = {
  shuffleEnabled: false,
  repeatEnabled: false,
  hasMedia: false,
  isPlaying: false,
  isVideo: false,
  openEnabled: true,
  windowModeDefault: true,
  configOpen: false,
  developerToolsEnabled: false,
  recentFiles: [],
  recentPlaylists: [],
};

/**
 * A complete menu state with media loaded, which the tests of individual
 * items build from so that each states everything it depends on.
 */
const BASE_STATE: MenuState = {...INITIAL_STATE, hasMedia: true};

/**
 * Builds the menu from a complete state and returns the captured template.
 *
 * @param callbacks - The callbacks to wire into the menu
 * @param overrides - State that differs from BASE_STATE
 */
function buildWith(callbacks: MenuCallbacks, overrides: Partial<MenuState> = {}): Record<string, unknown>[] {
  createApplicationMenu(callbacks, {...BASE_STATE, ...overrides});
  return getCapturedTemplate();
}

/**
 * Finds an item by the labels leading to it, e.g. ['File', 'Recent Items', 'Clear Recent'].
 *
 * @param template - The captured menu template
 * @param labels - The label of each menu on the way down, ending with the item's own
 */
function findItem(template: Record<string, unknown>[], labels: readonly string[]): Record<string, unknown> | undefined {
  let level: Record<string, unknown>[] = template;
  let found: Record<string, unknown> | undefined;
  for (const label of labels) {
    found = findSubmenuItem(level, label);
    if (!found) return undefined;
    level = getSubmenu(found);
  }
  return found;
}

/** Invokes an item's click handler the way Electron would on selection. */
function click(item: Record<string, unknown> | undefined): void {
  (item?.['click'] as (() => void) | undefined)?.();
}

/** The labels of a submenu, with separators shown as '---'. */
function labelsOf(submenu: Record<string, unknown>[]): string[] {
  return submenu.map((item: Record<string, unknown>): string =>
    item['type'] === 'separator' ? '---' : String(item['label'] ?? item['role'])
  );
}

/** Names of the callbacks that have been invoked at least once. */
function invoked(callbacks: MenuCallbacks): string[] {
  return (Object.keys(callbacks) as (keyof MenuCallbacks)[]).filter(
    (name: keyof MenuCallbacks): boolean => vi.mocked(callbacks[name]).mock.calls.length > 0
  );
}

const ORIGINAL_PLATFORM_DESCRIPTOR: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(process, 'platform');

/** Makes process.platform report the given platform until restorePlatform(). */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: platform });
}

/** Puts the real process.platform back. */
function restorePlatform(): void {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('application-menu', (): void => {
  beforeEach((): void => {
    // The module keeps its menu state between tests. Put it back to what a
    // freshly loaded module starts with, so that no test inherits state from
    // whichever test happened to run before it.
    createApplicationMenu(createMockCallbacks(), INITIAL_STATE);
    vi.clearAllMocks();
  });

  // ========================================================================
  // 1. createApplicationMenu
  // ========================================================================

  describe('createApplicationMenu', (): void => {
    it('creates menu without errors', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      expect((): void => createApplicationMenu(callbacks)).not.toThrow();
    });

    it('calls Menu.buildFromTemplate with template array', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks);

      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
      const template: unknown = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0];
      expect(Array.isArray(template)).toBe(true);
    });

    it('calls Menu.setApplicationMenu', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks);

      expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    });

    it('captures template structure for inspection', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks);

      const template: Record<string, unknown>[] = getCapturedTemplate();
      expect(template.length).toBeGreaterThan(0);

      // Every top-level entry should have a label
      for (const entry of template) {
        expect(entry['label']).toBeDefined();
      }
    });
  });

  // ========================================================================
  // 2. Menu structure
  // ========================================================================

  describe('menu structure', (): void => {
    let template: Record<string, unknown>[];

    beforeEach((): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks);
      template = getCapturedTemplate();
    });

    it('includes File menu', (): void => {
      const fileMenu: Record<string, unknown> | undefined = findMenu(template, 'File');
      expect(fileMenu).toBeDefined();
    });

    it('includes View menu', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
    });

    it('includes Playback menu', (): void => {
      const playbackMenu: Record<string, unknown> | undefined = findMenu(template, 'Playback');
      expect(playbackMenu).toBeDefined();
    });

    it('includes Help menu', (): void => {
      const helpMenu: Record<string, unknown> | undefined = findMenu(template, 'Help');
      expect(helpMenu).toBeDefined();
    });

    it('File menu includes Open item', (): void => {
      const fileMenu: Record<string, unknown> | undefined = findMenu(template, 'File');
      expect(fileMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(fileMenu!);
      const openItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Open');
      expect(openItem).toBeDefined();
      expect(openItem!['accelerator']).toBe('CmdOrCtrl+O');
    });

    it('View menu omits Developer Tools unless enabled', (): void => {
      createApplicationMenu(createMockCallbacks(), {developerToolsEnabled: false});
      const viewMenu: Record<string, unknown> | undefined = findMenu(getCapturedTemplate(), 'View');
      const devToolsItem: Record<string, unknown> | undefined = findSubmenuItem(getSubmenu(viewMenu!), 'Developer Tools');
      expect(devToolsItem).toBeUndefined();
    });

    it('View menu includes Developer Tools when enabled', (): void => {
      createApplicationMenu(createMockCallbacks(), {developerToolsEnabled: true});
      const viewMenu: Record<string, unknown> | undefined = findMenu(getCapturedTemplate(), 'View');
      const devToolsItem: Record<string, unknown> | undefined = findSubmenuItem(getSubmenu(viewMenu!), 'Developer Tools');
      expect(devToolsItem).toBeDefined();
      expect(devToolsItem!['role']).toBe('toggleDevTools');

      // Module-level state persists between tests; restore the default
      createApplicationMenu(createMockCallbacks(), {developerToolsEnabled: false});
    });

    it('View menu includes Visualizations submenu', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Visualizations');
      expect(vizItem).toBeDefined();
      expect(vizItem!['submenu']).toBeDefined();
    });

    it('Visualizations submenu contains the Bars & Waves category', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Visualizations');
      expect(vizItem).toBeDefined();

      const vizSubmenu: Record<string, unknown>[] = getSubmenu(vizItem!);
      // Doubled: the builder escapes the ampersand so Windows renders it
      // literally rather than treating it as a mnemonic marker.
      const wavesCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Bars && Waves');

      expect(wavesCategory).toBeDefined();
    });

    it('Bars & Waves category contains Analyzer', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Visualizations');
      expect(vizItem).toBeDefined();

      const vizSubmenu: Record<string, unknown>[] = getSubmenu(vizItem!);
      const barsCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Bars && Waves');
      expect(barsCategory).toBeDefined();

      const barsItems: Record<string, unknown>[] = getSubmenu(barsCategory!);
      const analyzerItem: Record<string, unknown> | undefined = findSubmenuItem(barsItems, 'Analyzer');

      expect(analyzerItem).toBeDefined();
    });

    it('Bars & Waves category contains every entry', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Visualizations');
      expect(vizItem).toBeDefined();

      const vizSubmenu: Record<string, unknown>[] = getSubmenu(vizItem!);
      const wavesCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Bars && Waves');
      expect(wavesCategory).toBeDefined();

      const wavesItems: Record<string, unknown>[] = getSubmenu(wavesCategory!);
      const expectedNames: readonly string[] = ['Analyzer', 'Classic', 'Modern', 'Plasma', 'Infinity', 'Neon', 'Hawking', 'Onix'];

      for (const name of expectedNames) {
        const item: Record<string, unknown> | undefined = findSubmenuItem(wavesItems, name);
        expect(item).toBeDefined();
      }

      expect(wavesItems.length).toBe(expectedNames.length);
    });

    it('Signature category contains the signature visualizations', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Visualizations');
      expect(vizItem).toBeDefined();

      const vizSubmenu: Record<string, unknown>[] = getSubmenu(vizItem!);
      const signatureCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Signature');
      expect(signatureCategory).toBeDefined();

      const signatureItems: Record<string, unknown>[] = getSubmenu(signatureCategory!);
      const expectedNames: readonly string[] = ['Reactor', 'Spotlight'];

      for (const name of expectedNames) {
        const item: Record<string, unknown> | undefined = findSubmenuItem(signatureItems, name);
        expect(item).toBeDefined();
      }

      expect(signatureItems.length).toBe(expectedNames.length);
    });

    it('Nostalgia category contains the entries moved out of Signature and Ambience', (): void => {
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Visualizations');
      expect(vizItem).toBeDefined();

      const vizSubmenu: Record<string, unknown>[] = getSubmenu(vizItem!);
      const nostalgiaCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Nostalgia');
      expect(nostalgiaCategory).toBeDefined();

      const nostalgiaItems: Record<string, unknown>[] = getSubmenu(nostalgiaCategory!);
      const expectedNames: readonly string[] = ['Twirl', 'Warp', 'Ripple', 'Pulsar', 'Hallucia'];

      for (const name of expectedNames) {
        const item: Record<string, unknown> | undefined = findSubmenuItem(nostalgiaItems, name);
        expect(item).toBeDefined();
      }

      expect(nostalgiaItems.length).toBe(expectedNames.length);
    });

    it('Playback menu shows Play when not playing', (): void => {
      // Default state has isPlaying: false
      const playbackMenu: Record<string, unknown> | undefined = findMenu(template, 'Playback');
      expect(playbackMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(playbackMenu!);
      const playItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Play');
      expect(playItem).toBeDefined();
    });

    it('Playback menu shows Pause when playing', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { isPlaying: true });
      const playingTemplate: Record<string, unknown>[] = getCapturedTemplate();

      const playbackMenu: Record<string, unknown> | undefined = findMenu(playingTemplate, 'Playback');
      expect(playbackMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(playbackMenu!);
      const pauseItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Pause');
      expect(pauseItem).toBeDefined();
    });

    it('Help menu includes About ONIXPlayer', (): void => {
      const helpMenu: Record<string, unknown> | undefined = findMenu(template, 'Help');
      expect(helpMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(helpMenu!);
      const aboutItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'About ONIXPlayer');
      expect(aboutItem).toBeDefined();
    });
  });

  // ========================================================================
  // 3. updateMenuState
  // ========================================================================

  describe('updateMenuState', (): void => {
    it('updates shuffle checkbox state', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { shuffleEnabled: false, hasMedia: true });
      vi.mocked(Menu.buildFromTemplate).mockClear();

      updateMenuState({ shuffleEnabled: true });

      const template: Record<string, unknown>[] = getCapturedTemplate();
      const playbackMenu: Record<string, unknown> | undefined = findMenu(template, 'Playback');
      expect(playbackMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(playbackMenu!);
      const shuffleItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Shuffle');
      expect(shuffleItem).toBeDefined();
      expect(shuffleItem!['checked']).toBe(true);
    });

    it('updates repeat checkbox state', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { repeatEnabled: false, hasMedia: true });
      vi.mocked(Menu.buildFromTemplate).mockClear();

      updateMenuState({ repeatEnabled: true });

      const template: Record<string, unknown>[] = getCapturedTemplate();
      const playbackMenu: Record<string, unknown> | undefined = findMenu(template, 'Playback');
      expect(playbackMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(playbackMenu!);
      const repeatItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Repeat');
      expect(repeatItem).toBeDefined();
      expect(repeatItem!['checked']).toBe(true);
    });

    it('updates play/pause label based on isPlaying', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { isPlaying: false, hasMedia: true });
      vi.mocked(Menu.buildFromTemplate).mockClear();

      // Transition to playing
      updateMenuState({ isPlaying: true });

      let template: Record<string, unknown>[] = getCapturedTemplate();
      let playbackMenu: Record<string, unknown> | undefined = findMenu(template, 'Playback');
      let submenu: Record<string, unknown>[] = getSubmenu(playbackMenu!);
      expect(findSubmenuItem(submenu, 'Pause')).toBeDefined();
      expect(findSubmenuItem(submenu, 'Play')).toBeUndefined();

      // Transition back to paused
      updateMenuState({ isPlaying: false });

      template = getCapturedTemplate();
      playbackMenu = findMenu(template, 'Playback');
      submenu = getSubmenu(playbackMenu!);
      expect(findSubmenuItem(submenu, 'Play')).toBeDefined();
      expect(findSubmenuItem(submenu, 'Pause')).toBeUndefined();
    });

    it('enables/disables Close items based on hasMedia', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { hasMedia: true });
      vi.mocked(Menu.buildFromTemplate).mockClear();

      // Without media, Close and Close Playlist should be disabled
      updateMenuState({ hasMedia: false });

      let template: Record<string, unknown>[] = getCapturedTemplate();
      let fileMenu: Record<string, unknown> | undefined = findMenu(template, 'File');
      let submenu: Record<string, unknown>[] = getSubmenu(fileMenu!);
      let closeItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Close');
      let closePlaylistItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Close Playlist');
      expect(closeItem!['enabled']).toBe(false);
      expect(closePlaylistItem!['enabled']).toBe(false);

      // With media, Close and Close Playlist should be enabled
      updateMenuState({ hasMedia: true });

      template = getCapturedTemplate();
      fileMenu = findMenu(template, 'File');
      submenu = getSubmenu(fileMenu!);
      closeItem = findSubmenuItem(submenu, 'Close');
      closePlaylistItem = findSubmenuItem(submenu, 'Close Playlist');
      expect(closeItem!['enabled']).toBe(true);
      expect(closePlaylistItem!['enabled']).toBe(true);
    });

    it('does not build a menu before createApplicationMenu has supplied the callbacks', async (): Promise<void> => {
      // A fresh copy of the module (and of the electron mock it imports), so
      // that no earlier test has already stored callbacks in it.
      vi.resetModules();
      const electron: typeof import('electron') = await import('electron');
      const fresh: typeof import('./application-menu.js') = await import('./application-menu.js');

      fresh.updateMenuState({ shuffleEnabled: true });

      expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled();
      expect(electron.Menu.setApplicationMenu).not.toHaveBeenCalled();
    });

    it('applies state reported before the menu existed once it is created', async (): Promise<void> => {
      vi.resetModules();
      const electron: typeof import('electron') = await import('electron');
      const fresh: typeof import('./application-menu.js') = await import('./application-menu.js');
      fresh.updateMenuState({ shuffleEnabled: true });

      fresh.createApplicationMenu(createMockCallbacks());

      const calls: unknown[][] = vi.mocked(electron.Menu.buildFromTemplate).mock.calls;
      const template: Record<string, unknown>[] = calls[calls.length - 1][0] as Record<string, unknown>[];
      expect(findItem(template, ['Playback', 'Shuffle'])?.['checked']).toBe(true);
    });

    it('rebuilds menu on each state update', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { shuffleEnabled: false, repeatEnabled: false, isPlaying: false });

      const initialCallCount: number = vi.mocked(Menu.buildFromTemplate).mock.calls.length;

      updateMenuState({ shuffleEnabled: true });
      expect(vi.mocked(Menu.buildFromTemplate).mock.calls.length).toBe(initialCallCount + 1);

      updateMenuState({ repeatEnabled: true });
      expect(vi.mocked(Menu.buildFromTemplate).mock.calls.length).toBe(initialCallCount + 2);

      updateMenuState({ isPlaying: true });
      expect(vi.mocked(Menu.buildFromTemplate).mock.calls.length).toBe(initialCallCount + 3);
    });

    it('does not rebuild menu when the state has not changed', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks, { isPlaying: true, isVideo: false });

      const initialCallCount: number = vi.mocked(Menu.buildFromTemplate).mock.calls.length;

      updateMenuState({ isPlaying: true, isVideo: false });
      expect(vi.mocked(Menu.buildFromTemplate).mock.calls.length).toBe(initialCallCount);
    });
  });

  // ========================================================================
  // 4. Menu callbacks
  // ========================================================================

  describe('menu callbacks', (): void => {
    it('Open item click calls onOpenFile callback', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks);

      const template: Record<string, unknown>[] = getCapturedTemplate();
      const fileMenu: Record<string, unknown> | undefined = findMenu(template, 'File');
      expect(fileMenu).toBeDefined();
      const submenu: Record<string, unknown>[] = getSubmenu(fileMenu!);
      const openItem: Record<string, unknown> | undefined = findSubmenuItem(submenu, 'Open');
      expect(openItem).toBeDefined();

      // Invoke the click handler
      const clickHandler = openItem!['click'] as (() => void);
      expect(clickHandler).toBeDefined();
      clickHandler();
      expect(callbacks.onOpenFile).toHaveBeenCalledTimes(1);
    });

    it('visualization item click calls onSelectVisualization with correct id', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      createApplicationMenu(callbacks);

      const template: Record<string, unknown>[] = getCapturedTemplate();
      const viewMenu: Record<string, unknown> | undefined = findMenu(template, 'View');
      expect(viewMenu).toBeDefined();
      const viewSubmenu: Record<string, unknown>[] = getSubmenu(viewMenu!);
      const vizItem: Record<string, unknown> | undefined = findSubmenuItem(viewSubmenu, 'Visualizations');
      expect(vizItem).toBeDefined();

      const vizSubmenu: Record<string, unknown>[] = getSubmenu(vizItem!);

      // Test a Bars & Waves category item: Analyzer -> id 'bars'
      const barsCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Bars && Waves');
      expect(barsCategory).toBeDefined();
      const barsItems: Record<string, unknown>[] = getSubmenu(barsCategory!);
      const analyzerItem: Record<string, unknown> | undefined = findSubmenuItem(barsItems, 'Analyzer');
      expect(analyzerItem).toBeDefined();

      const analyzerClick = analyzerItem!['click'] as (() => void);
      analyzerClick();
      expect(callbacks.onSelectVisualization).toHaveBeenCalledWith('bars');

      // Test a Waves category item: Neon -> id 'neon'
      const wavesCategory: Record<string, unknown> | undefined = findSubmenuItem(vizSubmenu, 'Bars && Waves');
      expect(wavesCategory).toBeDefined();
      const wavesItems: Record<string, unknown>[] = getSubmenu(wavesCategory!);
      const neonItem: Record<string, unknown> | undefined = findSubmenuItem(wavesItems, 'Neon');
      expect(neonItem).toBeDefined();

      const neonClick = neonItem!['click'] as (() => void);
      neonClick();
      expect(callbacks.onSelectVisualization).toHaveBeenCalledWith('neon');
    });
  });

  // ========================================================================
  // 5. Callback wiring
  // ========================================================================

  describe('callback wiring', (): void => {
    it.each<{path: string[]; callback: keyof MenuCallbacks}>([
      {path: ['File', 'Open'], callback: 'onOpenFile'},
      {path: ['File', 'Open URL...'], callback: 'onOpenUrl'},
      {path: ['File', 'Open Playlist'], callback: 'onOpenPlaylist'},
      {path: ['File', 'Save Playlist As...'], callback: 'onSavePlaylistAs'},
      {path: ['File', 'Save Playlist'], callback: 'onSavePlaylist'},
      {path: ['File', 'Close'], callback: 'onCloseMedia'},
      {path: ['File', 'Close Playlist'], callback: 'onClosePlaylist'},
      {path: ['View', 'Full Screen'], callback: 'onToggleFullscreen'},
      {path: ['View', 'Options'], callback: 'onShowConfig'},
      {path: ['Playback', 'Play'], callback: 'onTogglePlayPause'},
      {path: ['Playback', 'Stop'], callback: 'onStop'},
      {path: ['Playback', 'Shuffle'], callback: 'onToggleShuffle'},
      {path: ['Playback', 'Repeat'], callback: 'onToggleRepeat'},
      {path: ['Help', 'Help Topics'], callback: 'onShowHelp'},
      {path: ['Help', 'About ONIXPlayer'], callback: 'onShowAbout'},
    ])('$path invokes $callback and nothing else', ({path, callback}: {path: string[]; callback: keyof MenuCallbacks}): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const template: Record<string, unknown>[] = buildWith(callbacks);

      click(findItem(template, path));

      expect(invoked(callbacks)).toEqual([callback]);
    });

    it('Pause invokes the same play/pause toggle as Play', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const template: Record<string, unknown>[] = buildWith(callbacks, {isPlaying: true});

      click(findItem(template, ['Playback', 'Pause']));

      expect(invoked(callbacks)).toEqual(['onTogglePlayPause']);
    });

    it.each([
      {label: 'Default', mode: 'default'},
      {label: 'Forced (4:3)', mode: '4:3'},
      {label: 'Forced (16:9)', mode: '16:9'},
      {label: 'Fit to Screen', mode: 'fit'},
    ])('Aspect Ratio > $label selects the $mode aspect mode', ({label, mode}: {label: string; mode: string}): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const template: Record<string, unknown>[] = buildWith(callbacks, {isVideo: true});

      click(findItem(template, ['Playback', 'Aspect Ratio', label]));

      expect(callbacks.onSelectAspectMode).toHaveBeenCalledTimes(1);
      expect(callbacks.onSelectAspectMode).toHaveBeenCalledWith(mode);
    });

    it.each([
      {path: ['Signature', 'Reactor'], id: 'water'},
      {path: ['Nostalgia', 'Twirl'], id: 'ambience-zoom'},
      {path: ['Simple', 'Album Art'], id: 'album-art'},
    ])('Visualizations > $path selects the $id visualization', ({path, id}: {path: string[]; id: string}): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const template: Record<string, unknown>[] = buildWith(callbacks);

      click(findItem(template, ['View', 'Visualizations', ...path]));

      expect(callbacks.onSelectVisualization).toHaveBeenCalledTimes(1);
      expect(callbacks.onSelectVisualization).toHaveBeenCalledWith(id);
    });
  });

  // ========================================================================
  // 6. Enabled state
  // ========================================================================

  describe('enabled state', (): void => {
    const OPEN_ITEMS: readonly string[] = ['Open', 'Open URL...', 'Open Playlist'];
    const MEDIA_ITEMS: readonly (readonly string[])[] = [
      ['File', 'Save Playlist As...'],
      ['File', 'Save Playlist'],
      ['File', 'Close'],
      ['File', 'Close Playlist'],
      ['Playback', 'Play'],
      ['Playback', 'Stop'],
      ['Playback', 'Shuffle'],
      ['Playback', 'Repeat'],
    ];

    /** The enabled flag of each item, in the order given. */
    function enabledFlags(template: Record<string, unknown>[], paths: readonly (readonly string[])[]): unknown[] {
      return paths.map((path: readonly string[]): unknown => findItem(template, path)?.['enabled']);
    }

    it.each([true, false])('the Open items follow openEnabled = %s', (openEnabled: boolean): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks(), {openEnabled});

      const flags: unknown[] = enabledFlags(template, OPEN_ITEMS.map((label: string): string[] => ['File', label]));

      expect(flags).toEqual([openEnabled, openEnabled, openEnabled]);
    });

    it.each([true, false])('the save, close and playback items follow hasMedia = %s', (hasMedia: boolean): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks(), {hasMedia});

      const flags: unknown[] = enabledFlags(template, MEDIA_ITEMS);

      expect(flags).toEqual(MEDIA_ITEMS.map((): boolean => hasMedia));
    });

    it.each([
      {hasMedia: true, configOpen: false, expected: true},
      {hasMedia: false, configOpen: false, expected: false},
      {hasMedia: true, configOpen: true, expected: false},
      {hasMedia: false, configOpen: true, expected: false},
    ])('Full Screen is enabled = $expected with hasMedia = $hasMedia and configOpen = $configOpen', (
      {hasMedia, configOpen, expected}: {hasMedia: boolean; configOpen: boolean; expected: boolean}
    ): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks(), {hasMedia, configOpen});

      expect(findItem(template, ['View', 'Full Screen'])?.['enabled']).toBe(expected);
    });

    it.each([true, false])('Aspect Ratio follows isVideo = %s', (isVideo: boolean): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks(), {isVideo});

      expect(findItem(template, ['Playback', 'Aspect Ratio'])?.['enabled']).toBe(isVideo);
    });

    it('Shuffle and Repeat are checkboxes reflecting their modes independently', (): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks(), {shuffleEnabled: false, repeatEnabled: true});

      const shuffle: Record<string, unknown> | undefined = findItem(template, ['Playback', 'Shuffle']);
      const repeat: Record<string, unknown> | undefined = findItem(template, ['Playback', 'Repeat']);

      expect([shuffle?.['type'], shuffle?.['checked']]).toEqual(['checkbox', false]);
      expect([repeat?.['type'], repeat?.['checked']]).toEqual(['checkbox', true]);
    });

    it('Mini Player is not selectable', (): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

      expect(findItem(template, ['View', 'Mini Player'])?.['enabled']).toBe(false);
    });
  });

  // ========================================================================
  // 7. Recent items
  // ========================================================================

  describe('recent items', (): void => {
    const FILES: readonly RecentItem[] = [
      {path: '/music/first.mp3', displayName: 'first.mp3', timestamp: '2026-11-02T10:00:00.000Z', type: 'file'},
      {path: '/music/second.flac', displayName: 'second.flac', timestamp: '2026-11-01T10:00:00.000Z', type: 'file'},
    ];
    const PLAYLISTS: readonly RecentItem[] = [
      {path: '/lists/road trip.opp', displayName: 'road trip.opp', timestamp: '2026-11-03T10:00:00.000Z', type: 'playlist'},
    ];

    /** The Recent Items submenu built from the given recent lists. */
    function recentSubmenu(callbacks: MenuCallbacks, recentFiles: readonly RecentItem[], recentPlaylists: readonly RecentItem[]): Record<string, unknown>[] {
      const recent: Record<string, unknown> | undefined = findItem(buildWith(callbacks, {recentFiles, recentPlaylists}), ['File', 'Recent Items']);
      return getSubmenu(recent ?? {});
    }

    it('shows disabled placeholders and a disabled Clear Recent when there is nothing recent', (): void => {
      const submenu: Record<string, unknown>[] = recentSubmenu(createMockCallbacks(), [], []);

      expect(labelsOf(submenu)).toEqual(['No Recent Files', '---', 'No Recent Playlists', '---', 'Clear Recent']);
      expect(submenu.filter((item: Record<string, unknown>): boolean => item['type'] !== 'separator')
        .map((item: Record<string, unknown>): unknown => item['enabled'])).toEqual([false, false, false]);
    });

    it('lists files, then playlists, in the order given, by display name', (): void => {
      const submenu: Record<string, unknown>[] = recentSubmenu(createMockCallbacks(), FILES, PLAYLISTS);

      expect(labelsOf(submenu)).toEqual(['first.mp3', 'second.flac', '---', 'road trip.opp', '---', 'Clear Recent']);
    });

    it('keeps the placeholder for the list that is empty', (): void => {
      const submenu: Record<string, unknown>[] = recentSubmenu(createMockCallbacks(), [], PLAYLISTS);

      expect(labelsOf(submenu)).toEqual(['No Recent Files', '---', 'road trip.opp', '---', 'Clear Recent']);
    });

    it('opens the full path of the recent file that was clicked', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const submenu: Record<string, unknown>[] = recentSubmenu(callbacks, FILES, PLAYLISTS);

      click(findSubmenuItem(submenu, 'second.flac'));

      expect(callbacks.onOpenRecentFile).toHaveBeenCalledTimes(1);
      expect(callbacks.onOpenRecentFile).toHaveBeenCalledWith('/music/second.flac');
      expect(callbacks.onOpenRecentPlaylist).not.toHaveBeenCalled();
    });

    it('opens the full path of the recent playlist that was clicked', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const submenu: Record<string, unknown>[] = recentSubmenu(callbacks, FILES, PLAYLISTS);

      click(findSubmenuItem(submenu, 'road trip.opp'));

      expect(callbacks.onOpenRecentPlaylist).toHaveBeenCalledTimes(1);
      expect(callbacks.onOpenRecentPlaylist).toHaveBeenCalledWith('/lists/road trip.opp');
      expect(callbacks.onOpenRecentFile).not.toHaveBeenCalled();
    });

    it.each([
      {name: 'only files', files: FILES, playlists: []},
      {name: 'only playlists', files: [], playlists: PLAYLISTS},
    ])('enables Clear Recent with $name', ({files, playlists}: {files: readonly RecentItem[]; playlists: readonly RecentItem[]}): void => {
      const submenu: Record<string, unknown>[] = recentSubmenu(createMockCallbacks(), files, playlists);

      expect(findSubmenuItem(submenu, 'Clear Recent')?.['enabled']).toBe(true);
    });

    it('Clear Recent invokes onClearRecent', (): void => {
      const callbacks: MenuCallbacks = createMockCallbacks();
      const submenu: Record<string, unknown>[] = recentSubmenu(callbacks, FILES, PLAYLISTS);

      click(findSubmenuItem(submenu, 'Clear Recent'));

      expect(invoked(callbacks)).toEqual(['onClearRecent']);
    });

    it('rebuilds with the new list when the recent files change', (): void => {
      buildWith(createMockCallbacks(), {recentFiles: FILES});

      updateMenuState({recentFiles: [FILES[1]]});

      const recent: Record<string, unknown> | undefined = findItem(getCapturedTemplate(), ['File', 'Recent Items']);
      expect(labelsOf(getSubmenu(recent ?? {})).slice(0, 2)).toEqual(['second.flac', '---']);
    });
  });

  // ========================================================================
  // 8. Platform differences
  // ========================================================================

  describe('platform differences', (): void => {
    afterEach((): void => {
      restorePlatform();
    });

    describe('on macOS', (): void => {
      beforeEach((): void => {
        stubPlatform('darwin');
      });

      it('leads with the application menu', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(labelsOf(template)).toEqual(['ONIXPlayer', 'File', 'Edit', 'View', 'Playback', 'Help']);
      });

      it('offers Settings on Cmd+, in the application menu, opening the configuration', (): void => {
        const callbacks: MenuCallbacks = createMockCallbacks();
        const settings: Record<string, unknown> | undefined = findItem(buildWith(callbacks), ['ONIXPlayer', 'Settings']);

        click(settings);

        expect(settings?.['accelerator']).toBe('Cmd+,');
        expect(invoked(callbacks)).toEqual(['onShowConfig']);
      });

      it.each([true, false])('enables Settings only in the default window mode (windowModeDefault = %s)', (windowModeDefault: boolean): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks(), {windowModeDefault});

        expect(findItem(template, ['ONIXPlayer', 'Settings'])?.['enabled']).toBe(windowModeDefault);
      });

      it('leaves quitting to the application menu rather than File > Exit', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(findItem(template, ['File', 'Exit'])).toBeUndefined();
        expect(labelsOf(getSubmenu(findMenu(template, 'ONIXPlayer') ?? {}))).toContain('quit');
      });

      it('uses the macOS full screen shortcut', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(findItem(template, ['View', 'Full Screen'])?.['accelerator']).toBe('Ctrl+Cmd+F');
      });

      it('gives View > Options no shortcut, since Settings already owns Cmd+,', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(findItem(template, ['View', 'Options'])?.['accelerator']).toBeUndefined();
      });
    });

    describe.each<NodeJS.Platform>(['win32', 'linux'])('on %s', (platform: NodeJS.Platform): void => {
      beforeEach((): void => {
        stubPlatform(platform);
      });

      it('has no application menu', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(labelsOf(template)).toEqual(['File', 'Edit', 'View', 'Playback', 'Help']);
      });

      it('ends the File menu with Exit on Alt+F4', (): void => {
        const fileItems: Record<string, unknown>[] = getSubmenu(findMenu(buildWith(createMockCallbacks()), 'File') ?? {});

        expect(labelsOf(fileItems).slice(-2)).toEqual(['---', 'Exit']);
        expect(fileItems[fileItems.length - 1]['accelerator']).toBe('Alt+F4');
      });

      it('quits the application from File > Exit', (): void => {
        const callbacks: MenuCallbacks = createMockCallbacks();
        const template: Record<string, unknown>[] = buildWith(callbacks);

        click(findItem(template, ['File', 'Exit']));

        expect(app.quit).toHaveBeenCalledTimes(1);
        expect(invoked(callbacks)).toEqual([]);
      });

      it('uses F11 for full screen', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(findItem(template, ['View', 'Full Screen'])?.['accelerator']).toBe('F11');
      });

      it('puts the options shortcut on View > Options', (): void => {
        const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

        expect(findItem(template, ['View', 'Options'])?.['accelerator']).toBe('Ctrl+,');
      });
    });
  });

  // ========================================================================
  // 9. Edit menu
  // ========================================================================

  describe('Edit menu', (): void => {
    it('provides the standard clipboard roles so their shortcuts reach text fields', (): void => {
      const template: Record<string, unknown>[] = buildWith(createMockCallbacks());

      const roles: unknown[] = getSubmenu(findMenu(template, 'Edit') ?? {})
        .map((item: Record<string, unknown>): unknown => item['role'])
        .filter((role: unknown): boolean => role !== undefined);

      expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    });
  });
});
