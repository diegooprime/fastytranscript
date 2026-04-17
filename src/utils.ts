import { execFile, execFileSync } from "child_process";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  TranscriptOptions,
  TranscriptResult,
  TranscriptSegment,
  YouTubeOEmbedResponse,
  YtDlpInfo,
  YtDlpSubtitleTrack,
  YtDlpSubtitleTrackMap,
} from "./types";

type CaptionTrack = {
  baseUrl: string;
  languageCode?: string;
};

type SubtitleSourceSelection = {
  languageCode: string;
  tracks: YtDlpSubtitleTrack[];
};

// Common paths where yt-dlp may be installed (Raycast doesn't inherit full shell PATH)
const YT_DLP_PATHS = [
  "/opt/homebrew/bin/yt-dlp",
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  "yt-dlp",
];

const FETCH_TIMEOUT = 15000;
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA =
  "com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_US) gzip";

// Perf flags for yt-dlp: skip JS challenge solving and format checks (not needed for subtitle-only downloads)
const YT_DLP_PERF_FLAGS = [
  "--no-warnings",
  "--no-check-formats",
  "--extractor-args",
  "youtube:player_skip=js",
];

const YT_DLP_SUBTITLE_EXT_PRIORITY = ["srv1", "srv3", "vtt"];
const YT_DLP_COOKIE_BROWSERS = [
  "brave",
  "chrome",
  "edge",
  "vivaldi",
  "opera",
  "chromium",
];
const TMP_SUBTITLE_PREFIX = "fasty-";

