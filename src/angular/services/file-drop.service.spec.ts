/**
 * @fileoverview Unit tests for FileDropService.
 *
 * Tests the extractMediaFilePaths method with various DragEvent
 * scenarios, including supported and unsupported files, missing
 * dataTransfer, and path extraction errors.
 *
 * @module app/services/file-drop.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {FileDropService} from './file-drop.service';
import {ElectronService} from './electron.service';
import {DependencyService} from './dependency.service';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock DragEvent with the given files.
 *
 * Since DragEvent is a browser API unavailable in the test
 * environment, this constructs a minimal structural stand-in
 * with a FileList-like object on dataTransfer.
 *
 * @param files - Array of File objects to attach
 * @returns A DragEvent-shaped object for testing
 */
function createDragEvent(files: File[]): DragEvent {
  const fileList: FileList = {length: files.length} as FileList;
  files.forEach((f: File, i: number): void => {
    (fileList as Record<number, File>)[i] = f;
  });
  return {dataTransfer: {files: fileList}} as unknown as DragEvent;
}

/**
 * Creates a mock DragEvent as seen during dragover, where the browser hides
 * the file list and exposes only the kinds of the dragged items.
 *
 * @param kinds - The `kind` of each dragged item ('file' or 'string')
 * @returns A DragEvent-shaped object for testing
 */
function createDragOverEvent(kinds: string[]): DragEvent {
  const items: Record<number, {kind: string}> & {length: number} = {length: kinds.length};
  kinds.forEach((kind: string, i: number): void => {
    items[i] = {kind};
  });
  return {dataTransfer: {files: {length: 0}, items}} as unknown as DragEvent;
}

/**
 * Creates a minimal File object with only a name property.
 *
 * @param name - The file name including extension
 * @returns A File object suitable for drag-and-drop testing
 */
