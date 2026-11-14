/**
 * @fileoverview Tests for MenuEvents.
 *
 * A menu selection arrives as an untyped IPC event. These pin which
 * selections become signals, which are handed to the supplied actions, and
 * that an argument of the wrong type never reaches either.
 *
 * @module app/services/menu-events.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {MenuEvents} from './menu-events.service';
import type {MenuActions} from './menu-events.service';

// ============================================================================
// Helpers
// ============================================================================

type Stub = ReturnType<typeof vi.fn>;
type Listener = (...args: unknown[]) => void;

/** Every menu event the service is expected to subscribe to. */
const MENU_EVENT_NAMES: readonly string[] = [
  'showConfig', 'openFile', 'togglePlayPause', 'stop', 'toggleShuffle', 'toggleRepeat',
  'selectVisualization', 'selectAspectMode', 'closeMedia', 'closeAll', 'showHelp',
  'openPlaylist', 'savePlaylist', 'savePlaylistAs', 'openRecentFile', 'openRecentPlaylist',
];

/** A fake preload bridge that records menu listeners and their removers. */
interface MenuBridge {
  readonly onMenuEvent: Stub;
  readonly listeners: Map<string, Listener>;
  readonly cleanups: Map<string, Stub>;
}

function createMenuBridge(): MenuBridge {
  const listeners: Map<string, Listener> = new Map<string, Listener>();
  const cleanups: Map<string, Stub> = new Map<string, Stub>();
  const onMenuEvent: Stub = vi.fn().mockImplementation((name: string, callback: Listener): Stub => {
    const cleanup: Stub = vi.fn();
    listeners.set(name, callback);
    cleanups.set(name, cleanup);
    return cleanup;
  });
  return {onMenuEvent, listeners, cleanups};
}

/** Menu actions that record how they were called. */
interface RecordedActions {
  readonly togglePlayPause: ReturnType<typeof vi.fn<() => void>>;
  readonly stop: ReturnType<typeof vi.fn<() => void>>;
  readonly toggleShuffle: ReturnType<typeof vi.fn<() => void>>;
  readonly toggleRepeat: ReturnType<typeof vi.fn<() => void>>;
  readonly closeMedia: ReturnType<typeof vi.fn<() => void>>;
  readonly closeAll: ReturnType<typeof vi.fn<() => void>>;
  readonly openRecentFile: ReturnType<typeof vi.fn<(filePath: string) => void>>;
  readonly openRecentPlaylist: ReturnType<typeof vi.fn<(playlistPath: string) => void>>;
}

function createActions(): RecordedActions {
  return {
    togglePlayPause: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    toggleShuffle: vi.fn<() => void>(),
    toggleRepeat: vi.fn<() => void>(),
    closeMedia: vi.fn<() => void>(),
    closeAll: vi.fn<() => void>(),
    openRecentFile: vi.fn<(filePath: string) => void>(),
    openRecentPlaylist: vi.fn<(playlistPath: string) => void>(),
  };
}

/** Installs (or, given undefined, removes) the preload bridge on the window. */
function setBridge(bridge: MenuBridge | undefined): void {
  Object.defineProperty(window, 'mediaPlayer', {
    value: bridge ? {onMenuEvent: bridge.onMenuEvent} : undefined,
    configurable: true,
    writable: true,
  });
}

/** Chooses a menu item, as the main process would report it. */
function choose(bridge: MenuBridge, name: string, ...args: unknown[]): void {
  const listener: Listener | undefined = bridge.listeners.get(name);
  if (!listener) throw new Error(`No listener registered for menu event ${name}`);
  listener(...args);
}

// ============================================================================
// Tests
// ============================================================================

