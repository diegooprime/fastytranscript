#!/usr/bin/env node
/**
 * FastyTranscript CLI — standalone YouTube transcript fetcher.
 *
 * Usage:
 *   node cli.mjs <youtube-url-or-id> [--timestamps] [--json]
 *
 * Output: Markdown transcript to stdout (or JSON with --json).
 * Exit codes: 0 = success, 1 = no captions available, 2 = invalid input.
 */

import { execSync } from "child_process";

const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_US) gzip";

function extractVideoId(url) {
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

function decodeHtmlEntities(text) {
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

function parseTranscriptXml(xml) {
  const srv1Re = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([^<]*)<\/text>/g;
  const segments = [];
  let m;
  while ((m = srv1Re.exec(xml)) !== null) {
    if (m[3].trim()) {
      segments.push({ text: m[3], start: parseFloat(m[1]) || 0, duration: parseFloat(m[2]) || 0 });
    }
  }
  if (segments.length > 0) return segments;

  const pRe = /<p\s+t="([^"]*)"(?:\s+d="([^"]*)")?[^>]*>([\s\S]*?)<\/p>/g;
  const srv3Segments = [];
  while ((m = pRe.exec(xml)) !== null) {
    const startMs = parseInt(m[1]) || 0;
    const durMs = parseInt(m[2]) || 0;
    const inner = m[3];
    const words = [];
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let s;
    while ((s = sRe.exec(inner)) !== null) {
      if (s[1]) words.push(s[1]);
    }
    const text = words.length > 0 ? words.join("") : inner.replace(/<[^>]+>/g, "").trim();
    if (text) srv3Segments.push({ text, start: startMs / 1000, duration: durMs / 1000 });
  }
  return srv3Segments;
}

function extractJsonObject(str, startIdx) {
  if (str[startIdx] !== "{") return null;
  let depth = 0;
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") depth--;
    if (depth === 0) return str.substring(startIdx, i + 1);
  }
  return null;
}

function pickTrackUrl(tracks) {
  const en = tracks.find((t) => t.languageCode === "en" || t.languageCode.startsWith("en"));
  return (en || tracks[0]).baseUrl;
}

async function fetchCaptionTrack(url, ua = WEB_UA) {
  const response = await fetch(url, { headers: { "User-Agent": ua } });
  if (!response.ok) throw new Error(`Caption track returned ${response.status}`);
  const xml = await response.text();
  if (!xml || xml.length === 0) throw new Error("Caption track returned empty response");
  const segments = parseTranscriptXml(xml);
  if (segments.length === 0) throw new Error("Could not parse caption XML");
  return segments;
}

