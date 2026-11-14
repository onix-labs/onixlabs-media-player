/**
 * @fileoverview Unit tests for LayoutOutlet component.
 *
 * Tests reactive signal state, computed signal derivations, host bindings,
 * drag-and-drop handlers, and delegation to child components using mock
 * services for MediaPlayerService, ElectronService, FileDropService,
 * and DependencyService.
 *
 * @module app/components/layout/layout-outlet/layout-outlet.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {Component, forwardRef, output, OutputEmitterRef, signal, WritableSignal, NO_ERRORS_SCHEMA} from '@angular/core';
import {By} from '@angular/platform-browser';
import {LayoutOutlet} from './layout-outlet';
import {Playlist} from '../../playlist/playlist';
import {FileDropTarget} from '../../../directives/file-drop-target';
import {VISUALIZATION_GROUPS} from '../../audio/audio-outlet/visualizations';
import type {VideoFlipMode} from '../../video/video-outlet/video-outlet';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {DependencyService} from '../../../services/dependency.service';
import {SettingsService} from '../../../services/settings.service';
import type {DependencyStatus} from '../../../services/dependency.service';
import type {PlaylistItem, PlaylistState, SubtitleTrack, AudioTrack} from '../../../types/electron';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a PlaylistItem with sensible defaults for testing.
 *
 * @param overrides - Partial PlaylistItem fields to override
 * @returns A complete PlaylistItem
 */
function createPlaylistItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: 'test-id-1',
    filePath: '/music/song.mp3',
    title: 'Test Song',
    duration: 180,
    type: 'audio',
    ...overrides,
  };
}


// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock MediaPlayerService with controllable signals and stub methods.
 */
function createMockMediaPlayerService(): Record<string, unknown> {
  return {
    currentMediaType: signal(null as 'audio' | 'video' | null),
    isPlaying: signal(false),
    isPaused: signal(false),
    isLoading: signal(false),
    currentTrack: signal(null),
    playlistItems: signal([]),
    playlistCount: signal(0),
    playbackState: signal('idle'),
    selectTrack: vi.fn().mockResolvedValue(undefined),
    removeTrack: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    clearPlaylist: vi.fn().mockResolvedValue(undefined),
    formatTime: vi.fn((seconds: number): string => {
      const m: number = Math.floor(seconds / 60);
      const s: number = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }),
  };
}

/**
 * Creates a mock ElectronService with controllable signals and stub methods.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    viewMode: signal('desktop'),
    playlist: signal({items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false}),
    addFilesWithAutoPlay: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock FileDropService with a stub extractMediaFilePaths method.
 */
function createMockFileDropService(): Record<string, unknown> {
  return {
    extractMediaFilePaths: vi.fn().mockReturnValue([]),
    hasValidFiles: vi.fn().mockReturnValue(true),
  };
}

/**
 * Creates a mock DependencyService with controllable signals.
 */
function createMockDependencyService(): Record<string, unknown> {
  return {
    hasMissingDependencies: signal(false),
    missingDependencies: signal([]),
    noDependenciesInstalled: signal(false),
  };
}

/**
 * Creates a mock SettingsService exposing the signals that drive the media
 * bar dropdowns (aspect ratio, equalizer preset, video adjustment preset).
 */
