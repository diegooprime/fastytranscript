import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  TranscriptOptions,
  TranscriptResult,
  TranscriptSegment,
  YouTubeOEmbedResponse,
  YtDlpInfo,
} from "./types";

// Common paths where yt-dlp may be installed (Raycast doesn't inherit full shell PATH)
const YT_DLP_PATHS = [
  "/opt/homebrew/bin/yt-dlp",
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  "yt-dlp",
];

const FETCH_TIMEOUT = 15000;

// Perf flags for yt-dlp: skip JS challenge solving and format checks (not needed for subtitle-only downloads)
const YT_DLP_PERF_FLAGS = [
  "--no-warnings",
  "--no-check-formats",
  "--extractor-args",
  "youtube:player_skip=js",
];

const SUBTITLE_FILE_EXTENSIONS = [".en.srv1", ".en.vtt"];

async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeout || FETCH_TIMEOUT;
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

// Extract video ID from various YouTube URL formats
export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

// Fetch video title using YouTube's oEmbed API
async function fetchVideoTitle(videoId: string): Promise<string> {
  try {
    const response = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    );
    if (response.ok) {
      const data = (await response.json()) as YouTubeOEmbedResponse;
      return data.title || `YouTube Video ${videoId}`;
    }
  } catch {
    return `YouTube Video ${videoId}`;
  }
  return `YouTube Video ${videoId}`;
}

// Decode HTML entities (&amp; decoded last to prevent double-decoding &amp;lt; → <)
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
    .replace(/&amp;/g, "&") // must be last
    .replace(/\s+/g, " ");
}

// Parse transcript XML - handles both srv1 (<text>) and srv3 (<p>/<s>) formats
function parseTranscriptXml(xml: string): TranscriptSegment[] {
  // srv1 format: <text start="..." dur="...">content</text>
  const srv1Re =
    /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([^<]*)<\/text>/g;
  const srv1Segments: TranscriptSegment[] = [];
  let m: RegExpExecArray | null;
  while ((m = srv1Re.exec(xml)) !== null) {
    if (m[3].trim()) {
      srv1Segments.push({
        text: m[3],
        start: parseFloat(m[1]) || 0,
        duration: parseFloat(m[2]) || 0,
      });
    }
  }
  if (srv1Segments.length > 0) return srv1Segments;

  // srv3 format: <p t="..." d="..."><s>word</s>...</p>
  const pRe = /<p\s+t="([^"]*)"(?:\s+d="([^"]*)")?[^>]*>([\s\S]*?)<\/p>/g;
  const srv3Segments: TranscriptSegment[] = [];
  while ((m = pRe.exec(xml)) !== null) {
    const startMs = parseInt(m[1]) || 0;
    const durMs = parseInt(m[2]) || 0;
    const inner = m[3];
    // Extract text from <s> tags within each <p>
    const words: string[] = [];
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let s: RegExpExecArray | null;
    while ((s = sRe.exec(inner)) !== null) {
      if (s[1]) words.push(s[1]);
    }
    let text: string;
    if (words.length > 0) {
      text = words.join("");
    } else {
      // Fallback: strip all tags and use raw text
      text = inner.replace(/<[^>]+>/g, "").trim();
    }
    if (text) {
      srv3Segments.push({
        text,
        start: startMs / 1000,
        duration: durMs / 1000,
      });
    }
  }
  return srv3Segments;
}

