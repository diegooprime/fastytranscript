/**
 * Shared parsing utilities for batch transcript scripts.
 */

/**
 * Decode common HTML entities in text.
 * @param {string} text
 * @returns {string}
 */
export function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Convert VTT subtitle content to plain text.
 * Strips metadata lines, timestamps, VTT tags, and deduplicates lines.
 * @param {string} vttContent - Raw VTT file content
 * @returns {string} Plain text transcript
 */
export function vttToPlainText(vttContent) {
  const lines = vttContent.split("\n");
  const textLines = [];
  const seen = new Set();

  for (const line of lines) {
    if (
      line.startsWith("WEBVTT") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.includes("-->") ||
      line.trim() === ""
    ) {
      continue;
    }

    const clean = decodeHtmlEntities(line.replace(/<[^>]+>/g, "")).trim();

    if (clean && !seen.has(clean)) {
      seen.add(clean);
      textLines.push(clean);
    }
  }

  return textLines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Sanitize a string for use as a filename.
 * Removes special characters, replaces spaces with underscores, and truncates.
 * @param {string} title
 * @returns {string}
 */
export function sanitizeFilename(title) {
  return title
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 80);
}

/**
 * Format a transcript as a Markdown document.
 * @param {string} title - Video title
 * @param {string} videoId - YouTube video ID
 * @param {string} transcript - Plain text transcript
 * @returns {string} Markdown-formatted transcript
 */
export function formatTranscriptMarkdown(title, videoId, transcript) {
  return `# ${title}\n\n**URL:** https://youtube.com/watch?v=${videoId}\n\n---\n\n${transcript}\n`;
}
