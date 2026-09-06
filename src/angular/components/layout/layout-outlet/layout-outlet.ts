/**
 * @fileoverview Main content outlet that displays audio or video players.
 *
 * This component serves as the central content area of the media player,
 * dynamically switching between the audio outlet (with visualizations) and
 * the video outlet based on the current media type.
 *
 * Responsibilities:
 * - Conditionally renders AudioOutlet or VideoOutlet based on media type
 * - Hosts the Playlist overlay panel
 * - Handles drag-and-drop for adding media files
 * - Displays loading states and track information
 *
 * The component also manages fullscreen-related styling via HostBinding.
 *
 * @module app/components/layout/layout-outlet
 */

import {Component, computed, inject, signal, output, viewChild, ViewChild, HostBinding, ChangeDetectionStrategy} from '@angular/core';
import type {OutputEmitterRef, Signal} from '@angular/core';
import {AudioOutlet} from '../../audio/audio-outlet/audio-outlet';
import {VISUALIZATION_GROUPS} from '../../audio/audio-outlet/visualizations';
import {VideoOutlet, VIDEO_FLIP_OPTIONS, type VideoFlipMode} from '../../video/video-outlet/video-outlet';
import {Playlist} from '../../playlist/playlist';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropTarget} from '../../../directives/file-drop-target';
import {DependencyService} from '../../../services/dependency.service';
import {SkinService} from '../../../skin/skin.service';
import {SettingsService, VIDEO_ASPECT_OPTIONS, type VideoAspectMode} from '../../../services/settings.service';
import {EQ_PRESETS} from '../../../services/equalizer';
import {VIDEO_ADJUSTMENT_PRESETS} from '../../../services/video-adjustments';
import type {DependencyStatus} from '../../../services/dependency.service';
import type {PlaylistItem, SubtitleTrack, AudioTrack} from '../../../types/electron';

/** Special value for "Load External..." option in subtitle select */
const SUBTITLE_LOAD_EXTERNAL_VALUE: number = -3;

/**
 * Main content outlet component that displays the appropriate media player.
 *
 * This is the primary content area that shows either:
 * - AudioOutlet: For audio files, displays visualizations
 * - VideoOutlet: For video files, displays the video element
 * - Empty state: When no media is loaded
 *
 * The component also contains the Playlist panel which can be toggled
 * visible/hidden via the ViewChild reference.
 *
 * Drag-and-drop is supported: users can drop media files onto this
 * component to add them to the playlist and start playing immediately.
 *
 * @example
 * <!-- In root template -->
 * <app-layout-outlet />
 */
