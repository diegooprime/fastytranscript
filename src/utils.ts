import { execSync } from "child_process";

const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_US) gzip";

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
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    );
    if (response.ok) {
      const data = (await response.json()) as { title?: string };
      return data.title || `YouTube Video ${videoId}`;
    }
  } catch {
    // Fallback
  }
  return `YouTube Video ${videoId}`;
}

// Decode HTML entities
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
    .replace(/\s+/g, " ");
}

// Parse transcript XML - handles both srv1 (<text>) and srv3 (<p>/<s>) formats
function parseTranscriptXml(xml: string): string[] {
  // srv1 format: <text start="..." dur="...">content</text>
  const srv1Re = /<text[^>]*>([^<]*)<\/text>/g;
  const srv1Segments: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = srv1Re.exec(xml)) !== null) {
    if (m[1].trim()) srv1Segments.push(m[1]);
  }
  if (srv1Segments.length > 0) return srv1Segments;

  // srv3 format: <p t="..." d="..."><s>word</s>...</p>
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/g;
  const srv3Segments: string[] = [];
  while ((m = pRe.exec(xml)) !== null) {
    const inner = m[1];
    // Extract text from <s> tags within each <p>
    const words: string[] = [];
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let s: RegExpExecArray | null;
    while ((s = sRe.exec(inner)) !== null) {
      if (s[1]) words.push(s[1]);
    }
    if (words.length > 0) {
      srv3Segments.push(words.join(""));
    } else {
      // Fallback: strip all tags and use raw text
      const stripped = inner.replace(/<[^>]+>/g, "").trim();
      if (stripped) srv3Segments.push(stripped);
    }
  }
  return srv3Segments;
}

// Extract a JSON object from a string starting at '{' using brace counting
function extractJsonObject(str: string, startIdx: number): string | null {
  if (str[startIdx] !== "{") return null;
  let depth = 0;
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") depth--;
    if (depth === 0) return str.substring(startIdx, i + 1);
  }
  return null;
}

type CaptionTrack = { baseUrl: string; languageCode: string };

// Pick the best caption track (prefer English)
function pickTrackUrl(tracks: CaptionTrack[]): string {
  const en = tracks.find((t) => t.languageCode === "en" || t.languageCode.startsWith("en"));
  return (en || tracks[0]).baseUrl;
}

// Fetch and parse a caption track URL
async function fetchCaptionTrack(url: string, ua: string = WEB_UA): Promise<string[]> {
  const response = await fetch(url, {
    headers: { "User-Agent": ua },
  });
  if (!response.ok) throw new Error(`Caption track returned ${response.status}`);
  const xml = await response.text();
  if (!xml || xml.length === 0) throw new Error("Caption track returned empty response");
  const segments = parseTranscriptXml(xml);
  if (segments.length === 0) throw new Error("Could not parse caption XML");
  return segments;
}

// Strategy 1: InnerTube ANDROID client (most reliable - bypasses web restrictions)
async function fetchTranscriptFromAndroid(videoId: string): Promise<string[]> {
  const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ANDROID_UA,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.09.37",
          androidSdkVersion: 31,
          hl: "en",
          gl: "US",
          userAgent: ANDROID_UA,
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });

  if (!response.ok) throw new Error(`ANDROID API returned ${response.status}`);

  const data = (await response.json()) as Record<string, unknown>;
  const captions = data.captions as Record<string, unknown> | undefined;
  if (!captions) throw new Error("ANDROID: no captions in response");

  const tracklist = captions.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  if (!tracklist) throw new Error("ANDROID: no caption tracklist");

  const tracks = tracklist.captionTracks as CaptionTrack[] | undefined;
  if (!tracks || tracks.length === 0) throw new Error("ANDROID: no caption tracks");

  return await fetchCaptionTrack(pickTrackUrl(tracks), ANDROID_UA);
}

