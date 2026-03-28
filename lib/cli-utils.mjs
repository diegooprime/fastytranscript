/**
 * Shared pure utility functions for CLI and tests.
 * Single source of truth — imported by cli.mjs and test files.
 */

export function extractVideoId(url) {
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

export function decodeHtmlEntities(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
    .replace(/&amp;/g, "&") // must be last to avoid double-decoding &amp;lt; → <
    .replace(/\s+/g, " ");
}

export function parseTranscriptXml(xml) {
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

export function extractJsonObject(str, startIdx) {
  if (str[startIdx] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = inString; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) return str.substring(startIdx, i + 1);
  }
  return null;
}

export function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function sanitizeMarkdownTitle(title) {
  return title.replace(/[<#\[\]()\\`*_{}!|~>]/g, "\\$&").replace(/\n/g, " ");
}