@Component({
  selector: 'app-layout-outlet',
  standalone: true,
  imports: [AudioOutlet, VideoOutlet, Playlist, FileDropTarget],
  templateUrl: './layout-outlet.html',
  styleUrl: './layout-outlet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayoutOutlet {
  /** Reference to the playlist panel for programmatic toggle */
  @ViewChild(Playlist) public playlistComponent?: Playlist;

  /** Reference to the audio outlet for visualization control */
  @ViewChild('audioOutlet') public audioOutlet?: AudioOutlet;

  /**
   * Reference to the video outlet for aspect mode and track control.
   *
   * A signal query rather than a plain @ViewChild because the template reads
   * the outlet's own signals *through* this reference (subtitle and audio
   * track dropdowns). The app is zoneless, so a binding that evaluates while
   * a non-signal ViewChild is still undefined would read no signals at all,
   * record no dependencies, and never be re-evaluated — leaving the dropdowns
   * permanently empty. Making the reference itself reactive guarantees every
   * such binding has at least one dependency to wake it when the outlet
   * mounts. Same failure this component already documents for
   * currentAspectMode.
   */
  public readonly videoOutlet: Signal<VideoOutlet | undefined> = viewChild<VideoOutlet>('videoOutlet');

  /** Media player service for playback state */
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for file operations and fullscreen state */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Dependency service for external binary status */
  private readonly deps: DependencyService = inject(DependencyService);

  /** Skin subsystem, consulted to know when the skin window owns playback */
  private readonly skins: SkinService = inject(SkinService);

  /**
   * Whether a skin window is showing and therefore owns playback.
   *
   * While it is, this window's media outlets stand down. They and the skin
   * window's would otherwise both open the same stream, decoding the track
   * twice and drifting apart.
   */
  public readonly skinOwnsPlayback: ReturnType<typeof computed<boolean>> = computed((): boolean => this.skins.isSkinWindowActive());

  /** Settings service for reading the persisted video aspect mode */
  private readonly settings: SettingsService = inject(SettingsService);

  /** Emitted when the user clicks to open dependency settings */
  public readonly openDependencySettings: OutputEmitterRef<void> = output<void>();

  /** Current visualization type (updated reactively from audioOutlet) */
  public readonly currentVisualizationType: ReturnType<typeof signal<string>> = signal<string>('bars');

  /** Visualization options grouped by category for the select dropdown */
  public readonly visualizationGroups: typeof VISUALIZATION_GROUPS = VISUALIZATION_GROUPS;

  /** Signal for video aspect mode display name (updated reactively from videoOutlet) */
  public readonly aspectModeDisplayName: ReturnType<typeof signal<string>> = signal<string>('Default');

  /** Current video flip mode (updated reactively from videoOutlet) */
  public readonly videoFlipMode: ReturnType<typeof signal<VideoFlipMode>> = signal<VideoFlipMode>('none');

  /** Video aspect ratio options for the select dropdown */
  public readonly aspectOptions: typeof VIDEO_ASPECT_OPTIONS = VIDEO_ASPECT_OPTIONS;

  /** Video flip options for the select dropdown */
  public readonly flipOptions: typeof VIDEO_FLIP_OPTIONS = VIDEO_FLIP_OPTIONS;

  /** Equalizer (audio) presets for the select dropdown */
  public readonly equalizerPresets: typeof EQ_PRESETS = EQ_PRESETS;

  /** Video adjustment presets for the select dropdown */
  public readonly videoPresets: typeof VIDEO_ADJUSTMENT_PRESETS = VIDEO_ADJUSTMENT_PRESETS;

  /** Currently selected equalizer preset identifier */
  public readonly currentEqualizerPreset: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings.equalizerPreset()
  );

  /** Currently selected video adjustment preset identifier */
  public readonly currentVideoPreset: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings.videoAdjustmentsPreset()
  );

  /**
   * Current aspect mode value for the select dropdown.
   *
   * Reads directly from the settings service (the source of truth that
   * VideoOutlet.aspectMode() also uses) rather than through the optional
   * `videoOutlet` ViewChild. The ViewChild is a non-signal property that is
   * undefined until a video renders, so a computed reading it would capture
   * zero signal dependencies on first evaluation and cache 'default' forever,
   * leaving the dropdown stuck on "Default" while the video used the real mode.
   */
  public readonly currentAspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.settings.videoAspectMode()
  );

  // ============================================================================
  // Reactive State Signals
  // ============================================================================

  /** Current media type: 'audio', 'video', or null if nothing loaded */
  public readonly mediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed((): 'audio' | 'video' | null => this.mediaPlayer.currentMediaType());

  /**
   * Formatted title of the currently playing track for the media bar.
   * Returns "Artist - Title" when an artist is available, otherwise just the
   * title, or an empty string when nothing is loaded.
   */
  public readonly trackTitle: ReturnType<typeof computed<string>> = computed((): string => {
    const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
    if (!track) return '';
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
  });

  /** Whether the playlist has any items */
  public readonly hasPlaylistItems: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.playlist().items.length > 0);

  /** Whether the current media is audio (and playlist is not empty) */
  public readonly isAudio: ReturnType<typeof computed<boolean>> = computed((): boolean => this.hasPlaylistItems() && this.mediaType() === 'audio');

  /** Whether the current media is video (and playlist is not empty) */
  public readonly isVideo: ReturnType<typeof computed<boolean>> = computed((): boolean => this.hasPlaylistItems() && this.mediaType() === 'video');

  /** Whether media is currently loading */
  public readonly isLoading: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isLoading());

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  /** Whether the application is in miniplayer mode */
  public readonly isMiniplayer: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.viewMode() === 'miniplayer');

  /** Whether any required dependencies are missing */
  public readonly hasMissingDependencies: ReturnType<typeof computed<boolean>> = computed((): boolean => this.deps.hasMissingDependencies());

  /** List of missing dependencies */
  public readonly missingDependencies: ReturnType<typeof computed<DependencyStatus[]>> = computed((): DependencyStatus[] => this.deps.missingDependencies());

  // ============================================================================
  // Host Bindings
  // ============================================================================

  /**
   * Adds 'fullscreen' CSS class when in fullscreen mode.
   * Enables fullscreen-specific styling (e.g., hiding certain elements).
   */
  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

  /**
   * Adds 'miniplayer' CSS class when in miniplayer mode.
   * Removes padding and borders for compact display.
   */
  @HostBinding('class.miniplayer')
  public get miniplayerClass(): boolean {
    return this.isMiniplayer();
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Toggles the playlist panel visibility.
   * Called from external components (e.g., a playlist button).
   */
  public togglePlaylist(): void {
    this.playlistComponent?.toggle();
  }

  /**
   * Emits event to open dependency settings in configuration view.
   */
  public onOpenDependencySettings(): void {
    this.openDependencySettings.emit();
  }

  /**
   * Handles visualization change from select element.
   *
   * @param event - The change event from the select
   */
  public onVisualizationChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      this.audioOutlet?.setVisualization(target.value);
    }
  }

  /**
   * Handles aspect mode change from select element.
   *
   * @param event - The change event from the select
   */
  public onAspectModeChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      this.videoOutlet()?.setAspectMode(target.value as VideoAspectMode);
    }
  }

  /**
   * Handles flip mode change from select element.
   *
   * @param event - The change event from the select
   */
  public onFlipModeChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      this.videoOutlet()?.setFlipMode(target.value as VideoFlipMode);
    }
  }

  /**
   * Handles equalizer preset change from the media bar select element.
   * Selecting a preset also enables the equalizer if it was disabled, so
   * the choice is immediately audible.
   *
   * @param event - The change event from the select
   */
  public onEqualizerPresetChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      if (!this.settings.equalizerEnabled()) {
        void this.settings.setEqualizerEnabled(true);
      }
      void this.settings.setEqualizerPreset(target.value);
    }
  }

  /**
   * Handles video adjustment preset change from the media bar select element.
   * Selecting a preset also enables video adjustments if they were disabled,
   * so the choice is immediately visible.
   *
   * @param event - The change event from the select
   */
  public onVideoPresetChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      if (!this.settings.videoAdjustmentsEnabled()) {
        void this.settings.setVideoAdjustmentsEnabled(true);
      }
      void this.settings.setVideoAdjustmentPreset(target.value);
    }
  }

  // ============================================================================
  // Subtitle Methods
  // ============================================================================

  /**
   * Gets the available subtitle tracks from the video outlet.
   */
  public getSubtitleTracks(): readonly SubtitleTrack[] {
    return this.videoOutlet()?.subtitleTracks() ?? [];
  }

  /**
   * Gets the currently selected subtitle track index.
   * Returns -1 if subtitles are off.
   */
  public getSelectedSubtitleTrack(): number {
    return this.videoOutlet()?.selectedSubtitleTrack() ?? -1;
  }

  /**
   * Gets whether an external subtitle is loaded.
   */
  public hasExternalSubtitle(): boolean {
    return this.videoOutlet()?.hasExternalSubtitle() ?? false;
  }

  /**
   * Handles subtitle track change from select element.
   * Special values: -1 = Off, -2 = External, -3 = Load External...
   *
   * @param event - The change event from the select
   */
  public onSubtitleTrackChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      const value: number = parseInt(target.value, 10);
      if (value === SUBTITLE_LOAD_EXTERNAL_VALUE) {
        // Load External option selected
        this.videoOutlet()?.loadExternalSubtitle();
        // Reset select to current track since "Load External..." is an action, not a selection
        target.value = String(this.getSelectedSubtitleTrack());
      } else {
        this.videoOutlet()?.selectSubtitleTrack(value);
      }
    }
  }

  // ============================================================================
  // Audio Track Methods
  // ============================================================================

  /**
   * Gets the available audio tracks from the video outlet.
   * Returns empty array if no video outlet or no multiple audio tracks.
   */
  public getAudioTracks(): readonly AudioTrack[] {
    return this.videoOutlet()?.audioTracks() ?? [];
  }

  /**
   * Gets the currently selected audio track index.
   * Returns 0 if no video outlet.
   */
  public getSelectedAudioTrack(): number {
    return this.videoOutlet()?.selectedAudioTrack() ?? 0;
  }

  /**
   * Handles audio track change from select element.
   *
   * @param event - The change event from the select
   */
  public onAudioTrackChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      const value: number = parseInt(target.value, 10);
      this.videoOutlet()?.selectAudioTrack(value);
    }
  }

  // ============================================================================
  // Drag and Drop Handlers
  // ============================================================================
}
