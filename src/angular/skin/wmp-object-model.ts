/**
 * @fileoverview The Windows Media Player object model, backed by this player.
 *
 * Skin script is written against `player`, `view`, `app`, `theme` and
 * `mediacenter`, plus the `ps*`/`os*` state constants. None of those exist
 * here, so this module supplies stand-ins whose properties read and write the
 * real MediaPlayerService. A skin calling `player.controls.play()` starts this
 * application's playback; a skin reading `player.currentMedia.durationString`
 * gets the current track's duration formatted the way it expects.
 *
 * The shim is deliberately partial. Skins reach for a great deal that has no
 * counterpart here - CD ripping, media libraries, DVD chapters, licence
 * acquisition - and those properties resolve to inert values rather than
 * throwing, on the principle that a skin missing a burn button is still a
 * usable skin.
 *
 * Unit conversion is the one place to be careful: WMP expresses volume and
 * balance on 0-100 scales and positions in seconds, while this player uses
 * normalised 0-1 volume. Conversions happen at this boundary and nowhere else.
 *
 * @module app/skin/wmp-object-model
 */

import type {MediaPlayerService} from '../services/media-player.service';
import type {PlaylistItem} from '../services/electron.service';

/**
 * WMP playback states, as `player.playState` reports them.
 *
 * Skins compare against these numerically and via the `ps*` globals.
 */
export enum WmpPlayState {
  Undefined = 0,
  Stopped = 1,
  Paused = 2,
  Playing = 3,
  ScanForward = 4,
  ScanReverse = 5,
  Buffering = 6,
  Waiting = 7,
  MediaEnded = 8,
  Transitioning = 9,
  Ready = 10,
  Reconnecting = 11,
}

/**
 * WMP media-open states, as `player.openState` reports them.
 *
 * Only the endpoints matter in practice: skins test `openState == osMediaOpen`
 * to decide whether there is anything to show.
 */
export enum WmpOpenState {
  Undefined = 0,
  PlaylistOpenNoMedia = 6,
  MediaChanging = 8,
  MediaOpening = 12,
  MediaOpen = 13,
}

/**
 * Methods skins call on `app` and `mediacenter` that this player has no
 * equivalent for. They must be callable - a skin's flag handlers invoke them
 * mid-statement - but they do nothing. Reads of any other name fall through to
 * the flag map, so this list must stay methods-only.
 */
const APP_METHODS: ReadonlySet<string> = new Set<string>([
  'switchToControl',
  'switchToPlayerApplication',
  'adjustLeft',
  'adjustTop',
  'launchURL',
]);

/**
 * Wraps an object in WMP's property-lookup semantics.
 *
 * The original object model was COM, where property and method names are
 * case-insensitive, and skins take full advantage: the same file calls
 * `player.controls.play()` and `player.controls.FastForward()`. A case-sensitive
 * object would fail half of those, so lookups fall back to a case-insensitive
 * match before giving up.
 *
 * With `inert` set, names the object does not define at all yield a no-op
 * function. `view` and `theme` need this - skins call a long tail of methods
 * (`view.returnToMediaCenter()`, `theme.openDialog()`) this player has no
 * equivalent for, and a callable that does nothing beats a TypeError that
 * abandons the rest of the handler. It is deliberately *not* used on objects
 * whose properties are read as values: a function is truthy, and
 * `if (player.currentMedia)` must stay honest.
 *
 * @param target - Object whose declared properties take precedence
 * @param inert - Whether undeclared names should yield a no-op function
 * @returns The wrapped object
 */
function asWmpObject(target: object, inert: boolean = false): object {
  return new Proxy(target, {
    get: (object: object, property: string | symbol): unknown => {
      if (property in object) return Reflect.get(object, property);
      if (typeof property === 'symbol') return undefined;

      const wanted: string = property.toLowerCase();
      for (const name of Object.keys(object)) {
        if (name.toLowerCase() === wanted) return Reflect.get(object, name);
      }

      return inert ? (): void => {} : undefined;
    },

    set: (object: object, property: string | symbol, value: unknown): boolean => {
      if (typeof property === 'string' && !(property in object)) {
        const wanted: string = property.toLowerCase();
        for (const name of Object.keys(object)) {
          if (name.toLowerCase() === wanted) return Reflect.set(object, name, value);
        }
      }

      return Reflect.set(object, property, value);
    },
  });
}