function createMockSettingsService(): Record<string, unknown> {
  return {
    videoAspectMode: signal<string>('default'),
    equalizerEnabled: signal<boolean>(false),
    equalizerPreset: signal<string>('flat'),
    videoAdjustmentsEnabled: signal<boolean>(false),
    videoAdjustmentsPreset: signal<string>('default'),
    setEqualizerEnabled: vi.fn().mockResolvedValue(undefined),
    setEqualizerPreset: vi.fn().mockResolvedValue(undefined),
    setVideoAdjustmentsEnabled: vi.fn().mockResolvedValue(undefined),
    setVideoAdjustmentPreset: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('LayoutOutlet', (): void => {
  let component: LayoutOutlet;
  let fixture: ComponentFixture<LayoutOutlet>;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockFileDrop: ReturnType<typeof createMockFileDropService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;
  let mockSettings: ReturnType<typeof createMockSettingsService>;

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockFileDrop = createMockFileDropService();
    mockDeps = createMockDependencyService();
    mockSettings = createMockSettingsService();

    await TestBed.configureTestingModule({
      imports: [LayoutOutlet],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: FileDropService, useValue: mockFileDrop},
        {provide: DependencyService, useValue: mockDeps},
        {provide: SettingsService, useValue: mockSettings},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(LayoutOutlet);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  // ==========================================================================
  // Creation
  // ==========================================================================

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });

  // ==========================================================================
  // Computed Signals
  // ==========================================================================

  describe('computed signals', (): void => {
    it('mediaType reflects media player state', (): void => {
      const mediaType: WritableSignal<'audio' | 'video' | null> = mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>;
      mediaType.set('audio');

      const result: 'audio' | 'video' | null = component.mediaType();
      expect(result).toBe('audio');
    });

    it('hasPlaylistItems true when items exist', (): void => {
      const playlist: WritableSignal<PlaylistState> = mockElectron['playlist'] as WritableSignal<PlaylistState>;
      const item: PlaylistItem = createPlaylistItem();
      playlist.set({items: [item], currentIndex: 0, shuffleEnabled: false, repeatEnabled: false});

      const result: boolean = component.hasPlaylistItems();
      expect(result).toBe(true);
    });

    it('isAudio true when audio and items present', (): void => {
      const playlist: WritableSignal<PlaylistState> = mockElectron['playlist'] as WritableSignal<PlaylistState>;
      const mediaType: WritableSignal<'audio' | 'video' | null> = mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>;
      const item: PlaylistItem = createPlaylistItem({type: 'audio'});
      playlist.set({items: [item], currentIndex: 0, shuffleEnabled: false, repeatEnabled: false});
      mediaType.set('audio');

      const result: boolean = component.isAudio();
      expect(result).toBe(true);
    });

    it('isVideo true when video and items present', (): void => {
      const playlist: WritableSignal<PlaylistState> = mockElectron['playlist'] as WritableSignal<PlaylistState>;
      const mediaType: WritableSignal<'audio' | 'video' | null> = mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>;
      const item: PlaylistItem = createPlaylistItem({type: 'video'});
      playlist.set({items: [item], currentIndex: 0, shuffleEnabled: false, repeatEnabled: false});
      mediaType.set('video');

      const result: boolean = component.isVideo();
      expect(result).toBe(true);
    });

    it('isAudio false when no items even if audio type', (): void => {
      const mediaType: WritableSignal<'audio' | 'video' | null> = mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>;
      mediaType.set('audio');

      const result: boolean = component.isAudio();
      expect(result).toBe(false);
    });

    it('isLoading reflects media player state', (): void => {
      const isLoading: WritableSignal<boolean> = mockMediaPlayer['isLoading'] as WritableSignal<boolean>;
      isLoading.set(true);

      const result: boolean = component.isLoading();
      expect(result).toBe(true);
    });

    it('isFullscreen reflects electron service', (): void => {
      const isFullscreen: WritableSignal<boolean> = mockElectron['isFullscreen'] as WritableSignal<boolean>;
      isFullscreen.set(true);

      const result: boolean = component.isFullscreen();
      expect(result).toBe(true);
    });

    it('isMiniplayer true when viewMode is miniplayer', (): void => {
      const viewMode: WritableSignal<string> = mockElectron['viewMode'] as WritableSignal<string>;
      viewMode.set('miniplayer');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(true);
    });

    it('hasMissingDependencies reflects dependency service', (): void => {
      const hasMissing: WritableSignal<boolean> = mockDeps['hasMissingDependencies'] as WritableSignal<boolean>;
      hasMissing.set(true);

      const result: boolean = component.hasMissingDependencies();
      expect(result).toBe(true);
    });

    it('missingDependencies reflects dependency service', (): void => {
      const missing: WritableSignal<DependencyStatus[]> = mockDeps['missingDependencies'] as WritableSignal<DependencyStatus[]>;
      const dep: DependencyStatus = {
        id: 'ffmpeg',
        name: 'FFmpeg',
        installed: false,
        path: null,
        source: null,
        version: null,
        managed: false,
        description: 'FFmpeg dependency',
        websiteUrl: 'https://example.com/ffmpeg',
      };
      missing.set([dep]);

      const result: DependencyStatus[] = component.missingDependencies();
      expect(result).toEqual([dep]);
    });
  });

  // ==========================================================================
  // Host Bindings
  // ==========================================================================

  describe('host bindings', (): void => {
    it('fullscreenClass returns isFullscreen value', (): void => {
      const isFullscreen: WritableSignal<boolean> = mockElectron['isFullscreen'] as WritableSignal<boolean>;
      isFullscreen.set(true);

      const result: boolean = component.fullscreenClass;
      expect(result).toBe(true);
    });

    it('miniplayerClass returns isMiniplayer value', (): void => {
      const viewMode: WritableSignal<string> = mockElectron['viewMode'] as WritableSignal<string>;
      viewMode.set('miniplayer');

      const result: boolean = component.miniplayerClass;
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  describe('public methods', (): void => {
    it('togglePlaylist delegates to playlistComponent', (): void => {
      const mockToggle: ReturnType<typeof vi.fn> = vi.fn();
      component.playlistComponent = {toggle: mockToggle} as unknown as import('../../playlist/playlist').Playlist;

      component.togglePlaylist();

      expect(mockToggle).toHaveBeenCalledOnce();
    });

    it('togglePlaylist does nothing when playlistComponent is undefined', (): void => {
      component.playlistComponent = undefined;

      expect((): void => component.togglePlaylist()).not.toThrow();
    });

    it('onOpenDependencySettings emits event', (): void => {
      let emitted: boolean = false;
      component.openDependencySettings.subscribe((): void => { emitted = true; });

      component.onOpenDependencySettings();

      expect(emitted).toBe(true);
    });
  });

  // ==========================================================================
  // Writable Signals
  // ==========================================================================

  describe('writable signals', (): void => {

    it('currentVisualizationType defaults to bars', (): void => {
      expect(component.currentVisualizationType()).toBe('bars');
    });

    it('aspectModeDisplayName defaults to Default', (): void => {
      const result: string = component.aspectModeDisplayName();
      expect(result).toBe('Default');
    });

    it('currentAspectMode reflects the persisted setting', (): void => {
      expect(component.currentAspectMode()).toBe('default');

      // Reacts to setting changes (not stuck on 'default' like the old
      // computed over the optional videoOutlet ViewChild).
      (mockSettings['videoAspectMode'] as WritableSignal<string>).set('fit');

      expect(component.currentAspectMode()).toBe('fit');
    });

    it('videoFlipMode defaults to none', (): void => {
      expect(component.videoFlipMode()).toBe('none');
    });

    it('onFlipModeChange is a no-op when no video outlet is present', (): void => {
      // videoOutlet is undefined in the test harness; the call must not throw.
      const event: Event = {target: {value: 'horizontal'} as HTMLSelectElement} as unknown as Event;
      expect((): void => component.onFlipModeChange(event)).not.toThrow();
    });
  });

  // ==========================================================================
  // Computed Signals - Track Title
  // ==========================================================================

  describe('trackTitle', (): void => {
    it('returns "Artist - Title" when artist is present', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem({title: 'My Song', artist: 'Test Artist'})
      );
      expect(component.trackTitle()).toBe('Test Artist - My Song');
    });

    it('returns just the title when no artist', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem({title: 'Solo Track', artist: undefined})
      );
      expect(component.trackTitle()).toBe('Solo Track');
    });

    it('returns an empty string when no track', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(null);
      expect(component.trackTitle()).toBe('');
    });
  });
});

