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
import {signal, WritableSignal, NO_ERRORS_SCHEMA} from '@angular/core';
import {LayoutOutlet} from './layout-outlet';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {DependencyService} from '../../../services/dependency.service';
import type {DependencyStatus} from '../../../services/dependency.service';
import type {PlaylistItem, PlaylistState} from '../../../types/electron';

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

/**
 * Creates a mock DragEvent with configurable preventDefault and stopPropagation.
 *
 * @returns A DragEvent-shaped object for testing
 */
function createDragEvent(): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {files: {length: 0} as FileList},
  } as unknown as DragEvent;
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

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockFileDrop = createMockFileDropService();
    mockDeps = createMockDependencyService();

    await TestBed.configureTestingModule({
      imports: [LayoutOutlet],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: FileDropService, useValue: mockFileDrop},
        {provide: DependencyService, useValue: mockDeps},
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
        description: 'FFmpeg dependency',
        manualInstallUrl: 'https://example.com/ffmpeg',
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
    it('isDragOver defaults to false', (): void => {
      const result: boolean = component.isDragOver();
      expect(result).toBe(false);
    });

    it('visualizationDisplayName defaults to empty string', (): void => {
      const result: string = component.visualizationDisplayName();
      expect(result).toBe('');
    });

    it('aspectModeDisplayName defaults to Default', (): void => {
      const result: string = component.aspectModeDisplayName();
      expect(result).toBe('Default');
    });
  });

  // ==========================================================================
  // Drag and Drop
  // ==========================================================================

  describe('drag and drop', (): void => {
    it('onDragOver sets isDragOver to true', (): void => {
      const event: DragEvent = createDragEvent();

      component.onDragOver(event);

      expect(component.isDragOver()).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('onDragLeave sets isDragOver to false', (): void => {
      component.isDragOver.set(true);
      const event: DragEvent = createDragEvent();

      component.onDragLeave(event);

      expect(component.isDragOver()).toBe(false);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('onDrop resets isDragOver and calls addFilesWithAutoPlay', async (): Promise<void> => {
      component.isDragOver.set(true);
      const event: DragEvent = createDragEvent();
      const filePaths: string[] = ['/music/song.mp3', '/music/video.mp4'];
      (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue(filePaths);

      await component.onDrop(event);

      expect(component.isDragOver()).toBe(false);
      expect(mockFileDrop['extractMediaFilePaths']).toHaveBeenCalledWith(event);
      expect(mockElectron['addFilesWithAutoPlay']).toHaveBeenCalledWith(filePaths);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('onDrop does nothing for empty file paths', async (): Promise<void> => {
      component.isDragOver.set(true);
      const event: DragEvent = createDragEvent();
      (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue([]);

      await component.onDrop(event);

      expect(component.isDragOver()).toBe(false);
      expect(mockElectron['addFilesWithAutoPlay']).not.toHaveBeenCalled();
    });
  });
});
