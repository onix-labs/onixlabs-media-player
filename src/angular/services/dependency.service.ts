/**
 * @fileoverview Angular service for managing external dependency state.
 *
 * This service provides reactive state for the dependency management UI,
 * including binary detection status, install/uninstall progress, and
 * SoundFont file management.
 *
 * State is synchronized via SSE events from the unified media server.
 * Commands (install, uninstall, etc.) are sent via HTTP POST requests.
 *
 * @module app/services/dependency.service
 */

import {Injectable, signal, computed, inject, effect, OnDestroy, EffectRef} from '@angular/core';
import {ElectronService} from './electron.service';
import {MEDIA_EXTENSIONS, FFMPEG_EXTENSIONS, MIDI_EXTENSIONS} from '../constants/media.constants';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifier for a managed dependency.
 */
export type DependencyId = 'ffmpeg' | 'fluidsynth';

/**
 * Status of a single dependency.
 */
export interface DependencyStatus {
  readonly id: DependencyId;
  readonly name: string;
  readonly installed: boolean;
  readonly path: string | null;
  readonly description: string;
  readonly manualInstallUrl: string;
}

/**
 * Overall dependency state received from the server.
 */
export interface DependencyState {
  readonly ffmpeg: DependencyStatus;
  readonly fluidsynth: DependencyStatus;
  readonly soundfonts: SoundFontInfo[];
  readonly activeSoundFont: string | null;
  readonly hardwareEncoders: HardwareEncoderInfo;
}

/**
 * Information about an installed SoundFont file.
 */
export interface SoundFontInfo {
  readonly fileName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
}

/**
 * Information about available hardware encoders.
 */
export interface HardwareEncoderInfo {
  readonly available: boolean;
  readonly encoders: readonly string[];
}

/**
 * Progress update during dependency installation or uninstallation.
 */
export interface InstallProgress {
  readonly dependencyId: DependencyId;
  readonly status: 'installing' | 'uninstalling' | 'success' | 'error';
  readonly message: string;
  readonly output?: string;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Service that manages external dependency state and installation.
 *
 * Provides reactive signals for:
 * - FFmpeg and FluidSynth installation status
 * - Install/uninstall progress with terminal output
 * - SoundFont file management
 *
 * @example
 * export class MyComponent {
 *   private deps = inject(DependencyService);
 *   hasMissing = this.deps.hasMissingDependencies;
 * }
 */
@Injectable({providedIn: 'root'})
export class DependencyService implements OnDestroy {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Electron service for server URL and IPC access */
  private readonly electron: ElectronService = inject(ElectronService);

  // ============================================================================
  // Public Signals
  // ============================================================================

  /** Full dependency state (updated via SSE) */
  public readonly dependencyState: ReturnType<typeof signal<DependencyState | null>> = signal<DependencyState | null>(null);

  /** Install/uninstall progress (updated via SSE) */
  public readonly installProgress: ReturnType<typeof signal<InstallProgress | null>> = signal<InstallProgress | null>(null);

  /** Whether state has been loaded from the server */
  public readonly isLoaded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Effect reference for cleanup */
  private readonly serverUrlEffect: EffectRef;

  // ============================================================================
  // Computed Signals
  // ============================================================================

  /** Whether FFmpeg is installed */
  public readonly ffmpegInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyState()?.ffmpeg.installed ?? false
  );