function execFileAsync(
  file: string,
  args: string[],
  options: {
    timeout: number;
    encoding: BufferEncoding;
    maxBuffer?: number;
    stdio?: ["pipe", "pipe", "ignore"];
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeout || FETCH_TIMEOUT;
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCaptionTrack(value: unknown): value is CaptionTrack {
  return isRecord(value) && isString(value.baseUrl);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObject(str: string, startIdx: number): string | null {
  if (str[startIdx] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) {
      return str.substring(startIdx, i + 1);
    }
  }

  return null;
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
export async function fetchVideoTitle(videoId: string): Promise<string> {
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

function getCaptionTracksFromCaptionsValue(captions: unknown): CaptionTrack[] | null {
  if (!isRecord(captions)) return null;

  const renderer = captions.playerCaptionsTracklistRenderer;
  if (!isRecord(renderer) || !Array.isArray(renderer.captionTracks)) return null;

  const tracks = renderer.captionTracks.filter(isCaptionTrack);
  return tracks.length > 0 ? tracks : null;
}

function getCaptionTracksFromPlayerResponse(data: unknown): CaptionTrack[] | null {
  if (!isRecord(data)) return null;
  return getCaptionTracksFromCaptionsValue(data.captions);
}

function isEnglishLanguageCode(languageCode: string): boolean {
  return languageCode === "en" || languageCode.startsWith("en-");
}

function isTranslatedTrackUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.has("tlang");
  } catch {
    return /(?:[?&])tlang=/.test(url);
  }
}

function pickTrackUrl(tracks: CaptionTrack[]): string | null {
  const nativeEnglish = tracks.find(
    (track) =>
      isString(track.languageCode) &&
      isEnglishLanguageCode(track.languageCode) &&
      !isTranslatedTrackUrl(track.baseUrl),
  );
  const nativeAny = tracks.find((track) => !isTranslatedTrackUrl(track.baseUrl));
  const translatedEnglish = tracks.find(
    (track) =>
      isString(track.languageCode) && isEnglishLanguageCode(track.languageCode),
  );
  const chosen = nativeEnglish || nativeAny || translatedEnglish || tracks[0];
  return chosen?.baseUrl || null;
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
  const seen = new Set<string>();

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
        if (cleaned && !seen.has(cleaned)) {
          seen.add(cleaned);
          textLines.push(cleaned);
        }
      }
      const text = textLines.join(" ");
      if (text) {
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

function listSubtitleFiles(videoId: string): string[] {
  const filePrefix = `${TMP_SUBTITLE_PREFIX}${videoId}`;
  return readdirSync(tmpdir())
    .filter(
      (file) =>
        file.startsWith(filePrefix) &&
        YT_DLP_SUBTITLE_EXT_PRIORITY.some((ext) => file.endsWith(`.${ext}`)),
    )
    .map((file) => join(tmpdir(), file));
}

function cleanupSubFiles(videoId: string): void {
  for (const filePath of listSubtitleFiles(videoId)) {
    unlinkSync(filePath);
  }
}

function parseSubtitleFile(filePath: string): TranscriptSegment[] {
  const content = readFileSync(filePath, "utf-8");
  return parseSubtitleContent(content);
}

function parseSubtitleContent(content: string): TranscriptSegment[] {
  if (content.trim().length === 0) {
    return [];
  }

  const segments = parseTranscriptXml(content);
  if (segments.length > 0) return segments;

  if (!content.includes("WEBVTT")) return [];

  return parseVtt(content);
}

async function fetchCaptionTrack(
  url: string,
  userAgent = WEB_UA,
): Promise<TranscriptSegment[]> {
  const response = await fetchWithTimeout(url, {
    headers: { "User-Agent": userAgent },
  });
  if (!response.ok) {
    throw new Error(`caption track returned ${response.status}`);
  }

  const content = await response.text();
  if (!content || content.length === 0) {
    throw new Error("caption track returned empty response");
  }

  const segments = parseSubtitleContent(content);
  if (segments.length === 0) {
    throw new Error("could not parse caption track");
  }

  return segments;
}

async function fetchTranscriptFromPage(
  videoId: string,
): Promise<TranscriptSegment[]> {
  const response = await fetchWithTimeout(
    `https://www.youtube.com/watch?v=${videoId}`,
    {
      headers: {
        "User-Agent": WEB_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`YouTube page returned ${response.status}`);
  }

  const html = await response.text();
  if (html.includes('class="g-recaptcha"')) {
    throw new Error("rate limited (captcha)");
  }

  const marker = html.match(/ytInitialPlayerResponse\s*=\s*\{/);
  if (marker?.index !== undefined) {
    const braceStart = html.indexOf("{", marker.index);
    const jsonStr = extractJsonObject(html, braceStart);
    if (jsonStr) {
      const playerResponse = parseJsonObject(jsonStr);
      const tracks = getCaptionTracksFromPlayerResponse(playerResponse);
      if (tracks) {
        const trackUrl = pickTrackUrl(tracks);
        if (trackUrl) {
          return await fetchCaptionTrack(trackUrl);
        }
      }
    }
  }

  const parts = html.split('"captions":');
  if (parts.length > 1) {
    const braceIdx = parts[1].indexOf("{");
    if (braceIdx !== -1) {
      const captionsJson = extractJsonObject(parts[1], braceIdx);
      if (captionsJson) {
        const captions = parseJsonObject(captionsJson);
        const tracks = getCaptionTracksFromCaptionsValue(captions);
        if (tracks) {
          const trackUrl = pickTrackUrl(tracks);
          if (trackUrl) {
            return await fetchCaptionTrack(trackUrl);
          }
        }
      }
    }
  }

  if (!html.includes('"playabilityStatus":')) {
    throw new Error("video is unavailable");
  }

  throw new Error("could not extract captions from page");
}

function getSubtitleFileCandidates(
  videoId: string,
  preferredLanguageCodes: string[] = [],
): string[] {
  const languageRank = new Map<string, number>();
  preferredLanguageCodes.forEach((languageCode, index) => {
    languageRank.set(languageCode, index);
  });

  const extRank = new Map(
    YT_DLP_SUBTITLE_EXT_PRIORITY.map((ext, index) => [ext, index]),
  );

  return listSubtitleFiles(videoId).sort((left, right) => {
    const leftFile = left.split("/").pop() || "";
    const rightFile = right.split("/").pop() || "";
    const leftParts = leftFile.split(".");
    const rightParts = rightFile.split(".");
    const leftLanguage = leftParts.length >= 3 ? leftParts[leftParts.length - 2] : "";
    const rightLanguage = rightParts.length >= 3 ? rightParts[rightParts.length - 2] : "";
    const leftLanguageRank =
      languageRank.get(leftLanguage) ?? Number.MAX_SAFE_INTEGER;
    const rightLanguageRank =
      languageRank.get(rightLanguage) ?? Number.MAX_SAFE_INTEGER;

    if (leftLanguageRank !== rightLanguageRank) {
      return leftLanguageRank - rightLanguageRank;
    }

    const leftExt = leftParts[leftParts.length - 1] || "";
    const rightExt = rightParts[rightParts.length - 1] || "";
    return (
      (extRank.get(leftExt) ?? Number.MAX_SAFE_INTEGER) -
      (extRank.get(rightExt) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function isLiveChatLanguage(languageCode: string): boolean {
  return languageCode === "live_chat";
}

function pickBestSubtitleSource(
  subs: YtDlpSubtitleTrackMap,
  autoCaps: YtDlpSubtitleTrackMap,
): SubtitleSourceSelection | undefined {
  const entries = [...Object.entries(subs), ...Object.entries(autoCaps)].filter(
    ([languageCode, tracks]) =>
      !isLiveChatLanguage(languageCode) && tracks.length > 0,
  );

  const pickEntry = (
    matcher: ([languageCode, tracks]: [string, YtDlpSubtitleTrack[]]) => boolean,
  ): SubtitleSourceSelection | undefined => {
    const match = entries.find(matcher);
    if (!match) return undefined;
    return { languageCode: match[0], tracks: match[1] };
  };

  return (
    pickEntry(
      ([languageCode, tracks]) =>
        isEnglishLanguageCode(languageCode) &&
        tracks.some((track) => !isTranslatedTrackUrl(track.url)),
    ) ||
    pickEntry(([, tracks]) =>
      tracks.some((track) => !isTranslatedTrackUrl(track.url)),
    ) ||
    pickEntry(([languageCode]) => isEnglishLanguageCode(languageCode)) ||
    pickEntry(() => true)
  );
}

function buildYtDlpSubtitleArgs(languageCodes?: string[]): string[] {
  const selectedLanguageCodes =
    languageCodes && languageCodes.length > 0
      ? languageCodes
      : ["all", "-live_chat"];

  return [
    "--write-subs",
    "--write-auto-subs",
    "--sub-lang",
    selectedLanguageCodes.join(","),
    "--sub-format",
    "srv1/vtt",
  ];
}

function getPreferredSubtitleLanguages(videoId: string): string[] | undefined {
  try {
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
    const selection = pickBestSubtitleSource(
      info.subtitles || {},
      info.automatic_captions || {},
    );

    return selection ? [selection.languageCode] : undefined;
  } catch {
    return undefined;
  }
}

// Strategy 1: yt-dlp direct subtitle download (most reliable)
// One fast pass for both manual and auto English captions.
function fetchTranscriptWithYtDlpDownload(
  videoId: string,
): TranscriptSegment[] {
  const ytDlp = findYtDlp();
  const outputTemplate = join(tmpdir(), `${TMP_SUBTITLE_PREFIX}%(id)s`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const preferredLanguageCodes = getPreferredSubtitleLanguages(videoId);

  cleanupSubFiles(videoId);

  try {
    const tryReadDownloadedSubtitles = (): TranscriptSegment[] | null => {
      for (const filePath of getSubtitleFileCandidates(videoId, preferredLanguageCodes)) {
        const segments = parseSubtitleFile(filePath);
        unlinkSync(filePath);
        if (segments.length > 0) return segments;
      }
      return null;
    };

    try {
      execFileSync(
        ytDlp,
        [
          ...buildYtDlpSubtitleArgs(preferredLanguageCodes),
          ...YT_DLP_PERF_FLAGS,
          "--skip-download",
          "-o",
          outputTemplate,
          "--",
          videoUrl,
        ],
        {
          timeout: 30000,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
    } catch {
      cleanupSubFiles(videoId);
    }

    const fastPathSegments = tryReadDownloadedSubtitles();
    if (fastPathSegments) {
      return fastPathSegments;
    }

    for (const browser of YT_DLP_COOKIE_BROWSERS) {
      cleanupSubFiles(videoId);
      try {
        execFileSync(
          ytDlp,
          [
            "--cookies-from-browser",
            browser,
            ...buildYtDlpSubtitleArgs(preferredLanguageCodes),
            "--skip-download",
            "-o",
            outputTemplate,
            "--",
            videoUrl,
          ],
          {
            timeout: 45000,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "ignore"],
          },
        );
      } catch {
        continue;
      }

      const cookiePathSegments = tryReadDownloadedSubtitles();
      if (cookiePathSegments) {
        return cookiePathSegments;
      }
    }
  } finally {
    cleanupSubFiles(videoId);
  }

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
  const selection = pickBestSubtitleSource(subs, autoCaps);
  const subSource = selection?.tracks;

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

  try {
    const subtitleResponse = execFileSync("curl", ["-sL", "--", track.url], {
      timeout: 15000,
      encoding: "utf-8",
    }) as string;

    if (!subtitleResponse || subtitleResponse.trim().length === 0) {
      throw new Error("yt-dlp: subtitle URL returned empty or unparseable content");
    }

    const segments = parseSubtitleContent(subtitleResponse);
    if (segments.length > 0) {
      return segments;
    }
  } catch {
    throw new Error("yt-dlp: subtitle URL returned empty or unparseable content");
  }

  throw new Error("yt-dlp: subtitle URL returned empty or unparseable content");
}

async function fetchTranscriptFromYtDlpJsonAsync(
  videoId: string,
): Promise<TranscriptSegment[]> {
  const ytDlp = findYtDlp();
  const result = await execFileAsync(
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
  const selection = pickBestSubtitleSource(subs, autoCaps);
  const subSource = selection?.tracks;

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

  const subtitleResponse = await execFileAsync(
    "curl",
    ["-sL", "--", track.url],
    {
      timeout: 15000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (!subtitleResponse || subtitleResponse.trim().length === 0) {
    throw new Error("yt-dlp: subtitle URL returned empty or unparseable content");
  }

  const segments = parseSubtitleContent(subtitleResponse);
  if (segments.length > 0) {
    return segments;
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
  const includeTitle = options.includeTitle !== false;
  const defaultTitle = `YouTube Video ${videoId}`;
  const titlePromise = includeTitle
    ? fetchVideoTitle(videoId)
    : Promise.resolve(defaultTitle);
  const errors: string[] = [];

  // Strategy 1: race the cheap page path against the more reliable yt-dlp JSON path.
  try {
    const segments = await Promise.any([
      fetchTranscriptFromPage(videoId),
      fetchTranscriptFromYtDlpJsonAsync(videoId),
    ]);
    const title = await titlePromise;
    return { transcript: formatSegments(segments, options), title };
  } catch (e) {
    const errorMessage = e instanceof AggregateError
      ? e.errors
          .map((err) => (err instanceof Error ? err.message : String(err)))
          .join(" | ")
      : e instanceof Error
        ? e.message
        : String(e);
    errors.push(`page/json race: ${errorMessage}`);
  }

  // Strategy 2: yt-dlp direct subtitle download
  try {
    const segments = fetchTranscriptWithYtDlpDownload(videoId);
    const title = await titlePromise;
    return { transcript: formatSegments(segments, options), title };
  } catch (e) {
    errors.push(
      `yt-dlp download: ${e instanceof Error ? e.message : String(e)}`,
    );
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