// Strategy 2: Scrape YouTube page for ytInitialPlayerResponse
async function fetchTranscriptFromPage(videoId: string): Promise<string[]> {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": WEB_UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!response.ok) throw new Error(`YouTube page returned ${response.status}`);

  const html = await response.text();
  if (html.includes('class="g-recaptcha"')) throw new Error("Rate limited (captcha)");

  // Find ytInitialPlayerResponse and extract full JSON via brace counting
  const marker = html.match(/ytInitialPlayerResponse\s*=\s*\{/);
  if (marker && marker.index !== undefined) {
    const braceStart = html.indexOf("{", marker.index);
    const jsonStr = extractJsonObject(html, braceStart);
    if (jsonStr) {
      try {
        const pr = JSON.parse(jsonStr) as Record<string, unknown>;
        const captions = pr.captions as Record<string, unknown> | undefined;
        const tracklist = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
        const tracks = tracklist?.captionTracks as CaptionTrack[] | undefined;
        if (tracks && tracks.length > 0) {
          return await fetchCaptionTrack(pickTrackUrl(tracks));
        }
      } catch {
        // Parse failed
      }
    }
  }

  // Fallback: split on "captions":
  const parts = html.split('"captions":');
  if (parts.length > 1) {
    const braceIdx = parts[1].indexOf("{");
    if (braceIdx !== -1) {
      const captionsJson = extractJsonObject(parts[1], braceIdx);
      if (captionsJson) {
        try {
          const obj = JSON.parse(captionsJson) as Record<string, unknown>;
          const tracklist = obj.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
          const tracks = tracklist?.captionTracks as CaptionTrack[] | undefined;
          if (tracks && tracks.length > 0) {
            return await fetchCaptionTrack(pickTrackUrl(tracks));
          }
        } catch {
          // Parse failed
        }
      }
    }
  }

  if (!html.includes('"playabilityStatus":')) throw new Error("Video is unavailable");
  throw new Error("Could not extract captions from page");
}

// Strategy 3: yt-dlp fallback
function fetchTranscriptFromYtDlp(videoId: string): string[] {
  // Get video metadata including subtitle URLs
  const result = execSync(
    `yt-dlp --skip-download --dump-json "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 45000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );

  const info = JSON.parse(result) as {
    subtitles?: Record<string, Array<{ url: string; ext: string }>>;
    automatic_captions?: Record<string, Array<{ url: string; ext: string }>>;
  };

  const subs = info.subtitles || {};
  const autoCaps = info.automatic_captions || {};

  // Prefer manual English subs, then any manual subs, then auto English, then any auto
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

  // Prefer srv1 format (standard XML), then srv2, srv3, vtt
  const track =
    subSource.find((s) => s.ext === "srv1") ||
    subSource.find((s) => s.ext === "srv2") ||
    subSource.find((s) => s.ext === "srv3") ||
    subSource.find((s) => s.ext === "vtt") ||
    subSource[0];

  if (!track?.url) throw new Error("yt-dlp: no subtitle track URL");

  const subResp = execSync(`curl -sL "${track.url}"`, {
    timeout: 15000,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (!subResp || subResp.trim().length === 0) {
    throw new Error("yt-dlp: subtitle URL returned empty");
  }

  // Try XML parsing first
  const segments = parseTranscriptXml(subResp);
  if (segments.length > 0) return segments;

  // If VTT format, parse that
  if (subResp.includes("WEBVTT")) {
    const lines = subResp.split("\n");
    const textLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed === "WEBVTT" ||
        trimmed.startsWith("Kind:") ||
        trimmed.startsWith("Language:") ||
        trimmed.startsWith("NOTE") ||
        /^\d+$/.test(trimmed) ||
        /-->/.test(trimmed)
      ) {
        continue;
      }
      const cleaned = trimmed.replace(/<[^>]+>/g, "").trim();
      if (cleaned && !textLines.includes(cleaned)) textLines.push(cleaned);
    }
    if (textLines.length > 0) return textLines;
  }

  throw new Error("yt-dlp: could not parse subtitle content");
}

// Main: try all strategies in order
export async function getVideoTranscript(videoId: string): Promise<{ transcript: string; title: string }> {
  const titlePromise = fetchVideoTitle(videoId);
  const errors: string[] = [];

  // Strategy 1: ANDROID InnerTube API (fastest, most reliable)
  try {
    const segments = await fetchTranscriptFromAndroid(videoId);
    const title = await titlePromise;
    return { transcript: joinSegments(segments), title };
  } catch (e) {
    errors.push(`ANDROID API: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Strategy 2: HTML page scraping
  try {
    const segments = await fetchTranscriptFromPage(videoId);
    const title = await titlePromise;
    return { transcript: joinSegments(segments), title };
  } catch (e) {
    errors.push(`Page scraping: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Strategy 3: yt-dlp
  try {
    const segments = fetchTranscriptFromYtDlp(videoId);
    const title = await titlePromise;
    return { transcript: joinSegments(segments), title };
  } catch (e) {
    errors.push(`yt-dlp: ${e instanceof Error ? e.message : String(e)}`);
  }

  throw new Error(`No transcript available. All methods failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
}

function joinSegments(segments: string[]): string {
  return decodeHtmlEntities(segments.join(" ")).trim();
}

// Format transcript as Markdown
export function formatTranscriptAsMarkdown(transcript: string, videoId: string, title: string): string {
  return `# ${title}

**URL:** https://youtube.com/watch?v=${videoId}

---

${transcript}

---

*Generated by FastyTranscript*`;
}
