/**
 * @fileoverview Installs, activates and tears down Windows Media Player skins.
 *
 * This is the application-facing entry point to the skin subsystem: everything
 * beneath it - parsing, scripting, layout, image keying - is reached through
 * here. It owns the single active {@link SkinRuntime}, republishes its render
 * tree as a signal for the host component to draw, and drives the skin's own
 * timer, which is how skins poll for state changes they have no event for.
 *
 * Only one skin is active at a time. Activating another tears the previous one
 * down first, because a runtime holds decoded bitmaps as object URLs and an
 * animation-frame callback that would otherwise keep running.
 *
 * @module app/skin/skin.service
 */

import {Injectable, computed, inject, signal, type Signal, type WritableSignal} from '@angular/core';
import {MediaPlayerService} from '../services/media-player.service';
import {SkinImageService} from './skin-image.service';
import {SkinRuntime, type SkinRenderNode} from './skin-runtime';
import type {SkinScriptError} from './skin-expression';
import type {InstalledSkin, SkinSources} from '../types/electron';

/**
 * Owns the active skin and the catalogue of installed ones.
 *
 * @example
 * await skins.refresh();
 * await skins.activate(skins.available()[0].id);
 */
@Injectable({providedIn: 'root'})
export class SkinService {
  /** Player service the active skin's object model drives */
  private readonly player: MediaPlayerService = inject(MediaPlayerService);

  /** Shared cache of decoded, colour-keyed skin art */
  private readonly images: SkinImageService = inject(SkinImageService);

  /** Installed skins, refreshed from the main process */
  private readonly installed: WritableSignal<InstalledSkin[]> = signal<InstalledSkin[]>([]);

  /** The active skin's render tree, replaced on each settled layout pass */
  private readonly tree: WritableSignal<SkinRenderNode | null> = signal<SkinRenderNode | null>(null);

  /** Identifier of the active skin, or null when none is active */
  private readonly activeId: WritableSignal<string | null> = signal<string | null>(null);

  /** Message describing why the last activation failed, or null */
  private readonly failure: WritableSignal<string | null> = signal<string | null>(null);

  /** The active runtime, held outside signals because it is mutable */
  private runtime: SkinRuntime | null = null;

  /** Handle of the interval driving the skin's own timer */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Installed skins available to activate */
  public readonly available: Signal<readonly InstalledSkin[]> = this.installed.asReadonly();

  /** The active skin's render tree, or null when no skin is active */
  public readonly renderTree: Signal<SkinRenderNode | null> = this.tree.asReadonly();

  /** Identifier of the active skin, or null when none is active */
  public readonly activeSkinId: Signal<string | null> = this.activeId.asReadonly();

  /** Why the last activation failed, or null when it succeeded */
  public readonly error: Signal<string | null> = this.failure.asReadonly();

  /** Whether a skin is currently driving the UI */
  public readonly isActive: Signal<boolean> = computed((): boolean => this.tree() !== null);

  /**
   * Whether the skin window is showing, as seen from any window.
   *
   * The main window reads this to stand its media outlets down: the skin window
   * opens media elements of its own, and two windows decoding the same track
   * would play it twice, drifting apart.
   */
  private readonly skinWindowShowing: WritableSignal<boolean> = signal<boolean>(false);

  /** Whether the skin window is showing */
  public readonly isSkinWindowActive: Signal<boolean> = this.skinWindowShowing.asReadonly();

  /**
   * Subscribes to the skin window opening and closing.
   */
  public constructor() {
    window.mediaPlayer?.onSkinActiveChanged((active: boolean): void => {
      this.skinWindowShowing.set(active);
    });
  }

  /**
   * The Electron bridge, or undefined when running outside Electron.
   *
   * @returns The preload API when present
   */
  private get bridge(): typeof window.mediaPlayer {
    return window.mediaPlayer;
  }

  /**
   * Reloads the list of installed skins from disk.
   */
  public async refresh(): Promise<void> {
    const bridge: typeof window.mediaPlayer = this.bridge;
    if (bridge === undefined) return;
    this.installed.set(await bridge.listSkins());
  }

  /**
   * Prompts for a `.wmz` package, installs it, and activates it.
   *
   * @returns The installed skin, or null when the dialog was cancelled or the
   *          package could not be read
   */
  public async install(): Promise<InstalledSkin | null> {
    const bridge: typeof window.mediaPlayer = this.bridge;
    if (bridge === undefined) return null;

    const skin: InstalledSkin | null = await bridge.installSkin();
    if (skin === null) return null;

    await this.refresh();

    // The skin is drawn in a window of its own, which will read the active id
    // back out of the main process and activate it there.
    await bridge.openSkinWindow(skin.id);
    return skin;
  }

