/**
 * @fileoverview Minimal ZIP reader for Windows Media Player skin packages (.wmz).
 *
 * A `.wmz` file is an ordinary ZIP archive with a different extension. Rather
 * than pull in a ZIP dependency for a single format, this module parses the
 * central directory by hand and inflates entries with Node's built-in `zlib`.
 * Only the two compression methods WMP skins actually use are supported:
 * stored (0) and deflate (8).
 *
 * The reader is deliberately strict about the things that would let a malicious
 * archive escape its extraction directory: entry names are normalised and any
 * name that walks outside the destination is rejected rather than written.
 *
 * @module electron/wmz-archive
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** Signature marking the end-of-central-directory record. */
const SIGNATURE_END_OF_CENTRAL_DIRECTORY: number = 0x06054b50;

/** Signature marking a central directory file header. */
const SIGNATURE_CENTRAL_FILE_HEADER: number = 0x02014b50;

/** Signature marking a local file header. */
const SIGNATURE_LOCAL_FILE_HEADER: number = 0x04034b50;

/** Fixed byte length of the end-of-central-directory record. */
const END_OF_CENTRAL_DIRECTORY_SIZE: number = 22;

/** Fixed byte length of a central directory file header. */
const CENTRAL_FILE_HEADER_SIZE: number = 46;

/** Fixed byte length of a local file header. */
const LOCAL_FILE_HEADER_SIZE: number = 30;

/** Maximum length of the ZIP archive comment, which trails the EOCD record. */
const MAX_ARCHIVE_COMMENT_SIZE: number = 65535;

/** Compression method identifier for stored (uncompressed) entries. */
const COMPRESSION_STORED: number = 0;

/** Compression method identifier for deflated entries. */
const COMPRESSION_DEFLATE: number = 8;

/** Sentinel written into 32-bit size fields when ZIP64 extensions are in use. */
const ZIP64_SENTINEL: number = 0xffffffff;

// Byte offsets within the end-of-central-directory record.
const EOCD_OFFSET_ENTRY_COUNT: number = 10;
const EOCD_OFFSET_DIRECTORY_SIZE: number = 12;
const EOCD_OFFSET_DIRECTORY_START: number = 16;

// Byte offsets within a central directory file header.
const CENTRAL_OFFSET_COMPRESSION_METHOD: number = 10;
const CENTRAL_OFFSET_COMPRESSED_SIZE: number = 20;
const CENTRAL_OFFSET_UNCOMPRESSED_SIZE: number = 24;
const CENTRAL_OFFSET_NAME_LENGTH: number = 28;
const CENTRAL_OFFSET_EXTRA_LENGTH: number = 30;
const CENTRAL_OFFSET_COMMENT_LENGTH: number = 32;
const CENTRAL_OFFSET_LOCAL_HEADER: number = 42;

// Byte offsets within a local file header.
const LOCAL_OFFSET_NAME_LENGTH: number = 26;
const LOCAL_OFFSET_EXTRA_LENGTH: number = 28;

/**
 * A single file entry read from a `.wmz` archive.
 *
 * @property name - Entry path as stored in the archive, with `\` normalised to `/`
 * @property data - Fully decompressed entry contents
 */
export interface WmzEntry {
  /** Entry path as stored in the archive, using forward slashes */
  readonly name: string;
  /** Decompressed entry contents */
  readonly data: Buffer;
}

/**
 * Locates the end-of-central-directory record by scanning backwards from the
 * end of the buffer.
 *
 * The record is variable-length because it carries a trailing comment, so its
 * position cannot be computed - it has to be found.
 *
 * @param buffer - Complete archive contents
 * @returns Byte offset of the EOCD record
 * @throws If no EOCD signature is present, meaning this is not a ZIP archive
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest: number = Math.max(
    0,
    buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ARCHIVE_COMMENT_SIZE
  );

  for (let offset: number = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === SIGNATURE_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  throw new Error('Not a ZIP archive: end-of-central-directory record not found');
}

/**
 * Decompresses a single entry given its central directory header.
 *
 * The compressed bytes live after the entry's *local* header, whose extra field
 * length routinely differs from the central header's, so the local header has
 * to be read to find where the data actually begins.
 *
 * @param buffer - Complete archive contents
 * @param localHeaderOffset - Offset of the entry's local file header
 * @param compressionMethod - ZIP compression method identifier
 * @param compressedSize - Compressed byte length from the central directory
 * @returns Decompressed entry contents
 * @throws If the local header is malformed or the method is unsupported
 */
