import { decodeHtmlEntities, sanitizeMarkdownTitle } from "./cli-utils.mjs";

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

export function sanitizeFilename(title) {
  return title
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 80);
}

export function formatTranscriptMarkdown(title, videoId, transcript) {
  const safeTitle = sanitizeMarkdownTitle(title);
  return `# ${safeTitle}\n\n**URL:** https://youtube.com/watch?v=${videoId}\n\n---\n\n${transcript}\n`;
}