  /**
   * Removes an installed skin, deactivating it first if it is in use.
   *
   * @param id - Identifier of the skin to remove
   */
  public async remove(id: string): Promise<void> {
    const bridge: typeof window.mediaPlayer = this.bridge;
    if (bridge === undefined) return;

    if (this.activeId() === id) this.deactivate();

    await bridge.removeSkin(id);
    await this.refresh();
  }

  /**
   * Activates an installed skin, replacing whichever was active.
   *
   * A skin whose definition cannot be parsed leaves the application unskinned
   * and records the reason rather than throwing into the caller: a bad skin
   * should not take the player down with it.
   *
   * @param id - Identifier of the skin to activate
   * @returns True when the skin came up
   */
  public async activate(id: string): Promise<boolean> {
    const bridge: typeof window.mediaPlayer = this.bridge;
    if (bridge === undefined) return false;

    this.deactivate();

    const sources: SkinSources | null = await bridge.readSkin(id);
    if (sources === null) {
      this.failure.set(`Skin "${id}" could not be read`);
      return false;
    }

    try {
      const runtime: SkinRuntime = new SkinRuntime(
        {skinId: id, definitionSource: sources.definition, scripts: sources.scripts},
        this.player,
        this.images,
        (): void => this.publish()
      );

      this.runtime = runtime;
      this.activeId.set(id);
      this.failure.set(null);
      this.startTimer(runtime);

      // A skin is drawn for one size, and its layout only lands where the
      // author put it at that size, so the window adopts the skin's dimensions
      // rather than the skin stretching to fill whatever the window happened to
      // be. This also settles the first layout before the host has measured.
      const design: {width: number; height: number} = runtime.designSize;
      const minimum: {width: number; height: number} = runtime.minimumSize;

      runtime.resize(design.width, design.height);
      runtime.settle();
      this.publish();

      await bridge.applySkinWindowSize({
        width: design.width,
        height: design.height,
        minWidth: minimum.width,
        minHeight: minimum.height,
      });

      return true;
    } catch (error: unknown) {
      this.failure.set(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Activates whichever skin the main process says this window is for.
   *
   * A skin is chosen in the main window but drawn in a window of its own, so
   * the renderer that shows it is never the one that picked it. The identity
   * crosses that gap through the main process.
   */
  public async restoreActive(): Promise<void> {
    const bridge: typeof window.mediaPlayer = this.bridge;
    if (bridge === undefined) return;

    const id: string | null = await bridge.getActiveSkin();
    if (id === null) return;

    await this.refresh();

    // Nothing else will ever show this window if the skin does not come up, and
    // it is the only window the user can see, so it has to take itself away.
    if (!(await this.activate(id))) {
      await bridge.closeSkinWindowAndRestore();
    }
  }

  /**
   * Tears the active skin down, releasing its art and stopping its timer.
   */
  public deactivate(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.runtime?.destroy();
    this.runtime = null;
    this.tree.set(null);
    this.activeId.set(null);
  }

  /**
   * Dismisses the skin, closing its window and revealing the built-in interface.
   */
  public dismiss(): void {
    this.deactivate();
    void this.bridge?.closeSkinWindowAndRestore();
  }

  /**
   * Starts the interval driving a skin's `ontimer` handler.
   *
   * @param runtime - Runtime whose timer should run
   */
  private startTimer(runtime: SkinRuntime): void {
    const interval: number | null = runtime.timerInterval();
    if (interval === null) return;

    this.timer = setInterval((): void => runtime.tick(), interval);
  }

  /**
   * Publishes the active runtime's current render tree.
   */
  private publish(): void {
    this.tree.set(this.runtime?.render() ?? null);
  }

  /**
   * Tells the active skin how much room it has.
   *
   * @param width - Available width in pixels
   * @param height - Available height in pixels
   */
  public resize(width: number, height: number): void {
    this.runtime?.resize(width, height);
  }

  /**
   * The active runtime, for the host component to dispatch input into.
   *
   * @returns The active runtime, or null when no skin is active
   */
  public current(): SkinRuntime | null {
    return this.runtime;
  }

  /**
   * Script failures recorded by the active skin.
   *
   * A skin that renders with a handful of these is normal - skins reference
   * player features this application does not have - so they are surfaced for
   * diagnosis rather than treated as activation failures.
   *
   * @returns Recorded errors, oldest first
   */
  public scriptErrors(): readonly SkinScriptError[] {
    return this.runtime?.errors ?? [];
  }
}
