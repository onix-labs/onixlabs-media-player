/**
 * @fileoverview Setup wizard component for first-run configuration.
 *
 * This wizard guides users through initial application setup including:
 * 1. Welcome - Introduction to ONIXPlayer
 * 2. Server Port - Configure the media server port
 * 3. Dependencies - Install FFmpeg and FluidSynth
 * 4. Complete - Summary and finish
 *
 * The wizard appears on first launch or when launched with --first-run flag.
 *
 * @module app/components/setup-wizard
 */

import {Component, inject, signal, computed, ChangeDetectionStrategy, WritableSignal, Signal} from '@angular/core';
import {ElectronService} from '../../services/electron.service';
import {DependencyService, DependencyId} from '../../services/dependency.service';
import type {MediaPlayerAPI} from '../../types/electron';

/** Wizard step identifiers */
type WizardStep = 'welcome' | 'port' | 'dependencies' | 'complete';

/**
 * Setup wizard component for first-run configuration.
 *
 * Displays a multi-step wizard that guides users through initial setup.
 * The wizard is displayed in a separate window and must be completed
 * before the main application window is shown.
 */
@Component({
  selector: 'app-setup-wizard',
  templateUrl: './setup-wizard.html',
  styleUrl: './setup-wizard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupWizard {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Service for Electron-specific operations */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Service for dependency state */
  public readonly deps: DependencyService = inject(DependencyService);

  // ============================================================================
  // Wizard State
  // ============================================================================

  /** Current wizard step */
  public readonly currentStep: WritableSignal<WizardStep> = signal<WizardStep>('welcome');

  /** All wizard steps in order */
  public readonly steps: readonly WizardStep[] = ['welcome', 'port', 'dependencies', 'complete'];

  /** Server port value */
  public readonly serverPort: WritableSignal<number> = signal<number>(0);

  /** Port validation state */
  public readonly portValid: WritableSignal<boolean> = signal<boolean>(true);

  /** Port validation message */
  public readonly portValidationMessage: WritableSignal<string> = signal<string>('');

  /** Whether port is being validated */
  public readonly validatingPort: WritableSignal<boolean> = signal<boolean>(false);

  // ============================================================================
  // Computed Properties
  // ============================================================================

  /** Current step index */
  public get currentStepIndex(): number {
    return this.steps.indexOf(this.currentStep());
  }

  /** Whether we're on the first step */
  public get isFirstStep(): boolean {
    return this.currentStepIndex === 0;
  }

  /** Whether we're on the last step */
  public get isLastStep(): boolean {
    return this.currentStepIndex === this.steps.length - 1;
  }

  /** Platform info for conditional rendering */
  public get platform(): string {
    return this.electron.platformInfo().platform;
  }

  /** FFmpeg status from dependency service */
  public readonly ffmpegStatus: Signal<{installed: boolean; path: string | null}> = computed((): {installed: boolean; path: string | null} => {
    const state: ReturnType<typeof this.deps.dependencyState> = this.deps.dependencyState();
    return state ? {installed: state.ffmpeg.installed, path: state.ffmpeg.path} : {installed: false, path: null};
  });

  /** FluidSynth status from dependency service */
  public readonly fluidsynthStatus: Signal<{installed: boolean; path: string | null}> = computed((): {installed: boolean; path: string | null} => {
    const state: ReturnType<typeof this.deps.dependencyState> = this.deps.dependencyState();
    return state ? {installed: state.fluidsynth.installed, path: state.fluidsynth.path} : {installed: false, path: null};
  });

  /** Whether a dependency operation is in progress */
  public readonly isOperationInProgress: Signal<boolean> = computed((): boolean => {
    const progress: ReturnType<typeof this.deps.installProgress> = this.deps.installProgress();
    return progress !== null && (progress.status === 'installing' || progress.status === 'uninstalling');
  });

  /** Current install progress */
  public readonly installProgress: typeof this.deps.installProgress = this.deps.installProgress;

  /** SoundFonts from dependency service */
  public readonly soundFonts: typeof this.deps.soundFonts = this.deps.soundFonts;

  // ============================================================================
  // Constructor
  // ============================================================================

  public constructor() {
    // Load initial port value
    void this.loadInitialPort();
  }

  /**
   * Loads the initial server port value from settings.
   */
  private async loadInitialPort(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      const port: number = await api.setupGetPort();
      this.serverPort.set(port);
    }
  }

  // ============================================================================
  // Navigation Methods
  // ============================================================================

  /**
   * Moves to the next wizard step.
   */
  public async next(): Promise<void> {
    const currentIndex: number = this.currentStepIndex;
    if (currentIndex < this.steps.length - 1) {
      // Handle step-specific actions before moving
      if (this.currentStep() === 'port') {
        await this.savePort();
      }
      this.currentStep.set(this.steps[currentIndex + 1]);
    }
  }

  /**
   * Moves to the previous wizard step.
   */
  public back(): void {
    const currentIndex: number = this.currentStepIndex;
    if (currentIndex > 0) {
      this.currentStep.set(this.steps[currentIndex - 1]);
    }
  }

  /**
   * Skips the wizard and closes without completing.
   */
  public async skip(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      await api.setupSkip();
    }
  }

  /**
   * Completes the wizard and closes.
   */
  public async finish(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      await api.setupComplete();
    }
  }

  // ============================================================================
  // Port Configuration
  // ============================================================================

  /**
   * Handles port input changes.
   */
  public async onPortChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseInt(input.value, 10);
    this.serverPort.set(isNaN(value) ? 0 : value);
    await this.validatePort();
  }

  /**
   * Sets port to auto-assign (0).
   */
  public async setAutoPort(): Promise<void> {
    this.serverPort.set(0);
    this.portValid.set(true);
    this.portValidationMessage.set('');
  }

  /**
   * Validates the current port value.
   */
  private async validatePort(): Promise<void> {
    const port: number = this.serverPort();
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;

    if (!api) {
      this.portValid.set(false);
      this.portValidationMessage.set('API not available');
      return;
    }

    // 0 is always valid (auto-assign)
    if (port === 0) {
      this.portValid.set(true);
      this.portValidationMessage.set('');
      return;
    }

    // Check range
    if (port < 1024 || port > 65535) {
      this.portValid.set(false);
      this.portValidationMessage.set('Port must be between 1024 and 65535');
      return;
    }

    // Check availability
    this.validatingPort.set(true);
    try {
      const available: boolean = await api.setupValidatePort(port);
      this.portValid.set(available);
      this.portValidationMessage.set(available ? '' : 'Port is already in use');
    } finally {
      this.validatingPort.set(false);
    }
  }

  /**
   * Saves the port setting.
   */
  private async savePort(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api && this.portValid()) {
      await api.setupSetPort(this.serverPort());
    }
  }

  // ============================================================================
  // Step Completion Status
  // ============================================================================

  /**
   * Checks if a step is completed.
   */
  public isStepCompleted(step: WizardStep): boolean {
    const stepIndex: number = this.steps.indexOf(step);
    return stepIndex < this.currentStepIndex;
  }

  /**
   * Checks if a step is the current step.
   */
  public isCurrentStep(step: WizardStep): boolean {
    return step === this.currentStep();
  }

  // ============================================================================
  // Dependency Installation
  // ============================================================================

  /**
   * Installs a dependency (FFmpeg or FluidSynth).
   */
  public async installDependency(id: DependencyId): Promise<void> {
    await this.deps.installDependency(id);
  }

  /**
   * Opens a URL in the system default browser.
   */
  public openExternalUrl(url: string): void {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      void api.openExternal(url);
    }
  }

  /**
   * Opens a SoundFont file picker and installs the selected file.
   */
  public async installSoundFont(): Promise<void> {
    await this.deps.installSoundFont();
  }

  /**
   * Removes an installed SoundFont file.
   */
  public async removeSoundFont(fileName: string): Promise<void> {
    await this.deps.removeSoundFont(fileName);
  }

  /**
   * Installs the bundled OPL3 SoundFont.
   */
  public async installBundledSoundFont(): Promise<void> {
    const api: MediaPlayerAPI | undefined = window.mediaPlayer;
    if (api) {
      const success: boolean = await api.setupInstallBundledSoundFont();
      if (!success) {
        console.error('Failed to install bundled soundfont');
      }
    }
  }

  /**
   * Gets the manual install command for a dependency based on platform.
   */
  public getManualInstallCommand(id: DependencyId): string {
    const platform: string = this.platform;
    if (id === 'ffmpeg') {
      switch (platform) {
        case 'darwin': return 'brew install ffmpeg';
        case 'win32': return 'winget install Gyan.FFmpeg';
        default: return 'sudo apt install ffmpeg';
      }
    } else {
      switch (platform) {
        case 'darwin': return 'brew install fluid-synth';
        case 'win32': return 'choco install fluidsynth';
        default: return 'sudo apt install fluidsynth';
      }
    }
  }

  /**
   * Formats file size in human-readable format.
   */
  public formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
