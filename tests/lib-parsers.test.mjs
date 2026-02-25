import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeHtmlEntities,
  vttToPlainText,
  sanitizeFilename,
  formatTranscriptMarkdown,
} from "../lib/parsers.mjs";

// ── lib/parsers.mjs — full coverage ─────────────────────────────────────────

describe("lib/parsers decodeHtmlEntities", () => {
  it("decodes &amp; to &", () => {
    assert.equal(decodeHtmlEntities("a &amp; b"), "a & b");
  });

  it("decodes &lt; and &gt;", () => {
    assert.equal(decodeHtmlEntities("&lt;div&gt;"), "<div>");
  });

  it("decodes &#39; to apostrophe", () => {
    assert.equal(decodeHtmlEntities("it&#39;s"), "it's");
  });

  it("decodes &quot; to double quote", () => {
    assert.equal(decodeHtmlEntities("&quot;hi&quot;"), '"hi"');
  });

  it("handles text with no entities", () => {
    assert.equal(decodeHtmlEntities("plain text"), "plain text");
  });

  it("handles empty string", () => {
    assert.equal(decodeHtmlEntities(""), "");
  });

  it("handles all entities combined", () => {
    assert.equal(
      decodeHtmlEntities("&#39;&quot;&amp;&lt;&gt;"),
      "'\"&<>",
    );
  });
});

describe("lib/parsers vttToPlainText", () => {
  it("strips WEBVTT header", () => {
    const vtt = "WEBVTT\n\nHello world";
    assert.equal(vttToPlainText(vtt), "Hello world");
  });

  it("strips Kind and Language headers", () => {
    const vtt = "WEBVTT\nKind: captions\nLanguage: en\n\nHello world";
    assert.equal(vttToPlainText(vtt), "Hello world");
  });

  it("strips timestamp lines (-->)", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world\n\n00:00:05.000 --> 00:00:10.000\nSecond line";
    assert.equal(vttToPlainText(vtt), "Hello world Second line");
  });

  it("strips HTML tags from text lines", () => {
    const vtt = "WEBVTT\n\n<c.colorE5E5E5>Hello</c> <c>world</c>";
    assert.equal(vttToPlainText(vtt), "Hello world");
  });

  it("deduplicates repeated lines", () => {
    const vtt = "WEBVTT\n\nHello\nHello\nWorld";
    assert.equal(vttToPlainText(vtt), "Hello World");
  });

  it("decodes HTML entities in VTT text", () => {
    const vtt = "WEBVTT\n\nit&#39;s &amp; good";
    assert.equal(vttToPlainText(vtt), "it's & good");
  });

  it("returns empty string for empty VTT", () => {
    assert.equal(vttToPlainText("WEBVTT\n\n"), "");
  });

  it("collapses multiple spaces", () => {
    const vtt = "WEBVTT\n\nhello    world";
    assert.equal(vttToPlainText(vtt), "hello world");
  });

  it("skips blank lines", () => {
    const vtt = "WEBVTT\n\n\n\nHello\n\n\nWorld";
    assert.equal(vttToPlainText(vtt), "Hello World");
  });
});

describe("lib/parsers sanitizeFilename", () => {
  it("removes special characters", () => {
    assert.equal(sanitizeFilename("hello!@#$world"), "helloworld");
  });

  it("replaces spaces with underscores", () => {
    assert.equal(sanitizeFilename("hello world"), "hello_world");
  });

  it("collapses multiple spaces to single underscore", () => {
    assert.equal(sanitizeFilename("hello   world"), "hello_world");
  });

  it("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    assert.equal(sanitizeFilename(long).length, 80);
  });

  it("preserves hyphens and underscores", () => {
    assert.equal(sanitizeFilename("hello-world_test"), "hello-world_test");
  });

  it("handles empty string", () => {
    assert.equal(sanitizeFilename(""), "");
  });

  it("preserves alphanumeric characters", () => {
    assert.equal(sanitizeFilename("abc123XYZ"), "abc123XYZ");
  });
});

describe("lib/parsers formatTranscriptMarkdown", () => {
  it("formats markdown with title, URL, and transcript", () => {
    const result = formatTranscriptMarkdown("My Video", "abc123", "transcript text");
    assert.ok(result.includes("# My Video"));
    assert.ok(result.includes("https://youtube.com/watch?v=abc123"));
    assert.ok(result.includes("transcript text"));
  });

  it("includes URL line", () => {
    const result = formatTranscriptMarkdown("Title", "vid1", "text");
    assert.ok(result.includes("**URL:** https://youtube.com/watch?v=vid1"));
  });

  it("includes horizontal rules", () => {
    const result = formatTranscriptMarkdown("Title", "vid1", "text");
    assert.ok(result.includes("---"));
  });
});
