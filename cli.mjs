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

import { execFileSync } from "child_process";
import {
  extractVideoId,
  decodeHtmlEntities,
  parseTranscriptXml,
  extractJsonObject,
  formatTimestamp,
  sanitizeMarkdownTitle,
} from "./lib/cli-utils.mjs";

const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_US) gzip";
const FETCH_TIMEOUT = 15000;

function fetchWithTimeout(url, opts = {}) {
  const timeoutMs = opts.timeout || FETCH_TIMEOUT;
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

function pickTrackUrl(tracks) {
  const en = tracks.find((t) => t.languageCode === "en" || t.languageCode.startsWith("en"));
  return (en || tracks[0]).baseUrl;
}

async function fetchCaptionTrack(url, ua = WEB_UA) {
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": ua } });
  if (!response.ok) throw new Error(`Caption track returned ${response.status}`);
  const xml = await response.text();
  if (!xml || xml.length === 0) throw new Error("Caption track returned empty response");
  const segments = parseTranscriptXml(xml);
  if (segments.length === 0) throw new Error("Could not parse caption XML");
  return segments;
}

async function fetchTranscriptFromAndroid(videoId) {
  const response = await fetchWithTimeout("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
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
  const response = await fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}`, {
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
  const result = execFileSync(
    "yt-dlp",
    ["--skip-download", "--dump-json", "--", `https://www.youtube.com/watch?v=${videoId}`],
    { timeout: 45000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] },
  );
  const info = JSON.parse(result);
  const subs = info.subtitles || {};
  const autoCaps = info.automatic_captions || {};
  const subSource = subs["en"] || subs["en-US"] || Object.values(subs)[0] || autoCaps["en"] || autoCaps["en-US"] || Object.values(autoCaps)[0];
  if (!subSource || subSource.length === 0) throw new Error("yt-dlp: no subtitle sources found");
  const track = subSource.find((s) => s.ext === "srv1") || subSource.find((s) => s.ext === "srv3") || subSource.find((s) => s.ext === "vtt") || subSource[0];
  if (!track?.url) throw new Error("yt-dlp: no subtitle track URL");
  const subResp = execFileSync("curl", ["-sL", "--", track.url], {
    timeout: 15000,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!subResp || subResp.trim().length === 0) throw new Error("yt-dlp: subtitle URL returned empty");
  const segments = parseTranscriptXml(subResp);
  if (segments.length > 0) return segments;
  throw new Error("yt-dlp: could not parse subtitle content");
}

async function fetchVideoTitle(videoId) {
  try {
    const response = await fetchWithTimeout(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (response.ok) {
      const data = await response.json();
      return data.title || `YouTube Video ${videoId}`;
    }
  } catch {}
  return `YouTube Video ${videoId}`;
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
    const safeTitle = sanitizeMarkdownTitle(title);
    const text = timestamps
      ? segments.map((s) => `[${formatTimestamp(s.start)}] ${decodeHtmlEntities(s.text).trim()}`).join("\n")
      : decodeHtmlEntities(segments.map((s) => s.text).join(" ")).trim();
    console.log(`# ${safeTitle}\n\n**URL:** https://youtube.com/watch?v=${videoId}\n**Method:** ${method}\n\n---\n\n${text}\n\n---\n\n*Generated by FastyTranscript CLI*`);
  }
}

main();
