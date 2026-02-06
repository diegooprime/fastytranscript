#!/usr/bin/env node
/**
 * Multi-strategy stress test for YouTube transcript fetching.
 * Tests each strategy independently against a diverse set of videos.
 *
 * Usage: node tests/strategy-test.mjs
 */

const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_US) gzip";

const TEST_VIDEOS = [
  { id: "dQw4w9WgXcQ", desc: "Popular video (Rick Astley - Never Gonna Give You Up)" },
  { id: "jNQXAC9IVRw", desc: "First YouTube video (Me at the zoo)" },
  { id: "9bZkp7q19f0", desc: "Gangnam Style (high view count)" },
  { id: "kJQP7kiw5Fk", desc: "Despacito (most viewed music video)" },
];

// ── Parsing helpers (mirrored from src/utils.ts) ────────────────────────────

function parseTranscriptXml(xml) {
  const srv1Re = /<text[^>]*>([^<]*)<\/text>/g;
  const srv1Segments = [];
  let m;
  while ((m = srv1Re.exec(xml)) !== null) {
    if (m[1].trim()) srv1Segments.push(m[1]);
  }
  if (srv1Segments.length > 0) return srv1Segments;

  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/g;
  const srv3Segments = [];
  while ((m = pRe.exec(xml)) !== null) {
    const inner = m[1];
    const words = [];
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let s;
    while ((s = sRe.exec(inner)) !== null) {
      if (s[1]) words.push(s[1]);
    }
    if (words.length > 0) {
      srv3Segments.push(words.join(""));
    } else {
      const stripped = inner.replace(/<[^>]+>/g, "").trim();
      if (stripped) srv3Segments.push(stripped);
    }
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

// ── Strategy implementations ────────────────────────────────────────────────

async function strategyAndroid(videoId) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error("No caption tracks");

  const en = tracks.find((t) => t.languageCode === "en" || t.languageCode.startsWith("en"));
  const trackUrl = (en || tracks[0]).baseUrl;

  const capRes = await fetch(trackUrl, { headers: { "User-Agent": ANDROID_UA } });
  if (!capRes.ok) throw new Error(`Caption fetch HTTP ${capRes.status}`);
  const xml = await capRes.text();
  const segments = parseTranscriptXml(xml);
  if (segments.length === 0) throw new Error("Parsed 0 segments");
  return segments;
}

async function strategyPageScrape(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": WEB_UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  if (html.includes('class="g-recaptcha"')) throw new Error("Rate limited (captcha)");

  const marker = html.match(/ytInitialPlayerResponse\s*=\s*\{/);
  if (!marker || marker.index === undefined) throw new Error("No ytInitialPlayerResponse found");

  const braceStart = html.indexOf("{", marker.index);
  const jsonStr = extractJsonObject(html, braceStart);
  if (!jsonStr) throw new Error("Failed to extract JSON object");

  const pr = JSON.parse(jsonStr);
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error("No caption tracks in page data");

  const en = tracks.find((t) => t.languageCode === "en" || t.languageCode.startsWith("en"));
  const trackUrl = (en || tracks[0]).baseUrl;

  const capRes = await fetch(trackUrl, { headers: { "User-Agent": WEB_UA } });
  if (!capRes.ok) throw new Error(`Caption fetch HTTP ${capRes.status}`);
  const xml = await capRes.text();
  const segments = parseTranscriptXml(xml);
  if (segments.length === 0) throw new Error("Parsed 0 segments");
  return segments;
}

async function strategyYtDlp(videoId) {
  const { execSync } = await import("node:child_process");

  // Check if yt-dlp is available
  try {
    execSync("which yt-dlp", { encoding: "utf-8" });
  } catch {
    throw new Error("yt-dlp not installed");
  }

  const result = execSync(
    `yt-dlp --skip-download --dump-json "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 45000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );

  const info = JSON.parse(result);
  const subs = info.subtitles || {};
  const autoCaps = info.automatic_captions || {};

  const subSource =
    subs["en"] || subs["en-US"] || Object.values(subs)[0] ||
    autoCaps["en"] || autoCaps["en-US"] || Object.values(autoCaps)[0];

  if (!subSource || subSource.length === 0) throw new Error("No subtitle sources");

  const track =
    subSource.find((s) => s.ext === "srv1") ||
    subSource.find((s) => s.ext === "srv3") ||
    subSource.find((s) => s.ext === "vtt") ||
    subSource[0];

  if (!track?.url) throw new Error("No subtitle track URL");

  const subResp = execSync(`curl -sL "${track.url}"`, {
    timeout: 15000,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const segments = parseTranscriptXml(subResp);
  if (segments.length > 0) return segments;

  // VTT fallback
  if (subResp.includes("WEBVTT")) {
    const lines = subResp.split("\n");
    const textLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed || trimmed === "WEBVTT" ||
        trimmed.startsWith("Kind:") || trimmed.startsWith("Language:") ||
        trimmed.startsWith("NOTE") || /^\d+$/.test(trimmed) || /-->/.test(trimmed)
      ) continue;
      const cleaned = trimmed.replace(/<[^>]+>/g, "").trim();
      if (cleaned && !textLines.includes(cleaned)) textLines.push(cleaned);
    }
    if (textLines.length > 0) return textLines;
  }

  throw new Error("Could not parse subtitle content");
}

// ── Runner ──────────────────────────────────────────────────────────────────

const strategies = [
  { name: "ANDROID InnerTube", fn: strategyAndroid },
  { name: "Page Scrape", fn: strategyPageScrape },
  { name: "yt-dlp", fn: strategyYtDlp },
];

async function runTest(strategy, video) {
  const start = performance.now();
  try {
    const segments = await strategy.fn(video.id);
    const elapsed = (performance.now() - start).toFixed(0);
    return { ok: true, segments: segments.length, ms: elapsed, error: null };
  } catch (e) {
    const elapsed = (performance.now() - start).toFixed(0);
    return { ok: false, segments: 0, ms: elapsed, error: e.message };
  }
}

async function main() {
  console.log("YouTube Transcript Strategy Test");
  console.log("=".repeat(80));
  console.log(`Testing ${TEST_VIDEOS.length} videos × ${strategies.length} strategies\n`);

  const results = [];

  for (const video of TEST_VIDEOS) {
    console.log(`\n▶ ${video.desc} (${video.id})`);
    console.log("-".repeat(60));

    for (const strategy of strategies) {
      const result = await runTest(strategy, video);
      results.push({ video: video.id, strategy: strategy.name, ...result });

      const status = result.ok ? "✓" : "✗";
      const detail = result.ok
        ? `${result.segments} segments in ${result.ms}ms`
        : `FAILED (${result.ms}ms): ${result.error}`;
      console.log(`  ${status} ${strategy.name.padEnd(20)} ${detail}`);
    }
  }

  // Summary table
  console.log("\n\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const header = "Strategy".padEnd(22) + "Pass".padStart(6) + "Fail".padStart(6) + "Avg ms".padStart(10);
  console.log(header);
  console.log("-".repeat(header.length));

  for (const strategy of strategies) {
    const rows = results.filter((r) => r.strategy === strategy.name);
    const pass = rows.filter((r) => r.ok).length;
    const fail = rows.filter((r) => !r.ok).length;
    const avgMs = rows.length > 0
      ? (rows.reduce((sum, r) => sum + parseInt(r.ms), 0) / rows.length).toFixed(0)
      : "-";
    console.log(
      strategy.name.padEnd(22) +
      String(pass).padStart(6) +
      String(fail).padStart(6) +
      String(avgMs).padStart(10),
    );
  }

  const totalPass = results.filter((r) => r.ok).length;
  const totalTests = results.length;
  console.log("-".repeat(header.length));
  console.log(`Total: ${totalPass}/${totalTests} passed`);

  // Exit with failure if any strategy had zero successes
  const allFailed = strategies.some((s) => {
    const rows = results.filter((r) => r.strategy === s.name);
    return rows.every((r) => !r.ok);
  });
  if (allFailed) {
    console.log("\n⚠  At least one strategy failed on ALL videos!");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
