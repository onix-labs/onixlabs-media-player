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
import {MEDIA_EXTENSIONS} from '../constants/media.constants';

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

      if (MEDIA_EXTENSIONS.has(ext)) {
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
}