/** WMP's upper bound for volume and balance scales. */
const WMP_SCALE_MAXIMUM: number = 100;

/** Seconds per minute, for duration formatting. */
const SECONDS_PER_MINUTE: number = 60;

/** Seconds per hour, for duration formatting. */
const SECONDS_PER_HOUR: number = 3600;

/** Width of the zero-padded seconds and minutes fields in a duration string. */
const TIME_FIELD_WIDTH: number = 2;

/**
 * Formats a duration the way WMP's `*String` properties do.
 *
 * Under an hour the format is `M:SS`; at or over an hour it becomes `H:MM:SS`.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted duration, or `0:00` for values that are not finite
 */
export function formatWmpDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const whole: number = Math.floor(seconds);
  const hours: number = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes: number = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder: number = whole % SECONDS_PER_MINUTE;
  const paddedSeconds: string = remainder.toString().padStart(TIME_FIELD_WIDTH, '0');

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(TIME_FIELD_WIDTH, '0')}:${paddedSeconds}`;
  }

  return `${minutes}:${paddedSeconds}`;
}

/**
 * Builds the object model exposed to a skin's script namespace.
 *
 * The returned objects hold live getters, so script sees current state on every
 * read rather than a snapshot taken at construction.
 *
 * @example
 * const model = new WmpObjectModel(player, () => runtime.invalidate());
 * for (const [name, value] of Object.entries(model.bindings())) {
 *   bindings.set(name, value);
 * }
 */
export class WmpObjectModel {
  /** The player this object model drives */
  private readonly player: MediaPlayerService;

  /** Called when script mutates state that layout depends on */
  private readonly invalidate: () => void;

  /** Backing store for `theme.loadPreference` / `savePreference` */
  private readonly preferences: Map<string, string> = new Map<string, string>();

  /** Mutable flags the skin owns outright, exposed through `app` and `mediacenter` */
  private readonly flags: Map<string, unknown> = new Map<string, unknown>([
    ['taskbarVisible', true],
    ['titleBarVisible', false],
    ['titleBarAutoHide', false],
    ['currentTask', 'NOWPLAYING'],
    ['showTitles', true],
    ['showEffects', true],
    ['showAlbumArt', true],
    ['showAlbumArt2', true],
    ['contrastMode', false],
    ['videoZoom', WMP_SCALE_MAXIMUM],
    ['videoStretchToFit', false],
    ['effectType', ''],
    ['effectPreset', 0],
  ]);

  /** Current view dimensions, updated by the runtime as the window resizes */
  private viewWidth: number = 0;

  /** Current view height, updated by the runtime as the window resizes */
  private viewHeight: number = 0;

  /**
   * Creates the object model.
   *
   * @param player - Player service the model reads and drives
   * @param invalidate - Called when the model changes something layout depends on
   */
  public constructor(player: MediaPlayerService, invalidate: () => void) {
    this.player = player;
    this.invalidate = invalidate;
  }

  /**
   * Records the current view size, which skins read as `view.width`/`height`.
   *
   * @param width - View width in pixels
   * @param height - View height in pixels
   */
  public setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
  }

  /**
   * Reads one of the skin-owned flags.
   *
   * @param name - Flag name
   * @returns Current value, or undefined when the flag is unknown
   */
  public flag(name: string): unknown {
    return this.flags.get(this.canonicalFlag(name));
  }

  /**
   * Resolves a flag name to the casing the map stores it under.
   *
   * Skins spell the same flag several ways across one file - `taskbarVisible`
   * in one place, `taskBarVisible` in another - because the original object
   * model was case-insensitive.
   *
   * @param name - Flag name as script spelled it
   * @returns The stored name, or the given name when the flag is unknown
   */
  private canonicalFlag(name: string): string {
    if (this.flags.has(name)) return name;

    const wanted: string = name.toLowerCase();
    for (const key of this.flags.keys()) {
      if (key.toLowerCase() === wanted) return key;
    }

    return name;
  }

  /**
   * Writes one of the skin-owned flags and schedules a layout pass.
   *
   * @param name - Flag name
   * @param value - New value
   */
  public setFlag(name: string, value: unknown): void {
    const key: string = this.canonicalFlag(name);
    if (this.flags.get(key) === value) return;
    this.flags.set(key, value);
    this.invalidate();
  }

  /**
   * Maps this player's state onto WMP's `playState` enumeration.
   *
   * @returns The equivalent WMP play state
   */
  private playState(): WmpPlayState {
    switch (this.player.playbackState()) {
      case 'playing':
        return WmpPlayState.Playing;
      case 'paused':
        return WmpPlayState.Paused;
      case 'loading':
        return WmpPlayState.Buffering;
      case 'stopped':
        return WmpPlayState.Stopped;
      default:
        return this.player.isEmpty() ? WmpPlayState.Undefined : WmpPlayState.Ready;
    }
  }

  /**
   * Builds the `player.controls` object.
   *
   * Playback calls are fire-and-forget: skin script is synchronous and has
   * nowhere to await a promise, which matches how the original API behaved.
   *
   * @returns The controls object
   */
  private controls(): object {
    const player: MediaPlayerService = this.player;

    return asWmpObject({
      get currentPosition(): number {
        return player.currentTime();
      },
      set currentPosition(value: number) {
        void player.seek(value);
      },
      get currentPositionString(): string {
        return formatWmpDuration(player.currentTime());
      },
      get currentItem(): PlaylistItem | null {
        return player.currentTrack();
      },
      play: (): void => void this.player.play(),
      pause: (): void => void this.player.pause(),
      stop: (): void => void this.player.stop(),
      next: (): void => void this.player.next(),
      previous: (): void => void this.player.previous(),
      fastForward: (): void => void this.player.skipForward(),
      fastReverse: (): void => void this.player.skipBackward(),
      // Frame stepping and playlist-relative seeking have no counterpart here.
      step: (): void => {},
      playItem: (): void => {},
      isAvailable: (name: string): boolean =>
        name === 'Play' || name === 'Pause' || name === 'Stop' ? !player.isEmpty() : false,
    }, true);
  }

  /**
   * Builds the `player.settings` object.
   *
   * Volume and balance are converted from WMP's 0-100 scale to this player's
   * normalised range on the way through.
   *
   * @returns The settings object
   */
  private settings(): object {
    const player: MediaPlayerService = this.player;

    return asWmpObject({
      get volume(): number {
        return Math.round(player.volume() * WMP_SCALE_MAXIMUM);
      },
      set volume(value: number) {
        void player.setVolume(value / WMP_SCALE_MAXIMUM);
      },
      get mute(): boolean {
        return player.muted();
      },
      set mute(value: boolean) {
        if (value !== player.muted()) void player.toggleMute();
      },
      get balance(): number {
        return 0;
      },
      set balance(_value: number) {
        // Channel balance is not modelled by this player.
      },
      get rate(): number {
        return 1;
      },
      set rate(_value: number) {
        // Variable-rate playback is not modelled by this player.
      },
      getMode: (mode: string): boolean => {
        if (mode === 'loop') return this.player.isRepeatEnabled();
        if (mode === 'shuffle') return this.player.isShuffleEnabled();
        return false;
      },
      setMode: (mode: string, enabled: boolean): void => {
        if (mode === 'loop' && enabled !== this.player.isRepeatEnabled()) {
          void this.player.toggleRepeat();
        }
        if (mode === 'shuffle' && enabled !== this.player.isShuffleEnabled()) {
          void this.player.toggleShuffle();
        }
        this.invalidate();
      },
    });
  }

  /**
   * Builds the `player.currentMedia` object, or null when nothing is loaded.
   *
   * `imageSourceWidth`/`Height` are how skins decide whether to show the video
   * pane or the visualisation pane, so they report zero for audio.
   *
   * @returns The current media object, or null
   */
  private currentMedia(): object | null {
    const track: PlaylistItem | null = this.player.currentTrack();
    if (track === null) return null;

    const player: MediaPlayerService = this.player;
    const isVideo: boolean = player.currentMediaType() === 'video';

    // A skin decides between its video pane and its visualisation pane purely
    // by whether the media reports a non-zero image size, so audio must report
    // zero even when the file happens to carry cover art.
    const sourceWidth: number = isVideo ? (track.width ?? 1) : 0;
    const sourceHeight: number = isVideo ? (track.height ?? 1) : 0;

    return asWmpObject({
      get name(): string {
        return track.title;
      },
      get sourceURL(): string {
        return track.filePath;
      },
      get duration(): number {
        return player.duration();
      },
      get durationString(): string {
        return formatWmpDuration(player.duration());
      },
      get imageSourceWidth(): number {
        return sourceWidth;
      },
      get imageSourceHeight(): number {
        return sourceHeight;
      },
      get attributeCount(): number {
        return 0;
      },
      getItemInfo: (attribute: string): string => {
        const lowered: string = attribute.toLowerCase();
        if (lowered === 'title') return track.title;
        if (lowered === 'author' || lowered === 'artist') return track.artist ?? '';
        if (lowered === 'album' || lowered === 'wm/albumtitle') return track.album ?? '';
        if (lowered === 'filetype') return track.type;
        return '';
      },
      setItemInfo: (): void => {},
      getMarkerName: (): string => '',
      isReadOnlyItem: (): boolean => true,
    });
  }

  /**
   * Builds the `player.currentPlaylist` object.
   *
   * @returns The current playlist object
   */
  private currentPlaylist(): object {
    const player: MediaPlayerService = this.player;

    return asWmpObject({
      get count(): number {
        return player.playlistCount();
      },
      get name(): string {
        return 'Now Playing';
      },
      item: (index: number): PlaylistItem | null => player.playlistItems()[index] ?? null,
      getItemInfo: (): string => '',
      appendItem: (): void => {},
      removeItem: (): void => {},
      clear: (): void => void player.clearPlaylist(),
    });
  }

  /**
   * Builds the top-level `player` object.
   *
   * @returns The player object
   */
  private playerObject(): object {
    const player: MediaPlayerService = this.player;
    const controls: object = this.controls();
    const settings: object = this.settings();
    const currentMedia: object | null = this.currentMedia();
    const currentPlaylist: object = this.currentPlaylist();
    const playState: WmpPlayState = this.playState();

    return asWmpObject({
      get controls(): object {
        return controls;
      },
      get settings(): object {
        return settings;
      },
      get currentMedia(): object | null {
        return currentMedia;
      },
      get currentPlaylist(): object {
        return currentPlaylist;
      },
      get playState(): WmpPlayState {
        return playState;
      },
      get openState(): WmpOpenState {
        return player.currentTrack() === null ? WmpOpenState.Undefined : WmpOpenState.MediaOpen;
      },
      get status(): string {
        return player.errorMessage() ?? '';
      },
      get URL(): string {
        return player.currentTrack()?.filePath ?? '';
      },
      get isOnline(): boolean {
        return true;
      },
      get enabled(): boolean {
        return true;
      },
      get error(): object {
        return asWmpObject({errorCount: 0, item: (): object => ({errorCode: 0, errorDescription: ''})}, true);
      },
      get network(): object {
        return asWmpObject(
          {bufferingProgress: WMP_SCALE_MAXIMUM, bitRate: 0, frameRate: 0, receptionQuality: WMP_SCALE_MAXIMUM},
          true
        );
      },
      get closedCaption(): object {
        return asWmpObject({captioningId: '', SAMIStyle: '', SAMILang: ''}, true);
      },
      get cdromCollection(): object {
        return asWmpObject({count: 0, item: (): null => null}, true);
      },
      get playlistCollection(): object {
        return asWmpObject({getAll: (): object[] => [], newPlaylist: (): null => null}, true);
      },
      get dvd(): object {
        return asWmpObject({isAvailable: (): boolean => false, domain: ''}, true);
      },
      // Skins link out to the web from their logo and "buy" buttons. The
      // bridge validates the protocol before handing anything to the shell.
      launchURL: (url: string): void => {
        if (typeof url === 'string' && url !== '') void window.mediaPlayer?.openExternal(url);
      },
      newPlaylist: (): null => null,
      newMedia: (): null => null,
    });
  }

  /**
   * Builds the `view` object, which describes the skin's own window.
   *
   * @returns The view object
   */
  private viewObject(): object {
    const width: number = this.viewWidth;
    const height: number = this.viewHeight;

    return {
      get width(): number {
        return width;
      },
      get height(): number {
        return height;
      },
      get left(): number {
        return 0;
      },
      get top(): number {
        return 0;
      },
      minWidth: 0,
      minHeight: 0,
      // A skinned window is frameless, so these are the only close and minimize
      // controls there are - the skin draws the buttons and expects them to work.
      close: (): void => void window.mediaPlayer?.closeSkinWindow(),
      minimize: (): void => void window.mediaPlayer?.minimizeSkinWindow(),
      maximize: (): void => void window.mediaPlayer?.maximizeSkinWindow(true),
      restore: (): void => void window.mediaPlayer?.maximizeSkinWindow(false),
      // WMP's name for leaving skin mode: the skin's own "return to full mode"
      // button, which here means dismissing the skin window.
      returnToMediaCenter: (): void => void window.mediaPlayer?.closeSkinWindowAndRestore(),
      moveTo: (): void => {},
      resizeTo: (): void => {},
    };
  }

  /**
   * Builds a proxy over the skin-owned flag map.
   *
   * `app` and `mediacenter` both expose flags this way, differing only in which
   * names they carry, so both share one implementation.
   *
   * @returns Proxy reading and writing the flag map
   */
  private flagObject(): object {
    return new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, property: string | symbol): unknown => {
        if (typeof property === 'symbol') return undefined;
        if (APP_METHODS.has(property)) return (): void => {};
        if (property === 'getNamedString') return (): string => '';
        return this.flags.get(this.canonicalFlag(property));
      },
      set: (_target: Record<string, unknown>, property: string | symbol, value: unknown): boolean => {
        if (typeof property === 'string') this.setFlag(property, value);
        return true;
      },
      has: (): boolean => true,
    });
  }

  /**
   * Builds the `theme` object, whose preference store persists nothing beyond
   * the current session.
   *
   * @returns The theme object
   */
  private themeObject(): object {
    return {
      // Localised strings live in wmploc.dll, which this application does not
      // ship. Returning empty rather than throwing matters: skins call this at
      // load time, and a throw would abort the rest of the script file.
      loadString: (): string => '',
      // Skins call this expecting a chosen path back synchronously. There is no
      // synchronous file dialog here, so the application's own open-media flow
      // is started instead and the empty string tells the skin's follow-on code
      // that it has nothing further to do - the flow adds and plays the file
      // itself.
      openDialog: (kind: string): string => {
        if (typeof kind === 'string' && kind.toUpperCase().includes('OPEN')) {
          void this.player.eject();
        }
        return '';
      },
      loadPreference: (name: string): string => this.preferences.get(name) ?? '',
      savePreference: (name: string, value: string): void => {
        this.preferences.set(name, String(value));
      },
      openView: (): void => {},
      closeView: (): void => {},
      get currentViewID(): string {
        return 'View1';
      },
    };
  }

  /**
   * Produces the complete set of names to publish into the script namespace.
   *
   * Called once per layout pass so that objects whose contents change with
   * player state - `currentMedia` above all - are rebuilt rather than stale.
   *
   * @returns Names and values to install as script globals
   */
  public bindings(): Map<string, unknown> {
    const flagObject: object = this.flagObject();
    const bindings: Map<string, unknown> = new Map<string, unknown>([
      ['player', this.playerObject()],
      ['view', asWmpObject(this.viewObject(), true)],
      ['app', flagObject],
      ['mediacenter', flagObject],
      ['theme', asWmpObject(this.themeObject(), true)],
      ['effects', asWmpObject({currentEffectType: '', currentPreset: 0}, true)],
    ]);

    for (const state of Object.keys(WmpPlayState)) {
      const value: unknown = WmpPlayState[state as keyof typeof WmpPlayState];
      if (typeof value === 'number') bindings.set(`ps${state}`, value);
    }

    for (const state of Object.keys(WmpOpenState)) {
      const value: unknown = WmpOpenState[state as keyof typeof WmpOpenState];
      if (typeof value === 'number') bindings.set(`os${state}`, value);
    }

    return bindings;
  }
}
