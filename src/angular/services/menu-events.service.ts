/**
 * @fileoverview Application menu events, as signals and as actions.
 *
 * The main process forwards every menu selection to the renderer. Selections
 * that a component must respond to — open a dialog, show a view, switch
 * visualization — are published as signals for that component to watch.
 * Selections that are plain commands — play, stop, shuffle — are handed to
 * the {@link MenuActions} supplied by whoever owns the player, so this
 * service needs no knowledge of how a command is carried out.
 *
 * @module app/services/menu-events.service
 */

import {Injectable, NgZone, OnDestroy, inject, signal} from '@angular/core';

/**
 * What to do for each menu selection that is a command rather than a request
 * for a component to act.
 */
export interface MenuActions {
  /** Play/Pause was chosen. */
  readonly togglePlayPause: () => void;
  /** Stop was chosen. */
  readonly stop: () => void;
  /** Shuffle was toggled. */
  readonly toggleShuffle: () => void;
  /** Repeat was toggled. */
  readonly toggleRepeat: () => void;
  /** File > Close was chosen: close the current media. */
  readonly closeMedia: () => void;
  /** File > Close All was chosen: stop and clear the playlist. */
  readonly closeAll: () => void;
  /** A recent file was chosen. */
  readonly openRecentFile: (filePath: string) => void;
  /** A recent playlist was chosen. */
  readonly openRecentPlaylist: (playlistPath: string) => void;
}

/**
 * Listens to application menu events and publishes them.
 */
@Injectable({providedIn: 'root'})
export class MenuEvents implements OnDestroy {
  /** Runs IPC callbacks inside Angular so signal writes are picked up. */
  private readonly ngZone: NgZone = inject(NgZone);

  /** Signal emitted when "Show Config" menu item is selected */
  public readonly menuShowConfig: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Open File" menu item is selected */
  public readonly menuOpenFile: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Show Help" menu item is selected */
  public readonly menuShowHelp: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Open Playlist" menu item is selected */
  public readonly menuOpenPlaylist: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Save Playlist" menu item is selected */
  public readonly menuSavePlaylist: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Save Playlist As" menu item is selected */
  public readonly menuSavePlaylistAs: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when a visualization is selected from the menu */
  public readonly menuSelectVisualization: ReturnType<typeof signal<string>> = signal<string>('');

  /** Signal emitted when an aspect mode is selected from the menu */
  public readonly menuSelectAspectMode: ReturnType<typeof signal<string>> = signal<string>('');

  /** Cleanup functions for menu event listeners */
  private readonly menuCleanupFunctions: Array<() => void> = [];

  /**
   * Gets the preload API for IPC calls.
   *
   * @returns The window.mediaPlayer API or undefined
   */
  private get api(): typeof window.mediaPlayer {
    return window.mediaPlayer;
  }

  /**
   * Sets up listeners for application menu events.
   *
   * @param actions - What to do for each command-style menu selection
   */
  public listen(actions: MenuActions): void {
    if (!this.api) return;

    this.onCount('showConfig', this.menuShowConfig);
    this.onCount('openFile', this.menuOpenFile);
    this.onAction('togglePlayPause', actions.togglePlayPause);
    this.onAction('stop', actions.stop);
    this.onAction('toggleShuffle', actions.toggleShuffle);
    this.onAction('toggleRepeat', actions.toggleRepeat);
    this.onText('selectVisualization', (id: string): void => this.menuSelectVisualization.set(id));
    this.onText('selectAspectMode', (mode: string): void => this.menuSelectAspectMode.set(mode));
    this.onAction('closeMedia', actions.closeMedia);
    this.onAction('closeAll', actions.closeAll);
    this.onCount('showHelp', this.menuShowHelp);
    this.onCount('openPlaylist', this.menuOpenPlaylist);
    this.onCount('savePlaylist', this.menuSavePlaylist);
    this.onCount('savePlaylistAs', this.menuSavePlaylistAs);
    this.onText('openRecentFile', actions.openRecentFile);
    this.onText('openRecentPlaylist', actions.openRecentPlaylist);
  }

  /**
   * Removes every menu listener.
   */
  public stopListening(): void {
    for (const cleanup of this.menuCleanupFunctions.splice(0)) {
      cleanup();
    }
  }

  /**
   * Cleanup when the service is destroyed.
   */
  public ngOnDestroy(): void {
    this.stopListening();
  }

  /**
   * Bumps a counter signal each time a menu event fires, so that components
   * watching it react to every selection, including a repeated one.
   *
   * @param event - The menu event name
   * @param counter - The signal to increment
   */
  private onCount(event: string, counter: ReturnType<typeof signal<number>>): void {
    this.onAction(event, (): void => counter.update((v: number): number => v + 1));
  }

  /**
   * Runs an action each time a menu event fires.
   *
   * @param event - The menu event name
   * @param action - What to do
   */
  private onAction(event: string, action: () => void): void {
    if (!this.api) return;

    this.menuCleanupFunctions.push(
      this.api.onMenuEvent(event, (): void => {
        this.ngZone.run(action);
      })
    );
  }

  /**
   * Runs an action with a menu event's argument, when it is the string the
   * event is documented to carry. Anything else is ignored: the value crosses
   * the IPC boundary untyped.
   *
   * @param event - The menu event name
   * @param action - What to do with the argument
   */
  private onText(event: string, action: (value: string) => void): void {
    if (!this.api) return;

    this.menuCleanupFunctions.push(
      this.api.onMenuEvent(event, (value: unknown): void => {
        this.ngZone.run((): void => {
          if (typeof value === 'string') {
            action(value);
          }
        });
      })
    );
  }
}