// Parse VTT subtitle format
function parseVtt(vtt: string): TranscriptSegment[] {
  const lines = vtt.split("\n");
  const segments: TranscriptSegment[] = [];
  const timeRe = /(\d+):(\d+):(\d+)\.(\d+)\s*-->\s*(\d+):(\d+):(\d+)\.(\d+)/;
  let currentStart = 0;
  let currentEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const timeLine = lines[i].match(timeRe);
    if (timeLine) {
      currentStart =
        parseInt(timeLine[1]) * 3600 +
        parseInt(timeLine[2]) * 60 +
        parseInt(timeLine[3]) +
        parseInt(timeLine[4]) / 1000;
      currentEnd =
        parseInt(timeLine[5]) * 3600 +
        parseInt(timeLine[6]) * 60 +
        parseInt(timeLine[7]) +
        parseInt(timeLine[8]) / 1000;
      // Collect text lines until empty line
      const textLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const trimmed = lines[j].trim();
        if (!trimmed) break;
        // Strip VTT tags like <c>, </c>, etc.
        const cleaned = trimmed.replace(/<[^>]+>/g, "").trim();
        if (cleaned) textLines.push(cleaned);
      }
      const text = textLines.join(" ");
      if (text && !segments.some((s) => s.text === text)) {
        segments.push({
          text,
          start: currentStart,
          duration: currentEnd - currentStart,
        });
      }
    }
  }
  return segments;
}

// Find the yt-dlp binary (Raycast doesn't inherit full shell PATH)
function findYtDlp(): string {
  for (const p of YT_DLP_PATHS) {
    try {
      execFileSync(p, ["--version"], { timeout: 5000, stdio: "pipe" });
      return p;
    } catch {
      continue;
    }
  }
  throw new Error("yt-dlp not found. Install via: brew install yt-dlp");
}

function removeFileIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

// Clean up temp subtitle files for a video
function cleanupSubFiles(prefix: string, videoId: string): void {
  for (const ext of SUBTITLE_FILE_EXTENSIONS) {
    removeFileIfExists(`${prefix}${videoId}${ext}`);
  }
}

