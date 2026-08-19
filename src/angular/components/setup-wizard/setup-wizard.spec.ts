/**
 * @fileoverview Tests for SetupWizard.
 *
 * The wizard is the first-run gate: if it breaks, first launch is bricked.
 * Tests cover step navigation and its boundaries, the port validation rules
 * including the 1024/65535 edges, saving only a valid port when leaving the
 * port step, completion ordering, and graceful behaviour when the preload
 * API is absent.
 *
 * @module app/components/setup-wizard.spec
 */

import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {SetupWizard} from './setup-wizard';
import {ElectronService} from '../../services/electron.service';
import {DependencyService} from '../../services/dependency.service';

// ============================================================================
// Helpers
// ============================================================================

/** The preload API surface the wizard uses. */
interface MockApi {
  setupGetPort: ReturnType<typeof vi.fn>;
  setupSetPort: ReturnType<typeof vi.fn>;
  setupValidatePort: ReturnType<typeof vi.fn>;
  setupComplete: ReturnType<typeof vi.fn>;
  setupSkip: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
}

/**
 * Creates a preload API stub and installs it on window.
 *
 * @returns The stub, so tests can assert against it
 */
function installApi(): MockApi {
  const api: MockApi = {
    setupGetPort: vi.fn().mockResolvedValue(0),
    setupSetPort: vi.fn().mockResolvedValue(undefined),
    setupValidatePort: vi.fn().mockResolvedValue(true),
    setupComplete: vi.fn().mockResolvedValue(undefined),
    setupSkip: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as {mediaPlayer: MockApi | undefined}).mediaPlayer = api;
  return api;
}

/** Removes the preload API from window. */
function removeApi(): void {
  (window as unknown as {mediaPlayer: MockApi | undefined}).mediaPlayer = undefined;
}