// ============================================================================
// Rendered behaviour
// ============================================================================

/** Stand-in for the audio outlet: records the visualization it is asked to show. */
@Component({selector: 'app-audio-outlet', template: ''})
class StubAudioOutlet {
  public readonly setVisualization: ReturnType<typeof vi.fn> = vi.fn();
  public readonly visualizationChange: OutputEmitterRef<string> = output<string>();
}

/** Stand-in for the video outlet: exposes controllable tracks and records commands. */
@Component({selector: 'app-video-outlet', template: ''})
class StubVideoOutlet {
  public readonly subtitleTracks: WritableSignal<readonly SubtitleTrack[]> = signal<readonly SubtitleTrack[]>([]);
  public readonly selectedSubtitleTrack: WritableSignal<number> = signal<number>(-1);
  public readonly hasExternalSubtitle: WritableSignal<boolean> = signal<boolean>(false);
  public readonly audioTracks: WritableSignal<readonly AudioTrack[]> = signal<readonly AudioTrack[]>([]);
  public readonly selectedAudioTrack: WritableSignal<number> = signal<number>(0);
  public readonly setAspectMode: ReturnType<typeof vi.fn> = vi.fn();
  public readonly setFlipMode: ReturnType<typeof vi.fn> = vi.fn();
  public readonly loadExternalSubtitle: ReturnType<typeof vi.fn> = vi.fn();
  public readonly selectSubtitleTrack: ReturnType<typeof vi.fn> = vi.fn();
  public readonly selectAudioTrack: ReturnType<typeof vi.fn> = vi.fn();
  public readonly aspectModeChange: OutputEmitterRef<string> = output<string>();
  public readonly flipChange: OutputEmitterRef<VideoFlipMode> = output<VideoFlipMode>();
}