// Strategy 1: yt-dlp direct subtitle download (most reliable)
// Downloads subtitles directly instead of fetching timedtext URLs (which YouTube broke)
function fetchTranscriptWithYtDlpDownload(
  videoId: string,
): TranscriptSegment[] {
  const ytDlp = findYtDlp();
  const prefix = join(tmpdir(), "fasty-");

  cleanupSubFiles(prefix, videoId);

  // SECURITY: videoId is validated by extractVideoId (alphanumeric + hyphen/underscore only)
  const subArgSets: string[][] = [
    ["--write-sub", "--sub-lang", "en", "--sub-format", "srv1"],
    ["--write-auto-sub", "--sub-lang", "en", "--sub-format", "srv1"],
    ["--write-auto-sub", "--sub-lang", "en", "--sub-format", "vtt"],
  ];

  for (const subArgs of subArgSets) {
    try {
      execFileSync(
        ytDlp,
        [
          ...subArgs,
          ...YT_DLP_PERF_FLAGS,
          "--skip-download",
          "-o",
          `${prefix}%(id)s`,
          "--",
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        {
          timeout: 30000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );

      const possibleFiles = SUBTITLE_FILE_EXTENSIONS.map(
        (ext) => `${prefix}${videoId}${ext}`,
      );

      for (const filePath of possibleFiles) {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          unlinkSync(filePath);

          if (!content || content.trim().length === 0) continue;

          if (filePath.endsWith(".vtt")) {
            const segments = parseVtt(content);
            if (segments.length > 0) return segments;
          } else {
            const segments = parseTranscriptXml(content);
            if (segments.length > 0) return segments;
          }
        }
      }
    } catch {
      cleanupSubFiles(prefix, videoId);
    }
  }

  cleanupSubFiles(prefix, videoId);
  throw new Error("yt-dlp: could not download subtitles");
}

// Strategy 2: yt-dlp JSON metadata + subtitle URL fetch (fallback)
function fetchTranscriptFromYtDlpJson(videoId: string): TranscriptSegment[] {
  const ytDlp = findYtDlp();
  const result = execFileSync(
    ytDlp,
    [
      ...YT_DLP_PERF_FLAGS,
      "--skip-download",
      "--dump-json",
      "--",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    {
      timeout: 30000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

  const info = JSON.parse(result) as YtDlpInfo;

  const subs = info.subtitles || {};
  const autoCaps = info.automatic_captions || {};

  const subSource =
    subs["en"] ||
    subs["en-US"] ||
    Object.values(subs)[0] ||
    autoCaps["en"] ||
    autoCaps["en-US"] ||
    Object.values(autoCaps)[0];

  if (!subSource || subSource.length === 0) {
    throw new Error("yt-dlp: no subtitle sources found");
  }

  const track =
    subSource.find((s) => s.ext === "srv1") ||
    subSource.find((s) => s.ext === "srv2") ||
    subSource.find((s) => s.ext === "srv3") ||
    subSource.find((s) => s.ext === "vtt") ||
    subSource[0];

  if (!track?.url) throw new Error("yt-dlp: no subtitle track URL");

  // SECURITY: Use execFileSync to avoid shell injection from track.url
  const prefix = join(tmpdir(), "fasty-sub-");
  const outFile = `${prefix}${videoId}.sub`;
  try {
    execFileSync("curl", ["-sL", "--", track.url, "-o", outFile], {
      timeout: 15000,
      encoding: "utf-8",
    });

    if (existsSync(outFile)) {
      const content = readFileSync(outFile, "utf-8");
      unlinkSync(outFile);

      if (content && content.trim().length > 0) {
        const segments = parseTranscriptXml(content);
        if (segments.length > 0) return segments;

        if (content.includes("WEBVTT")) {
          const vttSegments = parseVtt(content);
          if (vttSegments.length > 0) return vttSegments;
        }
      }
    }
  } catch {
    removeFileIfExists(outFile);
  }

  throw new Error("yt-dlp: subtitle URL returned empty or unparseable content");
}

// Format seconds into MM:SS
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// Join segments with timestamps: "[MM:SS] text\n"
function joinSegmentsWithTimestamps(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (s) =>
        `[${formatTimestamp(s.start)}] ${decodeHtmlEntities(s.text).trim()}`,
    )
    .join("\n");
}

// Main: try all strategies in order
export async function getVideoTranscript(
  videoId: string,
  options: TranscriptOptions = {},
): Promise<TranscriptResult> {
  const titlePromise = fetchVideoTitle(videoId);
  const errors: string[] = [];

  // Strategy 1: yt-dlp direct subtitle download (handles YouTube's auth internally)
  try {
    const segments = fetchTranscriptWithYtDlpDownload(videoId);
    const title = await titlePromise;
    return { transcript: formatSegments(segments, options), title };
  } catch (e) {
    errors.push(
      `yt-dlp download: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Strategy 2: yt-dlp JSON metadata + URL fetch (fallback)
  try {
    const segments = fetchTranscriptFromYtDlpJson(videoId);
    const title = await titlePromise;
    return { transcript: formatSegments(segments, options), title };
  } catch (e) {
    errors.push(`yt-dlp JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(
    `No transcript available. All methods failed:\n${errors.map((e) => `- ${e}`).join("\n")}`,
  );
}

function formatSegments(
  segments: TranscriptSegment[],
  options: TranscriptOptions,
): string {
  if (options.timestamps) {
    return joinSegmentsWithTimestamps(segments);
  }
  return joinSegments(segments);
}

function joinSegments(segments: TranscriptSegment[]): string {
  return decodeHtmlEntities(segments.map((s) => s.text).join(" ")).trim();
}

// Sanitize title for safe markdown heading insertion
function sanitizeMarkdownTitle(title: string): string {
  return title.replace(/[<#[\]()\\`*_{}!|~>]/g, "\\$&").replace(/\n/g, " ");
}

// Format transcript as Markdown
export function formatTranscriptAsMarkdown(
  transcript: string,
  videoId: string,
  title: string,
): string {
  const safeTitle = sanitizeMarkdownTitle(title);
  return `# ${safeTitle}

**URL:** https://youtube.com/watch?v=${videoId}

---

${transcript}

---

*Generated by FastyTranscript*`;
}
