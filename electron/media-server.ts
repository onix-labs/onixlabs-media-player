import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createReadStream, statSync } from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';

// Formats that Chromium can play natively (no transcoding needed)
const NATIVE_VIDEO_FORMATS = new Set(['.mp4', '.webm', '.ogg']);
const NATIVE_AUDIO_FORMATS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

// MIME types for media files
const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/mp4', // Transcoded to MP4
  '.avi': 'video/mp4', // Transcoded to MP4
  '.mov': 'video/mp4',
};

export class MediaServer {
  private server: Server | null = null;
  private port: number = 0;

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this));

      this.server.on('error', reject);

      // Listen on random available port
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (typeof address === 'object' && address) {
          this.port = address.port;
          console.log(`Media server started on http://127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getUrl(filePath: string): string {
    return `http://127.0.0.1:${this.port}/media?path=${encodeURIComponent(filePath)}`;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

    if (url.pathname !== '/media') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end('Missing path parameter');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const isNativeVideo = NATIVE_VIDEO_FORMATS.has(ext);
    const isNativeAudio = NATIVE_AUDIO_FORMATS.has(ext);

    if (isNativeVideo || isNativeAudio) {
      this.serveDirectFile(req, res, filePath, ext);
    } else {
      // Transcode to a format the browser can play
      this.serveTranscodedFile(req, res, filePath);
    }
  }

  private serveDirectFile(req: IncomingMessage, res: ServerResponse, filePath: string, ext: string): void {
    try {
      const stat = statSync(filePath);
      const fileSize = stat.size;
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      const range = req.headers.range;

      if (range) {
        // Handle range request for seeking
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        // Full file request
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      console.error('Error serving file:', err);
      res.writeHead(500);
      res.end('Error reading file');
    }
  }

  private serveTranscodedFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
    // For non-native formats, transcode to fragmented MP4 with H.264/AAC
    // Using frag_keyframe+empty_moov for streaming (faststart doesn't work with pipes)
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const seekTime = url.searchParams.get('t') || '0';

    console.log(`Transcoding: ${filePath} (seek: ${seekTime}s)`);

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-ss', seekTime,
      '-i', filePath,
      // Video: H.264 with settings optimized for streaming
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      // Audio: AAC
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      // Fragmented MP4 for streaming (no faststart - doesn't work with pipes)
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
      // Log FFmpeg warnings/errors
      const msg = data.toString().trim();
      if (msg) console.log('FFmpeg:', msg);
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg exited with code ${code}`);
      }
    });

    // Clean up on client disconnect
    req.on('close', () => {
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    });

    res.on('close', () => {
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    });
  }
}
