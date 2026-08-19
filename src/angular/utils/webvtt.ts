/**
 * @fileoverview WebVTT parsing, cue selection and subtitle text sanitization.
 *
 * Pure functions, deliberately free of Angular and the DOM. These previously
 * lived inside VideoOutlet, where they could only be exercised by driving a
 * component with a real <video> element — which meant that in practice they
 * were not exercised at all, despite sanitizeSubtitleHtml standing between
 * untrusted subtitle files and an innerHTML binding.
 *
 * @module app/utils/webvtt
 */

/** Seconds in a minute, for timestamp arithmetic. */
const SECONDS_PER_MINUTE: number = 60;

/** Seconds in an hour, for timestamp arithmetic. */
const SECONDS_PER_HOUR: number = 3600;

/** Milliseconds in a second, for timestamp arithmetic. */
const MS_PER_SECOND: number = 1000;

/** Formatting tags kept as markup when sanitizing subtitle text. */
const ALLOWED_TAGS: readonly string[] = ['i', 'b', 'u', 'em', 'strong'];

/**
 * A parsed WebVTT cue with timing and text content.
 *
 * Used for custom subtitle rendering that bypasses the browser's TextTrack API.
 */
export interface ParsedSubtitleCue {
  /** Start time in seconds */
  readonly startTime: number;
  /** End time in seconds */
  readonly endTime: number;
  /** Text content (may contain HTML formatting) */
  readonly text: string;
}

/**
 * A loaded subtitle track with all its parsed cues.
 */
export interface LoadedSubtitleTrack {
  /** Track index (matches SubtitleTrack.index) */
  readonly index: number;
  /** All parsed cues for this track */
  readonly cues: readonly ParsedSubtitleCue[];
}

/**
 * Parses a WebVTT timing line to extract start and end times.
 *
 * @param line - Timing line (e.g., "00:01:23.456 --> 00:01:27.890")
 * @returns Start and end times in seconds, or null if the line does not parse
 */
export function parseTimingLine(line: string): {start: number; end: number} | null {
  // Match pattern: HH:MM:SS.mmm --> HH:MM:SS.mmm (hours optional)
  const match: RegExpMatchArray | null = line.match(
    /(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/
  );

  if (!match) return null;

  const startHours: number = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
  const startMinutes: number = parseInt(match[2], 10);
  const startSeconds: number = parseInt(match[3], 10);
  const startMs: number = parseInt(match[4], 10);

  const endHours: number = match[5] ? parseInt(match[5].replace(':', ''), 10) : 0;
  const endMinutes: number = parseInt(match[6], 10);
  const endSeconds: number = parseInt(match[7], 10);
  const endMs: number = parseInt(match[8], 10);

  const start: number = startHours * SECONDS_PER_HOUR + startMinutes * SECONDS_PER_MINUTE + startSeconds + startMs / MS_PER_SECOND;
  const end: number = endHours * SECONDS_PER_HOUR + endMinutes * SECONDS_PER_MINUTE + endSeconds + endMs / MS_PER_SECOND;

  return {start, end};
}

/**
 * Parses WebVTT content into an array of cues.
 *
 * @param content - Raw WebVTT file content
 * @returns Parsed cues with timing and text, in file order
 */
export function parseWebVTT(content: string): ParsedSubtitleCue[] {
  const cues: ParsedSubtitleCue[] = [];
  const lines: string[] = content.split('\n');

  let i: number = 0;

  // Skip WEBVTT header and any metadata
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  // Parse cues
  while (i < lines.length) {
    const line: string = lines[i].trim();

    // Look for timing line (contains "-->")
    if (line.includes('-->')) {
      const timing: {start: number; end: number} | null = parseTimingLine(line);
      if (timing) {
        // Collect text lines until we hit an empty line or EOF
        const textLines: string[] = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i].trim());
          i++;
        }

        if (textLines.length > 0) {
          cues.push({
            startTime: timing.start,
            endTime: timing.end,
            text: textLines.join('\n'),
          });
        }
      }
    }
    i++;
  }

  return cues;
}

/**
 * Returns the text of every cue active at a given playback time.
 *
 * @param cues - The track's cues
 * @param currentTime - Playback position in seconds
 * @returns The active cues' text joined by newlines, or '' when none are active
 */
export function cueTextAt(cues: readonly ParsedSubtitleCue[], currentTime: number): string {
  const active: ParsedSubtitleCue[] = cues.filter(
    (cue: ParsedSubtitleCue): boolean => currentTime >= cue.startTime && currentTime <= cue.endTime
  );

  return active.map((cue: ParsedSubtitleCue): string => cue.text).join('\n');
}

/**
 * Sanitizes subtitle text to allow only safe HTML formatting tags.
 *
 * Subtitle files are untrusted input and the result is bound with innerHTML,
 * so everything is escaped first and only the known-safe formatting tags are
 * put back. Newlines become <br> so multi-line cues display correctly.
 *
 * @param text - Raw subtitle text that may contain HTML
 * @returns Sanitized HTML string safe for innerHTML binding
 */
export function sanitizeSubtitleHtml(text: string): string {
  if (!text) return '';

  // Convert newlines to placeholders first
  let sanitized: string = text.replace(/\n/g, '{{NEWLINE}}');

  // Escape all HTML entities
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Restore allowed tags (they were escaped, so we need to un-escape them)
  for (const tagName of ALLOWED_TAGS) {
    // Restore opening tags: &lt;tagname&gt; -> <tagname>
    sanitized = sanitized.replace(
      new RegExp(`&lt;(${tagName})\\s*&gt;`, 'gi'),
      `<$1>`
    );
    // Restore closing tags: &lt;/tagname&gt; -> </tagname>
    sanitized = sanitized.replace(
      new RegExp(`&lt;/(${tagName})\\s*&gt;`, 'gi'),
      `</$1>`
    );
  }

  // Convert newline placeholders to <br> tags
  sanitized = sanitized.replace(/\{\{NEWLINE\}\}/g, '<br>');

  return sanitized;
}
