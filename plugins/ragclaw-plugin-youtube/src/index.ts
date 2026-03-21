/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { createRequire } from "node:module";
import type {
  ContentType,
  ExtractedContent,
  Extractor,
  RagClawPlugin,
  Source,
} from "@emdzej/ragclaw-core";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

/** Configurable fetch timeout in ms (overridable via plugin config). */
let FETCH_TIMEOUT_MS = 30_000;

/**
 * Extract video ID from various YouTube URL formats
 */
/** @internal — exported for testing only */
export function extractVideoId(input: string): string | null {
  // Handle youtube:// and yt:// schemes
  if (input.startsWith("youtube://") || input.startsWith("yt://")) {
    return input.replace(/^(youtube|yt):\/\//, "");
  }

  // Handle standard YouTube URLs
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/, // Just the video ID
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Fetch video metadata from YouTube oEmbed API
 */
async function fetchVideoMetadata(
  videoId: string
): Promise<{ title: string; author: string } | null> {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;

    const data = await response.json();
    return {
      title: data.title || "Unknown Title",
      author: data.author_name || "Unknown Author",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch transcript using YouTube Innertube API
 */
async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
  // Use YouTube innertube API (same as mobile app)
  const innertubeUrl = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const body = JSON.stringify({
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
      },
    },
    videoId,
  });

  const response = await fetch(innertubeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch video info: ${response.status}`);
  }

  const data = (await response.json()) as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{ baseUrl: string; languageCode: string }>;
      };
    };
  };

  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    throw new Error("No captions available for this video");
  }

  // Prefer English, fall back to first available
  const track = tracks.find((t) => t.languageCode === "en") || tracks[0];

  // Fetch transcript XML
  const transcriptResponse = await fetch(track.baseUrl, {
    headers: {
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!transcriptResponse.ok) {
    throw new Error(`Failed to fetch transcript: ${transcriptResponse.status}`);
  }

  const transcriptXml = await transcriptResponse.text();

  // Parse XML transcript (format: <p t="start_ms" d="duration_ms">text</p>)
  const segments: TranscriptSegment[] = [];
  const textRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/p>/g;

  for (const match of transcriptXml.matchAll(textRegex)) {
    const text = match[3]
      .replace(/<[^>]+>/g, "") // Remove any nested tags
      .trim();

    if (text) {
      segments.push({
        start: parseInt(match[1], 10) / 1000,
        duration: parseInt(match[2], 10) / 1000,
        text: decodeHtmlEntities(text),
      });
    }
  }

  return segments;
}

/** @internal — exported for testing only */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Format timestamp from seconds
 */
/** @internal — exported for testing only */
export function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * YouTube transcript extractor
 */
class YouTubeExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "url" || !source.url) return false;

    const url = source.url;

    // Custom schemes
    if (url.startsWith("youtube://") || url.startsWith("yt://")) {
      return true;
    }

    // Standard YouTube URLs
    if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
      return true;
    }

    return false;
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (source.type !== "url") {
      throw new Error(`YouTube extractor requires a URL source, got: ${source.type}`);
    }
    const url = source.url;
    const videoId = extractVideoId(url);

    if (!videoId) {
      throw new Error(`Invalid YouTube URL or video ID: ${url}`);
    }

    // Fetch transcript
    const segments = await fetchTranscript(videoId);

    if (!segments || segments.length === 0) {
      throw new Error(`No transcript available for video: ${videoId}`);
    }

    // Fetch metadata
    const metadata = await fetchVideoMetadata(videoId);

    // Format transcript
    const text = segments.map((s) => s.text.trim()).join(" ");
    const lastSegment = segments[segments.length - 1];
    const duration = lastSegment
      ? formatTimestamp(lastSegment.start + lastSegment.duration)
      : "unknown";

    // Build header
    const header = [
      `# ${metadata?.title || "YouTube Video"}`,
      "",
      `**Video ID:** ${videoId}`,
      `**Channel:** ${metadata?.author || "Unknown"}`,
      `**Duration:** ${duration}`,
      `**URL:** https://youtube.com/watch?v=${videoId}`,
      "",
      "---",
      "",
      "## Transcript",
      "",
    ].join("\n");

    return {
      text: header + text,
      metadata: {
        source: `https://youtube.com/watch?v=${videoId}`,
        videoId,
        title: metadata?.title,
        author: metadata?.author,
        duration,
        segmentCount: segments.length,
        extractedAt: new Date().toISOString(),
      },
      sourceType: "text" as ContentType,
      mimeType: "text/plain",
    };
  }
}

/**
 * ragclaw-plugin-youtube
 *
 * Index YouTube video transcripts into RagClaw knowledge bases.
 *
 * Usage:
 *   ragclaw add youtube://dQw4w9WgXcQ
 *   ragclaw add yt://dQw4w9WgXcQ
 *   ragclaw add "https://youtube.com/watch?v=dQw4w9WgXcQ"
 */
const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-youtube",
  version,

  extractors: [new YouTubeExtractor()],

  schemes: ["youtube", "yt"],

  configSchema: [
    {
      key: "fetchTimeoutMs",
      type: "number",
      description: "HTTP fetch timeout in ms (default: 30000)",
      defaultValue: 30_000,
    },
  ],

  async init(config?: Record<string, unknown>) {
    if (!config) return;
    if (typeof config.fetchTimeoutMs === "string") {
      const n = parseInt(config.fetchTimeoutMs, 10);
      if (Number.isFinite(n) && n > 0) FETCH_TIMEOUT_MS = n;
    }
  },
};

export default plugin;