async function fetchTranscriptFromAndroid(videoId) {
  const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
    body: JSON.stringify({
      context: {
        client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 31, hl: "en", gl: "US", userAgent: ANDROID_UA },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!response.ok) throw new Error(`ANDROID API returned ${response.status}`);
  const data = await response.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error("ANDROID: no caption tracks");
  return await fetchCaptionTrack(pickTrackUrl(tracks), ANDROID_UA);
}

async function fetchTranscriptFromPage(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": WEB_UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!response.ok) throw new Error(`YouTube page returned ${response.status}`);
  const html = await response.text();
  if (html.includes('class="g-recaptcha"')) throw new Error("Rate limited (captcha)");

  const marker = html.match(/ytInitialPlayerResponse\s*=\s*\{/);
  if (marker && marker.index !== undefined) {
    const braceStart = html.indexOf("{", marker.index);
    const jsonStr = extractJsonObject(html, braceStart);
    if (jsonStr) {
      try {
        const pr = JSON.parse(jsonStr);
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length > 0) return await fetchCaptionTrack(pickTrackUrl(tracks));
      } catch {}
    }
  }

  const parts = html.split('"captions":');
  if (parts.length > 1) {
    const braceIdx = parts[1].indexOf("{");
    if (braceIdx !== -1) {
      const captionsJson = extractJsonObject(parts[1], braceIdx);
      if (captionsJson) {
        try {
          const obj = JSON.parse(captionsJson);
          const tracks = obj?.playerCaptionsTracklistRenderer?.captionTracks;
          if (tracks && tracks.length > 0) return await fetchCaptionTrack(pickTrackUrl(tracks));
        } catch {}
      }
    }
  }

  if (!html.includes('"playabilityStatus":')) throw new Error("Video is unavailable");
  throw new Error("Could not extract captions from page");
}

function fetchTranscriptFromYtDlp(videoId) {
  // SECURITY: videoId is already validated by extractVideoId (alphanumeric + hyphen/underscore only)
  const result = execSync(
    `yt-dlp --skip-download --dump-json -- "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 45000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );
  const info = JSON.parse(result);
  const subs = info.subtitles || {};
  const autoCaps = info.automatic_captions || {};
  const subSource = subs["en"] || subs["en-US"] || Object.values(subs)[0] || autoCaps["en"] || autoCaps["en-US"] || Object.values(autoCaps)[0];
  if (!subSource || subSource.length === 0) throw new Error("yt-dlp: no subtitle sources found");
  const track = subSource.find((s) => s.ext === "srv1") || subSource.find((s) => s.ext === "srv3") || subSource.find((s) => s.ext === "vtt") || subSource[0];
  if (!track?.url) throw new Error("yt-dlp: no subtitle track URL");
  // SECURITY: Use -- to prevent URL from being interpreted as flags
  const subResp = execSync(`curl -sL -- "${track.url}"`, { timeout: 15000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  if (!subResp || subResp.trim().length === 0) throw new Error("yt-dlp: subtitle URL returned empty");
  const segments = parseTranscriptXml(subResp);
  if (segments.length > 0) return segments;
  throw new Error("yt-dlp: could not parse subtitle content");
}

async function fetchVideoTitle(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (response.ok) {
      const data = await response.json();
      return data.title || `YouTube Video ${videoId}`;
    }
  } catch {}
  return `YouTube Video ${videoId}`;
}

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// --- Main ---

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const timestamps = flags.includes("--timestamps");
const jsonOutput = flags.includes("--json");

if (positional.length === 0) {
  console.error("Usage: node cli.mjs <youtube-url-or-id> [--timestamps] [--json]");
  process.exit(2);
}

const videoId = extractVideoId(positional[0]);
if (!videoId) {
  console.error(`Invalid YouTube URL or ID: ${positional[0]}`);
  process.exit(2);
}

const errors = [];

async function main() {
  const titlePromise = fetchVideoTitle(videoId);

  // Strategy 1: ANDROID InnerTube
  try {
    const segments = await fetchTranscriptFromAndroid(videoId);
    const title = await titlePromise;
    output(segments, title, "android");
    return;
  } catch (e) {
    errors.push(`ANDROID: ${e.message}`);
  }

  // Strategy 2: Page scraping
  try {
    const segments = await fetchTranscriptFromPage(videoId);
    const title = await titlePromise;
    output(segments, title, "page");
    return;
  } catch (e) {
    errors.push(`Page: ${e.message}`);
  }

  // Strategy 3: yt-dlp
  try {
    const segments = fetchTranscriptFromYtDlp(videoId);
    const title = await titlePromise;
    output(segments, title, "yt-dlp");
    return;
  } catch (e) {
    errors.push(`yt-dlp: ${e.message}`);
  }

  console.error(`No transcript available. All methods failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  process.exit(1);
}

function output(segments, title, method) {
  if (jsonOutput) {
    console.log(JSON.stringify({ videoId, title, method, segmentCount: segments.length, segments }, null, 2));
  } else {
    const text = timestamps
      ? segments.map((s) => `[${formatTimestamp(s.start)}] ${decodeHtmlEntities(s.text).trim()}`).join("\n")
      : decodeHtmlEntities(segments.map((s) => s.text).join(" ")).trim();
    console.log(`# ${title}\n\n**URL:** https://youtube.com/watch?v=${videoId}\n**Method:** ${method}\n\n---\n\n${text}\n\n---\n\n*Generated by FastyTranscript CLI*`);
  }
}

main();