function readEntryData(
  buffer: Buffer,
  localHeaderOffset: number,
  compressionMethod: number,
  compressedSize: number
): Buffer {
  if (buffer.readUInt32LE(localHeaderOffset) !== SIGNATURE_LOCAL_FILE_HEADER) {
    throw new Error('Malformed archive: local file header signature missing');
  }

  const nameLength: number = buffer.readUInt16LE(localHeaderOffset + LOCAL_OFFSET_NAME_LENGTH);
  const extraLength: number = buffer.readUInt16LE(localHeaderOffset + LOCAL_OFFSET_EXTRA_LENGTH);
  const dataStart: number = localHeaderOffset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;
  const compressed: Buffer = buffer.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === COMPRESSION_STORED) {
    return Buffer.from(compressed);
  }

  if (compressionMethod === COMPRESSION_DEFLATE) {
    return zlib.inflateRawSync(compressed);
  }

  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

/**
 * Reads every entry from a `.wmz` (or any plain ZIP) archive.
 *
 * Directory entries - names ending in `/` - are skipped, since the extractor
 * creates directories from file paths as it goes.
 *
 * @param archivePath - Absolute path to the archive
 * @returns All file entries with their decompressed contents
 * @throws If the file is not a readable ZIP archive or uses ZIP64 extensions
 */
export function readWmzArchive(archivePath: string): WmzEntry[] {
  const buffer: Buffer = fs.readFileSync(archivePath);
  const eocdOffset: number = findEndOfCentralDirectory(buffer);
  const entryCount: number = buffer.readUInt16LE(eocdOffset + EOCD_OFFSET_ENTRY_COUNT);
  const directorySize: number = buffer.readUInt32LE(eocdOffset + EOCD_OFFSET_DIRECTORY_SIZE);
  const directoryStart: number = buffer.readUInt32LE(eocdOffset + EOCD_OFFSET_DIRECTORY_START);

  if (directoryStart === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries: WmzEntry[] = [];
  let cursor: number = directoryStart;

  for (let index: number = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(cursor) !== SIGNATURE_CENTRAL_FILE_HEADER) {
      throw new Error('Malformed archive: central directory header signature missing');
    }

    const compressionMethod: number = buffer.readUInt16LE(cursor + CENTRAL_OFFSET_COMPRESSION_METHOD);
    const compressedSize: number = buffer.readUInt32LE(cursor + CENTRAL_OFFSET_COMPRESSED_SIZE);
    const uncompressedSize: number = buffer.readUInt32LE(cursor + CENTRAL_OFFSET_UNCOMPRESSED_SIZE);
    const nameLength: number = buffer.readUInt16LE(cursor + CENTRAL_OFFSET_NAME_LENGTH);
    const extraLength: number = buffer.readUInt16LE(cursor + CENTRAL_OFFSET_EXTRA_LENGTH);
    const commentLength: number = buffer.readUInt16LE(cursor + CENTRAL_OFFSET_COMMENT_LENGTH);
    const localHeaderOffset: number = buffer.readUInt32LE(cursor + CENTRAL_OFFSET_LOCAL_HEADER);
    const nameStart: number = cursor + CENTRAL_FILE_HEADER_SIZE;
    const rawName: string = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const name: string = rawName.replace(/\\/g, '/');

    cursor = nameStart + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new Error(`ZIP64 entry is not supported: ${name}`);
    }

    entries.push({
      name,
      data: readEntryData(buffer, localHeaderOffset, compressionMethod, compressedSize),
    });
  }

  return entries;
}

/**
 * Extracts a `.wmz` archive into a destination directory.
 *
 * Entry names are resolved against the destination and any that escape it -
 * through `..` segments or an absolute path - are skipped, so a hostile
 * archive cannot write outside the directory it was given.
 *
 * @param archivePath - Absolute path to the archive
 * @param destination - Directory to extract into; created if absent
 * @returns Names of the entries that were written, relative to the destination
 */
export function extractWmzArchive(archivePath: string, destination: string): string[] {
  const entries: WmzEntry[] = readWmzArchive(archivePath);
  const root: string = path.resolve(destination);
  const written: string[] = [];

  fs.mkdirSync(root, {recursive: true});

  for (const entry of entries) {
    const target: string = path.resolve(root, entry.name);

    // path.resolve collapses `..`, so a target still inside the root here is
    // genuinely inside it. The separator guard stops `/rootEvil` matching `/root`.
    if (target !== root && !target.startsWith(root + path.sep)) continue;

    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, entry.data);
    written.push(path.relative(root, target).replace(/\\/g, '/'));
  }

  return written;
}