/** Stand-in for the playlist. The outlet finds the real one by class, so the stub answers to it. */
@Component({
  selector: 'app-playlist',
  template: '',
  providers: [{provide: Playlist, useExisting: forwardRef((): typeof StubPlaylist => StubPlaylist)}],
})
class StubPlaylist {
  public readonly toggle: ReturnType<typeof vi.fn> = vi.fn();
}

/**
 * Creates a subtitle track with sensible defaults.
 */
function createSubtitleTrack(index: number, title: string, forced: boolean = false): SubtitleTrack {
  return {index, title, forced, language: 'eng', codec: 'subrip'} as SubtitleTrack;
}

/**
 * Creates an audio track with sensible defaults.
 */
function createAudioTrack(index: number, title: string, channels: number = 2): AudioTrack {
  return {index, title, channels, language: 'eng', codec: 'aac'} as AudioTrack;
}

describe('LayoutOutlet rendered', (): void => {
  let component: LayoutOutlet;
  let fixture: ComponentFixture<LayoutOutlet>;
  let host: HTMLElement;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;
  let mockSettings: ReturnType<typeof createMockSettingsService>;

  /**
   * Loads a track of the given type, as the server would report it.
   */
  async function loadMedia(type: 'audio' | 'video', overrides: Partial<PlaylistItem> = {}): Promise<void> {
    const item: PlaylistItem = createPlaylistItem({type, ...overrides});
    (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({items: [item], currentIndex: 0, shuffleEnabled: false, repeatEnabled: false});
    (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set(type);
    (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(item);
    await fixture.whenStable();
  }

  /** Finds a media bar dropdown by its tooltip. */
  function select(title: string): HTMLSelectElement | null {
    return host.querySelector<HTMLSelectElement>(`select[title="${title}"]`);
  }

  /** Lists the option labels of a media bar dropdown. */
  function optionLabels(title: string): string[] {
    return Array.from(select(title)!.options).map((option: HTMLOptionElement): string => option.textContent.trim());
  }

  /** Picks a value in a media bar dropdown, as a user would. */
  function choose(title: string, value: string): void {
    const element: HTMLSelectElement = select(title)!;
    element.value = value;
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }

  /** Returns the stand-in video outlet. */
  function videoOutlet(): StubVideoOutlet {
    return fixture.debugElement.query(By.directive(StubVideoOutlet)).componentInstance as StubVideoOutlet;
  }

  /** Returns the stand-in audio outlet. */
  function audioOutlet(): StubAudioOutlet {
    return fixture.debugElement.query(By.directive(StubAudioOutlet)).componentInstance as StubAudioOutlet;
  }

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockDeps = createMockDependencyService();
    mockSettings = createMockSettingsService();

    await TestBed.configureTestingModule({
      imports: [LayoutOutlet],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: FileDropService, useValue: createMockFileDropService()},
        {provide: DependencyService, useValue: mockDeps},
        {provide: SettingsService, useValue: mockSettings},
      ],
    })
      .overrideComponent(LayoutOutlet, {
        set: {imports: [StubAudioOutlet, StubVideoOutlet, StubPlaylist, FileDropTarget]},
      })
      .compileComponents();

    fixture = TestBed.createComponent(LayoutOutlet);
    component = fixture.componentInstance;
    host = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  // ==========================================================================
  // Idle state
  // ==========================================================================

  describe('with nothing loaded', (): void => {
    it('shows the idle prompt instead of an outlet', (): void => {
      expect(host.querySelector('.idle-state')?.textContent).toContain('No media loaded');
      expect(host.querySelector('app-audio-outlet')).toBeNull();
      expect(host.querySelector('app-video-outlet')).toBeNull();
    });

    it('offers no media-specific dropdowns', (): void => {
      expect(host.querySelectorAll('.media-bar select')).toHaveLength(0);
    });

    it('shows no dependency warnings when nothing is missing', (): void => {
      expect(host.querySelector('.dependency-warnings')).toBeNull();
    });

    it('keeps showing the idle prompt while a media type is known but the playlist is empty', async (): Promise<void> => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set('video');
      await fixture.whenStable();

      expect(host.querySelector('.idle-state')).not.toBeNull();
      expect(host.querySelector('app-video-outlet')).toBeNull();
    });

    describe('and dependencies missing', (): void => {
      const missing: DependencyStatus[] = [
        {id: 'ffmpeg', name: 'FFmpeg', description: 'Plays audio and video'} as DependencyStatus,
        {id: 'fluidsynth', name: 'FluidSynth', description: 'Plays MIDI'} as DependencyStatus,
      ];

      beforeEach(async (): Promise<void> => {
        (mockDeps['missingDependencies'] as WritableSignal<DependencyStatus[]>).set(missing);
        (mockDeps['hasMissingDependencies'] as WritableSignal<boolean>).set(true);
        await fixture.whenStable();
      });

      it('warns about each missing dependency by name and purpose', (): void => {
        const warnings: string[] = Array.from(host.querySelectorAll('.dependency-warning-text'))
          .map((element: Element): string => element.textContent.replace(/\s+/g, ' ').trim());

        expect(warnings).toEqual(['FFmpeg missing — Plays audio and video', 'FluidSynth missing — Plays MIDI']);
      });

      it('asks for the dependency settings when Open Settings is clicked', (): void => {
        let requests: number = 0;
        component.openDependencySettings.subscribe((): void => {
          requests++;
        });

        host.querySelector<HTMLButtonElement>('.dependency-settings-link')!.click();

        expect(requests).toBe(1);
      });

      it('drops focus from Open Settings once the mouse is released', (): void => {
        const button: HTMLButtonElement = host.querySelector<HTMLButtonElement>('.dependency-settings-link')!;
        button.focus();

        button.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

        expect(document.activeElement).not.toBe(button);
      });
    });
  });

  // ==========================================================================
  // Chrome
  // ==========================================================================

  describe('chrome', (): void => {
    it('shows the playlist and the media bar on the desktop', (): void => {
      expect(host.querySelector('app-playlist')).not.toBeNull();
      expect(host.querySelector('.media-bar')).not.toBeNull();
    });

    it('hides the playlist and the media bar in fullscreen', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      await fixture.whenStable();

      expect(host.querySelector('app-playlist')).toBeNull();
      expect(host.querySelector('.media-bar')).toBeNull();
      expect(host.classList.contains('fullscreen')).toBe(true);
    });

    it('hides the playlist and the media bar in the miniplayer', async (): Promise<void> => {
      (mockElectron['viewMode'] as WritableSignal<string>).set('miniplayer');
      await fixture.whenStable();

      expect(host.querySelector('app-playlist')).toBeNull();
      expect(host.querySelector('.media-bar')).toBeNull();
      expect(host.classList.contains('miniplayer')).toBe(true);
    });

    it('toggles the playlist from the media bar button', (): void => {
      const playlist: StubPlaylist = fixture.debugElement.query(By.directive(StubPlaylist)).componentInstance as StubPlaylist;

      host.querySelector<HTMLButtonElement>('.playlist-toggle')!.click();

      expect(playlist.toggle).toHaveBeenCalledTimes(1);
    });

    it('drops focus from the playlist button once the mouse is released', (): void => {
      const button: HTMLButtonElement = host.querySelector<HTMLButtonElement>('.playlist-toggle')!;
      button.focus();

      button.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

      expect(document.activeElement).not.toBe(button);
    });

    it('shows the artist and title of the current track', async (): Promise<void> => {
      await loadMedia('audio', {artist: 'Nina Simone', title: 'Sinnerman'});

      expect(host.querySelector('.media-title')?.textContent).toBe('Nina Simone - Sinnerman');
    });
  });

  // ==========================================================================
  // Audio
  // ==========================================================================

  describe('with audio loaded', (): void => {
    beforeEach(async (): Promise<void> => {
      await loadMedia('audio');
    });

    it('renders the audio outlet in place of the idle prompt', (): void => {
      expect(host.querySelector('app-audio-outlet')).not.toBeNull();
      expect(host.querySelector('app-video-outlet')).toBeNull();
      expect(host.querySelector('.idle-state')).toBeNull();
    });

    it('offers only the audio dropdowns', (): void => {
      const titles: (string | null)[] = Array.from(host.querySelectorAll('.media-bar select'))
        .map((element: Element): string | null => element.getAttribute('title'));

      expect(titles).toEqual(['Visualization', 'Audio preset']);
    });

    it('groups the visualizations by category', (): void => {
      const labels: string[] = Array.from(select('Visualization')!.querySelectorAll('optgroup'))
        .map((group: HTMLOptGroupElement): string => group.label);

      expect(labels).toEqual(VISUALIZATION_GROUPS.map((group: {category: string}): string => group.category));
    });

    it('asks the audio outlet for the chosen visualization', (): void => {
      choose('Visualization', 'neon');

      expect(audioOutlet().setVisualization).toHaveBeenCalledExactlyOnceWith('neon');
    });

    it('selects the visualization the audio outlet reports', async (): Promise<void> => {
      audioOutlet().visualizationChange.emit('tunnel');
      await fixture.whenStable();

      expect(select('Visualization')!.value).toBe('tunnel');
    });

    it('selects the saved equalizer preset', async (): Promise<void> => {
      (mockSettings['equalizerPreset'] as WritableSignal<string>).set('jazz');
      await fixture.whenStable();

      expect(select('Audio preset')!.value).toBe('jazz');
    });

    it('switches the equalizer on when a preset is chosen while it is off', (): void => {
      choose('Audio preset', 'rock');

      expect(mockSettings['setEqualizerEnabled']).toHaveBeenCalledExactlyOnceWith(true);
      expect(mockSettings['setEqualizerPreset']).toHaveBeenCalledExactlyOnceWith('rock');
    });

    it('only changes the preset when the equalizer is already on', (): void => {
      (mockSettings['equalizerEnabled'] as WritableSignal<boolean>).set(true);

      choose('Audio preset', 'rock');

      expect(mockSettings['setEqualizerEnabled']).not.toHaveBeenCalled();
      expect(mockSettings['setEqualizerPreset']).toHaveBeenCalledExactlyOnceWith('rock');
    });
  });

  // ==========================================================================
  // Video
  // ==========================================================================

  describe('with video loaded', (): void => {
    beforeEach(async (): Promise<void> => {
      await loadMedia('video');
    });

    it('renders the video outlet in place of the idle prompt', (): void => {
      expect(host.querySelector('app-video-outlet')).not.toBeNull();
      expect(host.querySelector('app-audio-outlet')).toBeNull();
      expect(host.querySelector('.idle-state')).toBeNull();
    });

    it('offers only the video dropdowns', (): void => {
      const titles: (string | null)[] = Array.from(host.querySelectorAll('.media-bar select'))
        .map((element: Element): string | null => element.getAttribute('title'));

      expect(titles).toEqual(['Aspect ratio', 'Subtitles', 'Flip video', 'Video preset']);
    });

    it('selects the saved aspect ratio', async (): Promise<void> => {
      (mockSettings['videoAspectMode'] as WritableSignal<string>).set('4:3');
      await fixture.whenStable();

      expect(select('Aspect ratio')!.value).toBe('4:3');
    });

    it('asks the video outlet for the chosen aspect ratio', (): void => {
      choose('Aspect ratio', '16:9');

      expect(videoOutlet().setAspectMode).toHaveBeenCalledExactlyOnceWith('16:9');
    });

    it('records the aspect ratio name the video outlet reports', (): void => {
      videoOutlet().aspectModeChange.emit('Forced (16:9)');

      expect(component.aspectModeDisplayName()).toBe('Forced (16:9)');
    });

    it('asks the video outlet for the chosen flip', (): void => {
      choose('Flip video', 'horizontal');

      expect(videoOutlet().setFlipMode).toHaveBeenCalledExactlyOnceWith('horizontal');
    });

    it('selects the flip the video outlet reports', async (): Promise<void> => {
      videoOutlet().flipChange.emit('vertical');
      await fixture.whenStable();

      expect(select('Flip video')!.value).toBe('vertical');
    });

    it('selects the saved video preset', async (): Promise<void> => {
      (mockSettings['videoAdjustmentsPreset'] as WritableSignal<string>).set('noir');
      await fixture.whenStable();

      expect(select('Video preset')!.value).toBe('noir');
    });

    it('switches video adjustments on when a preset is chosen while they are off', (): void => {
      choose('Video preset', 'vivid');

      expect(mockSettings['setVideoAdjustmentsEnabled']).toHaveBeenCalledExactlyOnceWith(true);
      expect(mockSettings['setVideoAdjustmentPreset']).toHaveBeenCalledExactlyOnceWith('vivid');
    });

    it('only changes the preset when video adjustments are already on', (): void => {
      (mockSettings['videoAdjustmentsEnabled'] as WritableSignal<boolean>).set(true);

      choose('Video preset', 'vivid');

      expect(mockSettings['setVideoAdjustmentsEnabled']).not.toHaveBeenCalled();
      expect(mockSettings['setVideoAdjustmentPreset']).toHaveBeenCalledExactlyOnceWith('vivid');
    });

    describe('subtitles', (): void => {
      beforeEach(async (): Promise<void> => {
        videoOutlet().subtitleTracks.set([
          createSubtitleTrack(0, 'English'),
          createSubtitleTrack(1, 'English', true),
          createSubtitleTrack(2, 'Deutsch'),
        ]);
        await fixture.whenStable();
      });

      it('offers off, every embedded track and loading an external file', (): void => {
        expect(optionLabels('Subtitles')).toEqual(['Subtitles Off', 'English', 'English (Forced)', 'Deutsch', 'Load External...']);
      });

      it('offers only off and loading an external file when the video has no tracks', async (): Promise<void> => {
        videoOutlet().subtitleTracks.set([]);
        await fixture.whenStable();

        expect(optionLabels('Subtitles')).toEqual(['Subtitles Off', 'Load External...']);
      });

      it('adds an external file entry once one has been loaded', async (): Promise<void> => {
        videoOutlet().hasExternalSubtitle.set(true);
        await fixture.whenStable();

        expect(optionLabels('Subtitles')).toEqual(['Subtitles Off', 'English', 'English (Forced)', 'Deutsch', 'External File', 'Load External...']);
      });

      it('selects off while no track is active', (): void => {
        expect(select('Subtitles')!.value).toBe('-1');
      });

      it('selects the track the video outlet has active', async (): Promise<void> => {
        videoOutlet().selectedSubtitleTrack.set(2);
        await fixture.whenStable();

        expect(select('Subtitles')!.value).toBe('2');
      });

      it('selects the external file entry while an external file is active', async (): Promise<void> => {
        videoOutlet().hasExternalSubtitle.set(true);
        videoOutlet().selectedSubtitleTrack.set(-2);
        await fixture.whenStable();

        expect(select('Subtitles')!.value).toBe('-2');
      });

      it('asks the video outlet for the chosen track', (): void => {
        choose('Subtitles', '2');

        expect(videoOutlet().selectSubtitleTrack).toHaveBeenCalledExactlyOnceWith(2);
      });

      it('asks the video outlet to turn subtitles off', async (): Promise<void> => {
        videoOutlet().selectedSubtitleTrack.set(1);
        await fixture.whenStable();

        choose('Subtitles', '-1');

        expect(videoOutlet().selectSubtitleTrack).toHaveBeenCalledExactlyOnceWith(-1);
      });

      it('opens the external subtitle picker without selecting a track', (): void => {
        choose('Subtitles', '-3');

        expect(videoOutlet().loadExternalSubtitle).toHaveBeenCalledTimes(1);
        expect(videoOutlet().selectSubtitleTrack).not.toHaveBeenCalled();
      });

      it('returns the dropdown to the active track after opening the picker', async (): Promise<void> => {
        videoOutlet().selectedSubtitleTrack.set(2);
        await fixture.whenStable();

        choose('Subtitles', '-3');

        expect(select('Subtitles')!.value).toBe('2');
      });
    });

    describe('audio tracks', (): void => {
      it('offers no audio track dropdown for a single track', async (): Promise<void> => {
        videoOutlet().audioTracks.set([createAudioTrack(0, 'English')]);
        await fixture.whenStable();

        expect(select('Audio track')).toBeNull();
      });

      it('offers an audio track dropdown when there is a choice', async (): Promise<void> => {
        videoOutlet().audioTracks.set([createAudioTrack(0, 'English'), createAudioTrack(1, 'Japanese')]);
        await fixture.whenStable();

        expect(optionLabels('Audio track')).toEqual(['English', 'Japanese']);
      });

      it('labels surround and unusual channel layouts', async (): Promise<void> => {
        videoOutlet().audioTracks.set([
          createAudioTrack(0, 'Stereo', 2),
          createAudioTrack(1, 'Surround', 6),
          createAudioTrack(2, 'Atmos bed', 8),
          createAudioTrack(3, 'Quad', 4),
          createAudioTrack(4, 'Mono', 1),
        ]);
        await fixture.whenStable();

        expect(optionLabels('Audio track')).toEqual(['Stereo', 'Surround (5.1)', 'Atmos bed (7.1)', 'Quad (4ch)', 'Mono']);
      });

      it('selects the track the video outlet has active', async (): Promise<void> => {
        videoOutlet().audioTracks.set([createAudioTrack(0, 'English'), createAudioTrack(1, 'Japanese')]);
        videoOutlet().selectedAudioTrack.set(1);
        await fixture.whenStable();

        expect(select('Audio track')!.value).toBe('1');
      });

      it('asks the video outlet for the chosen track', async (): Promise<void> => {
        videoOutlet().audioTracks.set([createAudioTrack(0, 'English'), createAudioTrack(1, 'Japanese')]);
        await fixture.whenStable();

        choose('Audio track', '1');

        expect(videoOutlet().selectAudioTrack).toHaveBeenCalledExactlyOnceWith(1);
      });
    });
  });

  // ==========================================================================
  // Without an outlet
  // ==========================================================================

  describe('track queries without a video outlet', (): void => {
    it('reports no subtitle tracks', (): void => {
      expect(component.getSubtitleTracks()).toEqual([]);
    });

    it('reports subtitles as off', (): void => {
      expect(component.getSelectedSubtitleTrack()).toBe(-1);
    });

    it('reports no external subtitle', (): void => {
      expect(component.hasExternalSubtitle()).toBe(false);
    });

    it('reports no audio tracks', (): void => {
      expect(component.getAudioTracks()).toEqual([]);
    });

    it('reports the first audio track as selected', (): void => {
      expect(component.getSelectedAudioTrack()).toBe(0);
    });

    it('resets a subtitle dropdown to off when the picker is requested', (): void => {
      const element: HTMLSelectElement = document.createElement('select');
      element.innerHTML = '<option value="-1">Off</option><option value="-3">Load</option>';
      element.value = '-3';
      const event: Event = new Event('change');
      Object.defineProperty(event, 'target', {value: element});

      component.onSubtitleTrackChange(event);

      expect(element.value).toBe('-1');
    });
  });

  describe('change events that do not come from a dropdown', (): void => {
    const handlers: {name: string; handle: (target: LayoutOutlet, event: Event) => void}[] = [
      {name: 'onVisualizationChange', handle: (target: LayoutOutlet, event: Event): void => target.onVisualizationChange(event)},
      {name: 'onAspectModeChange', handle: (target: LayoutOutlet, event: Event): void => target.onAspectModeChange(event)},
      {name: 'onFlipModeChange', handle: (target: LayoutOutlet, event: Event): void => target.onFlipModeChange(event)},
      {name: 'onSubtitleTrackChange', handle: (target: LayoutOutlet, event: Event): void => target.onSubtitleTrackChange(event)},
      {name: 'onAudioTrackChange', handle: (target: LayoutOutlet, event: Event): void => target.onAudioTrackChange(event)},
    ];

    it.each(handlers)('$name sends nothing to the video outlet', async (testCase: {name: string; handle: (target: LayoutOutlet, event: Event) => void}): Promise<void> => {
      await loadMedia('video');
      const outlet: StubVideoOutlet = videoOutlet();

      testCase.handle(component, new Event('change'));

      expect(outlet.setAspectMode).not.toHaveBeenCalled();
      expect(outlet.setFlipMode).not.toHaveBeenCalled();
      expect(outlet.selectSubtitleTrack).not.toHaveBeenCalled();
      expect(outlet.loadExternalSubtitle).not.toHaveBeenCalled();
      expect(outlet.selectAudioTrack).not.toHaveBeenCalled();
    });

    it('onVisualizationChange sends nothing to the audio outlet', async (): Promise<void> => {
      await loadMedia('audio');

      component.onVisualizationChange(new Event('change'));

      expect(audioOutlet().setVisualization).not.toHaveBeenCalled();
    });

    it('onEqualizerPresetChange saves nothing', (): void => {
      component.onEqualizerPresetChange(new Event('change'));

      expect(mockSettings['setEqualizerEnabled']).not.toHaveBeenCalled();
      expect(mockSettings['setEqualizerPreset']).not.toHaveBeenCalled();
    });

    it('onVideoPresetChange saves nothing', (): void => {
      component.onVideoPresetChange(new Event('change'));

      expect(mockSettings['setVideoAdjustmentsEnabled']).not.toHaveBeenCalled();
      expect(mockSettings['setVideoAdjustmentPreset']).not.toHaveBeenCalled();
    });
  });
});