describe('MenuEvents', (): void => {
  let menu: MenuEvents;
  let bridge: MenuBridge;
  let actions: RecordedActions;

  beforeEach((): void => {
    bridge = createMenuBridge();
    actions = createActions();
    setBridge(bridge);
    TestBed.configureTestingModule({});
    menu = TestBed.inject(MenuEvents);
  });

  afterEach((): void => {
    menu.stopListening();
    setBridge(undefined);
  });

  describe('outside Electron', (): void => {
    it('registers nothing when there is no preload bridge', (): void => {
      setBridge(undefined);

      menu.listen(actions);

      expect(bridge.onMenuEvent).not.toHaveBeenCalled();
    });
  });

  describe('listen', (): void => {
    it('subscribes to every menu event exactly once', (): void => {
      menu.listen(actions);

      expect(bridge.onMenuEvent.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual(MENU_EVENT_NAMES);
    });
  });

  describe('selections a component must act on', (): void => {
    beforeEach((): void => {
      menu.listen(actions);
    });

    it.each([
      ['showConfig', 'menuShowConfig'],
      ['openFile', 'menuOpenFile'],
      ['showHelp', 'menuShowHelp'],
      ['openPlaylist', 'menuOpenPlaylist'],
      ['savePlaylist', 'menuSavePlaylist'],
      ['savePlaylistAs', 'menuSavePlaylistAs'],
    ] as const)('%s bumps %s on every selection, so a repeat is still seen', (event: string, counter: 'menuShowConfig' | 'menuOpenFile' | 'menuShowHelp' | 'menuOpenPlaylist' | 'menuSavePlaylist' | 'menuSavePlaylistAs'): void => {
      choose(bridge, event);
      choose(bridge, event);

      expect(menu[counter]()).toBe(2);
    });

    it('publishes the chosen visualization', (): void => {
      choose(bridge, 'selectVisualization', 'plasma');

      expect(menu.menuSelectVisualization()).toBe('plasma');
    });

    it('publishes the chosen aspect mode', (): void => {
      choose(bridge, 'selectAspectMode', 'fill');

      expect(menu.menuSelectAspectMode()).toBe('fill');
    });

    it.each([[42], [null], [undefined], [{id: 'plasma'}]])('ignores a visualization id of %o', (value: unknown): void => {
      choose(bridge, 'selectVisualization', value);

      expect(menu.menuSelectVisualization()).toBe('');
    });

    it('ignores an aspect mode that is not a string', (): void => {
      choose(bridge, 'selectAspectMode', 7);

      expect(menu.menuSelectAspectMode()).toBe('');
    });
  });

  describe('selections that are commands', (): void => {
    beforeEach((): void => {
      menu.listen(actions);
    });

    it.each([
      ['togglePlayPause'],
      ['stop'],
      ['toggleShuffle'],
      ['toggleRepeat'],
      ['closeMedia'],
      ['closeAll'],
    ] as const)('%s runs the matching action and no other', (event: 'togglePlayPause' | 'stop' | 'toggleShuffle' | 'toggleRepeat' | 'closeMedia' | 'closeAll'): void => {
      choose(bridge, event);

      for (const name of Object.keys(actions) as (keyof MenuActions)[]) {
        expect(actions[name]).toHaveBeenCalledTimes(name === event ? 1 : 0);
      }
    });

    it('opens the chosen recent file', (): void => {
      choose(bridge, 'openRecentFile', '/music/a.mp3');

      expect(actions.openRecentFile).toHaveBeenCalledWith('/music/a.mp3');
    });

    it('opens the chosen recent playlist', (): void => {
      choose(bridge, 'openRecentPlaylist', '/lists/mix.opp');

      expect(actions.openRecentPlaylist).toHaveBeenCalledWith('/lists/mix.opp');
    });

    it('ignores a recent file that is not a path', (): void => {
      choose(bridge, 'openRecentFile', undefined);

      expect(actions.openRecentFile).not.toHaveBeenCalled();
    });

    it('ignores a recent playlist that is not a path', (): void => {
      choose(bridge, 'openRecentPlaylist', 3);

      expect(actions.openRecentPlaylist).not.toHaveBeenCalled();
    });
  });

  describe('stopListening', (): void => {
    it('removes every listener it registered, once', (): void => {
      menu.listen(actions);

      menu.stopListening();
      menu.stopListening();

      expect(bridge.cleanups.size).toBe(MENU_EVENT_NAMES.length);
      for (const cleanup of bridge.cleanups.values()) {
        expect(cleanup).toHaveBeenCalledTimes(1);
      }
    });

    it('removes its listeners when the service is destroyed', (): void => {
      menu.listen(actions);

      menu.ngOnDestroy();

      expect(bridge.cleanups.get('showConfig')).toHaveBeenCalledTimes(1);
    });
  });
});