function createFile(name: string): File {
  return new File([], name);
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock ElectronService with a controllable getPathForFile stub.
 */
function createMockElectronService(): {
  getPathForFile: ReturnType<typeof vi.fn>;
} {
  return {
    getPathForFile: vi.fn((file: File): string => `/mock/path/${file.name}`),
  };
}

/**
 * Creates a mock DependencyService with a writable allowedExtensions signal.
 */
function createMockDependencyService(): {
  allowedExtensions: ReturnType<typeof signal<Set<string>>>;
} {
  return {
    allowedExtensions: signal(new Set<string>(['.mp3', '.mp4', '.wav'])),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('FileDropService', (): void => {
  let service: FileDropService;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;

  beforeEach((): void => {
    mockElectron = createMockElectronService();
    mockDeps = createMockDependencyService();

    TestBed.configureTestingModule({
      providers: [
        FileDropService,
        {provide: ElectronService, useValue: mockElectron},
        {provide: DependencyService, useValue: mockDeps},
      ],
    });

    service = TestBed.inject(FileDropService);
  });

  // ==========================================================================
  // extractMediaFilePaths
  // ==========================================================================

  describe('extractMediaFilePaths', (): void => {
    it('extracts paths for supported media files', (): void => {
      const files: File[] = [
        createFile('song.mp3'),
        createFile('video.mp4'),
        createFile('audio.wav'),
      ];
      const event: DragEvent = createDragEvent(files);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual([
        '/mock/path/song.mp3',
        '/mock/path/video.mp4',
        '/mock/path/audio.wav',
      ]);
      expect(mockElectron.getPathForFile).toHaveBeenCalledTimes(3);
    });

    it('filters out unsupported file types', (): void => {
      const files: File[] = [
        createFile('song.mp3'),
        createFile('readme.txt'),
        createFile('image.png'),
        createFile('video.mp4'),
      ];
      const event: DragEvent = createDragEvent(files);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual([
        '/mock/path/song.mp3',
        '/mock/path/video.mp4',
      ]);
      expect(mockElectron.getPathForFile).toHaveBeenCalledTimes(2);
    });

    it('returns empty array when dataTransfer is null', (): void => {
      const event: DragEvent = {dataTransfer: null} as unknown as DragEvent;

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual([]);
      expect(mockElectron.getPathForFile).not.toHaveBeenCalled();
    });

    it('returns empty array when no files', (): void => {
      const event: DragEvent = createDragEvent([]);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual([]);
      expect(mockElectron.getPathForFile).not.toHaveBeenCalled();
    });

    it('handles getPathForFile errors gracefully', (): void => {
      mockElectron.getPathForFile
        .mockImplementationOnce((): string => '/mock/path/good.mp3')
        .mockImplementationOnce((): never => {
          throw new Error('Electron path resolution failed');
        })
        .mockImplementationOnce((): string => '/mock/path/also-good.wav');

      const files: File[] = [
        createFile('good.mp3'),
        createFile('bad.mp4'),
        createFile('also-good.wav'),
      ];
      const event: DragEvent = createDragEvent(files);

      const consoleSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual([
        '/mock/path/good.mp3',
        '/mock/path/also-good.wav',
      ]);
      expect(consoleSpy).toHaveBeenCalledOnce();

      consoleSpy.mockRestore();
    });

    it('returns empty array when no extensions are allowed', (): void => {
      mockDeps.allowedExtensions.set(new Set<string>());

      const files: File[] = [
        createFile('song.mp3'),
        createFile('video.mp4'),
      ];
      const event: DragEvent = createDragEvent(files);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual([]);
      expect(mockElectron.getPathForFile).not.toHaveBeenCalled();
    });

    it('matches extensions without regard to case', (): void => {
      const event: DragEvent = createDragEvent([createFile('SONG.MP3')]);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual(['/mock/path/SONG.MP3']);
    });

    it('judges a file by its last extension only', (): void => {
      const event: DragEvent = createDragEvent([createFile('song.mp3.txt'), createFile('notes.txt.mp3')]);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual(['/mock/path/notes.txt.mp3']);
    });

    it('leaves out a file whose path cannot be resolved', (): void => {
      mockElectron.getPathForFile.mockImplementation((file: File): string => (file.name === 'ghost.mp3' ? '' : `/mock/path/${file.name}`));
      const event: DragEvent = createDragEvent([createFile('ghost.mp3'), createFile('real.mp3')]);

      const result: string[] = service.extractMediaFilePaths(event);

      expect(result).toEqual(['/mock/path/real.mp3']);
    });
  });

  // ==========================================================================
  // hasValidFiles
  // ==========================================================================

  describe('hasValidFiles', (): void => {
    it('returns true when at least one listed file is a supported type', (): void => {
      const event: DragEvent = createDragEvent([createFile('readme.txt'), createFile('song.mp3')]);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(true);
    });

    it('matches listed files without regard to case', (): void => {
      const event: DragEvent = createDragEvent([createFile('VIDEO.MP4')]);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(true);
    });

    it('returns false when no listed file is a supported type', (): void => {
      const event: DragEvent = createDragEvent([createFile('readme.txt'), createFile('image.png')]);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });

    it('does not fall back to the item kinds when the listed files are all unsupported', (): void => {
      const event: DragEvent = {
        dataTransfer: {files: {length: 1, 0: createFile('readme.txt')}, items: {length: 1, 0: {kind: 'file'}}},
      } as unknown as DragEvent;

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });

    it('returns false when nothing can be played, even for a supported-looking file', (): void => {
      mockDeps.allowedExtensions.set(new Set<string>());
      const event: DragEvent = createDragEvent([createFile('song.mp3')]);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });

    it('returns false when nothing can be played and only item kinds are visible', (): void => {
      mockDeps.allowedExtensions.set(new Set<string>());
      const event: DragEvent = createDragOverEvent(['file']);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });

    it('assumes a dragged file is valid when the file list is hidden during dragover', (): void => {
      const event: DragEvent = createDragOverEvent(['file']);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(true);
    });

    it('finds a file among other dragged items during dragover', (): void => {
      const event: DragEvent = createDragOverEvent(['string', 'file']);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(true);
    });

    it('returns false when only text is being dragged', (): void => {
      const event: DragEvent = createDragOverEvent(['string', 'string']);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });

    it('returns false when the drag carries neither files nor items', (): void => {
      const event: DragEvent = createDragOverEvent([]);

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });

    it('returns false when the event has no dataTransfer', (): void => {
      const event: DragEvent = {dataTransfer: null} as unknown as DragEvent;

      const result: boolean = service.hasValidFiles(event);

      expect(result).toBe(false);
    });
  });
});
