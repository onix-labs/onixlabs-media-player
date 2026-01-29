/**
 * @fileoverview Service for handling drag-and-drop file operations.
 *
 * This service provides a centralized implementation for extracting
 * media file paths from drag-and-drop events. It handles:
 * - Filtering for supported media extensions
 * - Converting File objects to file system paths via Electron
 * - Error handling for path extraction failures
 *
 * @module app/services/file-drop
 */

import {Injectable, inject} from '@angular/core';
import {ElectronService} from './electron.service';
import {DependencyService} from './dependency.service';

/**
 * Service for processing drag-and-drop file events.
 *
 * Provides utility methods to extract valid media file paths from
 * drag-and-drop events, filtering for supported formats and handling
 * Electron's file path resolution.
 *
 * @example
 * // In a component
 * private readonly fileDrop = inject(FileDropService);
 *
 * async onDrop(event: DragEvent): Promise<void> {
 *   const filePaths = this.fileDrop.extractMediaFilePaths(event);
 *   if (filePaths.length > 0) {
 *     await this.electron.addToPlaylist(filePaths);
 *   }
 * }
 */
@Injectable({
  providedIn: 'root'
})
export class FileDropService {
  /** Electron service for file path resolution */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Dependency service for allowed extension filtering */
  private readonly deps: DependencyService = inject(DependencyService);

  /**
   * Extracts valid media file paths from a drag-and-drop event.
   *
   * Filters the dropped files to only include supported media formats
   * (as defined by MEDIA_EXTENSIONS), and converts each File object
   * to its absolute file system path using Electron's webUtils.
   *
   * @param event - The DragEvent from a drop handler
   * @returns Array of absolute file paths for supported media files
   *
   * @example
   * const filePaths = this.fileDrop.extractMediaFilePaths(event);
   * // Returns: ['/Users/user/Music/song.mp3', '/Users/user/Videos/movie.mp4']
   */
  public extractMediaFilePaths(event: DragEvent): string[] {
    const files: FileList | undefined = event.dataTransfer?.files;
    if (!files || files.length === 0) return [];

    const filePaths: string[] = [];
    for (let i: number = 0; i < files.length; i++) {
      const file: File = files[i];
      const ext: string = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

      if (this.deps.allowedExtensions().has(ext)) {
        try {
          const filePath: string = this.electron.getPathForFile(file);
          if (filePath) {
            filePaths.push(filePath);
          }
        } catch (e) {
          console.error('Failed to get path for file:', file.name, e);
        }
      }
    }

    return filePaths;
  }

  /**
   * Checks if a drag event contains any files with valid media extensions.
   *
   * Used during dragover to provide visual feedback before the drop occurs.
   * Returns true if at least one valid media file is being dragged, false otherwise.
   *
   * NOTE: During dragover, browsers often restrict access to file details for security.
   * When dataTransfer.files is empty but items exist, we assume files are valid
   * since we can't check extensions. The actual filtering happens in extractMediaFilePaths.
   *
   * @param event - The DragEvent from a dragover handler
   * @returns True if the drag contains at least one valid media file, false if invalid or unknown
   */
  public hasValidFiles(event: DragEvent): boolean {
    const files: FileList | undefined = event.dataTransfer?.files;
    const allowedExtensions: ReadonlySet<string> = this.deps.allowedExtensions();

    // If no dependencies installed, nothing is valid
    if (allowedExtensions.size === 0) {
      return false;
    }

    // If we have access to the files list (during drop), check extensions
    if (files && files.length > 0) {
      for (let i: number = 0; i < files.length; i++) {
        const file: File = files[i];
        const ext: string = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (allowedExtensions.has(ext)) {
          return true; // At least one valid file
        }
      }
      return false; // No valid files found
    }

    // During dragover, files list is often empty (browser security restriction).
    // Check dataTransfer.items to see if files are being dragged.
    const items: DataTransferItemList | undefined = event.dataTransfer?.items;
    if (items && items.length > 0) {
      for (let i: number = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          // We know it's a file but can't check the extension during dragover.
          // Assume valid and let extractMediaFilePaths filter on drop.
          return true;
        }
      }
    }

    return false;
  }
}