/** Creates a DependencyService stub covering what the wizard reads. */
function createMockDeps(): Record<string, unknown> {
  return {
    dependencyState: signal(null),
    installProgress: signal(null),
    soundFonts: signal([]),
    isOperationInProgress: signal(false),
    ffmpegInstalled: signal(false),
    fluidsynthInstalled: signal(false),
    openmpt123Installed: signal(false),
    ytdlpInstalled: signal(false),
    installDependency: vi.fn().mockResolvedValue(undefined),
    installSoundFont: vi.fn().mockResolvedValue(undefined),
    removeSoundFont: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Builds an input event carrying a port value.
 *
 * @param value - The raw input value
 * @returns An Event whose target has that value
 */
function portEvent(value: string): Event {
  return {target: {value}} as unknown as Event;
}

// ============================================================================
// Tests
// ============================================================================

describe('SetupWizard', (): void => {
  let component: SetupWizard;
  let api: MockApi;

  beforeEach((): void => {
    api = installApi();

    TestBed.configureTestingModule({
      providers: [
        SetupWizard,
        {provide: ElectronService, useValue: {}},
        {provide: DependencyService, useValue: createMockDeps()},
      ],
    });

    component = TestBed.inject(SetupWizard);
  });

  afterEach((): void => {
    removeApi();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  describe('navigation', (): void => {
    it('starts on the welcome step', (): void => {
      expect(component.currentStep()).toBe('welcome');
      expect(component.isFirstStep).toBe(true);
    });

    it('advances one step at a time', async (): Promise<void> => {
      await component.next();

      expect(component.currentStep()).toBe('port');
    });

    it('goes back one step at a time', async (): Promise<void> => {
      await component.next();

      component.back();

      expect(component.currentStep()).toBe('welcome');
    });

    it('is a no-op going back from the first step', (): void => {
      component.back();

      expect(component.currentStep()).toBe('welcome');
    });

    it('is a no-op going forward from the last step', async (): Promise<void> => {
      component.currentStep.set('complete');

      await component.next();

      expect(component.currentStep()).toBe('complete');
      expect(component.isLastStep).toBe(true);
    });

    it('walks the full sequence in order', async (): Promise<void> => {
      const seen: string[] = [component.currentStep()];
      for (let i: number = 0; i < component.steps.length - 1; i++) {
        await component.next();
        seen.push(component.currentStep());
      }

      expect(seen).toEqual([...component.steps]);
    });
  });

  // ==========================================================================
  // Step Completion
  // ==========================================================================

  describe('step completion', (): void => {
    it('marks earlier steps complete and later ones not', async (): Promise<void> => {
      await component.next();
      await component.next();

      expect(component.currentStep()).toBe('ffmpeg');
      expect(component.isStepCompleted('welcome')).toBe(true);
      expect(component.isStepCompleted('port')).toBe(true);
      expect(component.isStepCompleted('ffmpeg')).toBe(false);
      expect(component.isStepCompleted('complete')).toBe(false);
    });

    it('never marks the current step complete', (): void => {
      expect(component.isStepCompleted('welcome')).toBe(false);
      expect(component.isCurrentStep('welcome')).toBe(true);
    });
  });

  // ==========================================================================
  // Port Validation
  // ==========================================================================

  describe('port validation', (): void => {
    it('treats 0 as valid auto-assign without asking the main process', async (): Promise<void> => {
      await component.onPortChange(portEvent('0'));

      expect(component.portValid()).toBe(true);
      expect(component.portValidationMessage()).toBe('');
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('rejects a privileged port', async (): Promise<void> => {
      await component.onPortChange(portEvent('1023'));

      expect(component.portValid()).toBe(false);
      expect(component.portValidationMessage()).toBe('Port must be between 1024 and 65535');
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('accepts the lower bound', async (): Promise<void> => {
      await component.onPortChange(portEvent('1024'));

      expect(component.portValid()).toBe(true);
      expect(api.setupValidatePort).toHaveBeenCalledWith(1024);
    });

    it('accepts the upper bound', async (): Promise<void> => {
      await component.onPortChange(portEvent('65535'));

      expect(component.portValid()).toBe(true);
      expect(api.setupValidatePort).toHaveBeenCalledWith(65535);
    });

    it('rejects above the upper bound', async (): Promise<void> => {
      await component.onPortChange(portEvent('65536'));

      expect(component.portValid()).toBe(false);
      expect(api.setupValidatePort).not.toHaveBeenCalled();
    });

    it('rejects a negative port', async (): Promise<void> => {
      await component.onPortChange(portEvent('-1'));

      expect(component.portValid()).toBe(false);
    });

    it('treats unparseable input as auto-assign', async (): Promise<void> => {
      await component.onPortChange(portEvent('abc'));

      expect(component.serverPort()).toBe(0);
      expect(component.portValid()).toBe(true);
    });

    it('reports a port that is already in use', async (): Promise<void> => {
      api.setupValidatePort.mockResolvedValue(false);

      await component.onPortChange(portEvent('8080'));

      expect(component.portValid()).toBe(false);
      expect(component.portValidationMessage()).toBe('Port is already in use');
    });

    it('clears the validating flag afterwards', async (): Promise<void> => {
      await component.onPortChange(portEvent('8080'));

      expect(component.validatingPort()).toBe(false);
    });

    it('clears the validating flag even when the check throws', async (): Promise<void> => {
      api.setupValidatePort.mockRejectedValue(new Error('IPC down'));

      await expect(component.onPortChange(portEvent('8080'))).rejects.toThrow('IPC down');
      expect(component.validatingPort()).toBe(false);
    });

    it('resets to auto-assign', async (): Promise<void> => {
      await component.onPortChange(portEvent('1023'));

      await component.setAutoPort();

      expect(component.serverPort()).toBe(0);
      expect(component.portValid()).toBe(true);
      expect(component.portValidationMessage()).toBe('');
    });
  });

  // ==========================================================================
  // Saving the Port
  // ==========================================================================

  describe('saving the port', (): void => {
    it('saves when leaving the port step with a valid port', async (): Promise<void> => {
      component.currentStep.set('port');
      await component.onPortChange(portEvent('8080'));

      await component.next();

      expect(api.setupSetPort).toHaveBeenCalledWith(8080);
      expect(component.currentStep()).toBe('ffmpeg');
    });

    it('does not save an invalid port, but still advances', async (): Promise<void> => {
      component.currentStep.set('port');
      await component.onPortChange(portEvent('80'));

      await component.next();

      expect(api.setupSetPort).not.toHaveBeenCalled();
      expect(component.currentStep()).toBe('ffmpeg');
    });

    it('does not save when leaving any other step', async (): Promise<void> => {
      await component.next();

      expect(api.setupSetPort).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Completion
  // ==========================================================================

  describe('completion', (): void => {
    it('completes through the preload API', async (): Promise<void> => {
      await component.finish();

      expect(api.setupComplete).toHaveBeenCalled();
    });

    it('skips through the preload API', async (): Promise<void> => {
      await component.skip();

      expect(api.setupSkip).toHaveBeenCalled();
    });

    it('opens external URLs through the preload API', (): void => {
      component.openExternalUrl('https://example.com');

      expect(api.openExternal).toHaveBeenCalledWith('https://example.com');
    });
  });

  // ==========================================================================
  // Missing Preload API
  // ==========================================================================

  describe('without the preload API', (): void => {
    beforeEach((): void => {
      removeApi();
    });

    it('reports the API as unavailable rather than throwing', async (): Promise<void> => {
      await component.onPortChange(portEvent('8080'));

      expect(component.portValid()).toBe(false);
      expect(component.portValidationMessage()).toBe('API not available');
    });

    it('finishes without throwing', async (): Promise<void> => {
      await expect(component.finish()).resolves.toBeUndefined();
    });

    it('skips without throwing', async (): Promise<void> => {
      await expect(component.skip()).resolves.toBeUndefined();
    });

    it('still advances through steps', async (): Promise<void> => {
      component.currentStep.set('port');

      await component.next();

      expect(component.currentStep()).toBe('ffmpeg');
    });

    it('does not throw opening an external URL', (): void => {
      expect((): void => component.openExternalUrl('https://example.com')).not.toThrow();
    });
  });
});