  /** Whether FluidSynth is installed */
  public readonly fluidsynthInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyState()?.fluidsynth.installed ?? false
  );

  /** Whether all dependencies are installed */
  public readonly allDependenciesInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.ffmpegInstalled() && this.fluidsynthInstalled()
  );

  /** Whether any dependencies are missing */
  public readonly hasMissingDependencies: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.isLoaded() && !this.allDependenciesInstalled()
  );

  /** List of missing dependencies */
  public readonly missingDependencies: ReturnType<typeof computed<DependencyStatus[]>> = computed(
    (): DependencyStatus[] => {
      const state: DependencyState | null = this.dependencyState();
      if (!state) return [];
      const missing: DependencyStatus[] = [];
      if (!state.ffmpeg.installed) missing.push(state.ffmpeg);
      if (!state.fluidsynth.installed) missing.push(state.fluidsynth);
      return missing;
    }
  );

  /** Installed SoundFont files */
  public readonly soundFonts: ReturnType<typeof computed<SoundFontInfo[]>> = computed(
    (): SoundFontInfo[] => this.dependencyState()?.soundfonts ?? []
  );

  /** Active SoundFont path */
  public readonly activeSoundFont: ReturnType<typeof computed<string | null>> = computed(
    (): string | null => this.dependencyState()?.activeSoundFont ?? null
  );

  /** Available hardware encoders */
  public readonly hardwareEncoders: ReturnType<typeof computed<HardwareEncoderInfo>> = computed(
    (): HardwareEncoderInfo => this.dependencyState()?.hardwareEncoders ?? {available: false, encoders: []}
  );

  /** Whether at least one dependency is installed */
  public readonly anyDependencyInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.ffmpegInstalled() || this.fluidsynthInstalled()
  );

  /** Whether zero dependencies are installed (only true after state is loaded) */
  public readonly noDependenciesInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.isLoaded() && !this.anyDependencyInstalled()
  );

  /** Dynamic set of allowed file extensions based on installed dependencies */
  public readonly allowedExtensions: ReturnType<typeof computed<ReadonlySet<string>>> = computed(
    (): ReadonlySet<string> => {
      const ffmpeg: boolean = this.ffmpegInstalled();
      const fluidsynth: boolean = this.fluidsynthInstalled();
      if (ffmpeg && fluidsynth) return MEDIA_EXTENSIONS;
      if (ffmpeg) return FFMPEG_EXTENSIONS;
      if (fluidsynth) return MIDI_EXTENSIONS;
      return new Set();
    }
  );

  /** Whether an install/uninstall operation is in progress */
  public readonly isOperationInProgress: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => {
      const progress: InstallProgress | null = this.installProgress();
      return progress !== null && (progress.status === 'installing' || progress.status === 'uninstalling');
    }
  );

  // ============================================================================
  // Constructor
  // ============================================================================

  public constructor() {
    // Register SSE callbacks with ElectronService
    this.electron.onDependencyStateUpdate((state: unknown): void => {
      this.dependencyState.set(state as DependencyState);
      this.isLoaded.set(true);
    });

    this.electron.onDependencyProgressUpdate((progress: unknown): void => {
      this.installProgress.set(progress as InstallProgress);
    });

    // Fetch dependency state once serverUrl is available
    this.serverUrlEffect = effect((): void => {
      const serverUrl: string = this.electron.serverUrl();
      if (serverUrl && !this.isLoaded()) {
        void this.fetchDependencyState();
      }
    });
  }

  public ngOnDestroy(): void {
    this.serverUrlEffect.destroy();
  }

  // ============================================================================
  // Commands
  // ============================================================================

  /**
   * Installs a dependency using the platform package manager.
   * Progress is streamed via SSE events.
   */
  public async installDependency(id: DependencyId): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clear any previous progress
    this.installProgress.set(null);

    await fetch(`${serverUrl}/dependencies/install`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    });
  }

  /**
   * Uninstalls a dependency using the platform package manager.
   * Progress is streamed via SSE events.
   */
  public async uninstallDependency(id: DependencyId): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clear any previous progress
    this.installProgress.set(null);

    await fetch(`${serverUrl}/dependencies/uninstall`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    });
  }

  /**
   * Opens the SoundFont file dialog and installs the selected file.
   */
  public async installSoundFont(): Promise<void> {
    const filePaths: string[] = await this.electron.openSoundFontDialog();
    if (filePaths.length === 0) return;

    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    await fetch(`${serverUrl}/dependencies/soundfont/install`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sourcePath: filePaths[0]}),
    });
  }

  /**
   * Removes a SoundFont file from the app data directory.
   */
  public async removeSoundFont(fileName: string): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    await fetch(`${serverUrl}/dependencies/soundfont/remove`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({fileName}),
    });
  }

  /**
   * Sets the active SoundFont for MIDI playback.
   * Pass null to reset to auto-selection (first available).
   */
  public async setActiveSoundFont(fileName: string | null): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    await fetch(`${serverUrl}/dependencies/soundfont/select`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({fileName}),
    });
  }

  /**
   * Re-detects all binaries and refreshes the dependency state.
   */
  public async refreshDependencies(): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    await fetch(`${serverUrl}/dependencies/refresh`, {
      method: 'POST',
    });
  }

  // ============================================================================
  // Private
  // ============================================================================

  /**
   * Fetches the initial dependency state from the server.
   */
  private async fetchDependencyState(): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    try {
      const response: Response = await fetch(`${serverUrl}/dependencies`);
      if (response.ok) {
        const state: DependencyState = await response.json() as DependencyState;
        this.dependencyState.set(state);
        this.isLoaded.set(true);
      }
    } catch {
      // Will be retried on next SSE event or serverUrl change
    }
  }
}
