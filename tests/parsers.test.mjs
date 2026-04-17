import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractVideoId,
  decodeHtmlEntities,
  parseTranscriptXml,
  extractJsonObject,
  sanitizeMarkdownTitle,
} from "../lib/cli-utils.mjs";

describe("extractVideoId", () => {
  it("parses standard watch URL", () => {
    assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses short youtu.be URL", () => {
    assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses embed URL", () => {
    assert.equal(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("parses shorts URL", () => {
    assert.equal(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("accepts bare 11-char video ID", () => {
    assert.equal(extractVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("handles URL without https://", () => {
    assert.equal(extractVideoId("www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("handles URL without www.", () => {
    assert.equal(extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("handles IDs with hyphens and underscores", () => {
    assert.equal(extractVideoId("abc_DEF-123"), "abc_DEF-123");
  });

  it("returns null for invalid URLs", () => {
    assert.equal(extractVideoId("not a url at all"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(extractVideoId(""), null);
  });

  it("returns null for wrong-length bare IDs", () => {
    assert.equal(extractVideoId("short"), null);
    assert.equal(extractVideoId("waytoolongtobeavalidid"), null);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes &#39; to apostrophe", () => {
    assert.equal(decodeHtmlEntities("don&#39;t"), "don't");
  });

  it("decodes &quot; to double quote", () => {
    assert.equal(decodeHtmlEntities("&quot;hello&quot;"), '"hello"');
  });

  it("decodes &amp; to ampersand", () => {
    assert.equal(decodeHtmlEntities("a &amp; b"), "a & b");
  });

  it("decodes &lt; and &gt;", () => {
    assert.equal(decodeHtmlEntities("&lt;tag&gt;"), "<tag>");
  });

  it("decodes &nbsp; to space", () => {
    assert.equal(decodeHtmlEntities("hello&nbsp;world"), "hello world");
  });

  it("decodes numeric entities", () => {
    assert.equal(decodeHtmlEntities("&#65;&#66;&#67;"), "ABC");
  });

  it("collapses whitespace", () => {
    assert.equal(decodeHtmlEntities("hello   world"), "hello world");
  });

  it("handles mixed entities", () => {
    assert.equal(
      decodeHtmlEntities("it&#39;s &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;"),
      'it\'s <b>bold</b> & "quoted"',
    );
  });

  it("does not double-decode &amp;lt; into <", () => {
    assert.equal(decodeHtmlEntities("&amp;lt;"), "&lt;");
  });

  it("does not double-decode &amp;amp; into &", () => {
    assert.equal(decodeHtmlEntities("&amp;amp;"), "&amp;");
  });
});

describe("sanitizeMarkdownTitle", () => {
  it("escapes markdown-sensitive characters and normalizes newlines", () => {
    assert.equal(sanitizeMarkdownTitle("Hello <world>\nline_two"), "Hello \\<world\\> line\\_two");
  });
});

describe("parseTranscriptXml – srv1 format", () => {
  it("parses standard srv1 XML with start/duration", () => {
    const xml = `<transcript><text start="0" dur="5">Hello world</text><text start="5" dur="3">Second line</text></transcript>`;
    const result = parseTranscriptXml(xml);
    assert.equal(result.length, 2);
    assert.equal(result[0].text, "Hello world");
    assert.equal(result[0].start, 0);
    assert.equal(result[0].duration, 5);
    assert.equal(result[1].text, "Second line");
    assert.equal(result[1].start, 5);
    assert.equal(result[1].duration, 3);
  });

  it("skips empty segments", () => {
    const xml = `<transcript><text start="0" dur="5">Hello</text><text start="5" dur="3">   </text><text start="8" dur="2">World</text></transcript>`;
    const result = parseTranscriptXml(xml);
    assert.equal(result.length, 2);
    assert.equal(result[0].text, "Hello");
    assert.equal(result[1].text, "World");
  });

  it("handles entities in srv1 content (raw, not decoded)", () => {
    const xml = `<transcript><text start="0" dur="5">it&#39;s &amp; good</text></transcript>`;
    const result = parseTranscriptXml(xml);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "it&#39;s &amp; good");
  });
});

describe("parseTranscriptXml – srv3 format", () => {
  it("parses srv3 XML with <s> tags", () => {
    const xml = `<timedtext><body><p t="0" d="5000"><s>Hello </s><s>world</s></p><p t="5000" d="3000"><s>Second</s></p></body></timedtext>`;
    const result = parseTranscriptXml(xml);
    assert.equal(result.length, 2);
    assert.equal(result[0].text, "Hello world");
    assert.equal(result[0].start, 0);
    assert.equal(result[0].duration, 5);
    assert.equal(result[1].text, "Second");
    assert.equal(result[1].start, 5);
    assert.equal(result[1].duration, 3);
  });

  it("falls back to stripped text when no <s> tags", () => {
    const xml = `<timedtext><body><p t="0" d="5000">Plain text here</p></body></timedtext>`;
    const result = parseTranscriptXml(xml);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "Plain text here");
  });

  it("handles multiple <s> tags per <p>", () => {
    const xml = `<timedtext><body><p t="0" d="5000"><s>one </s><s>two </s><s>three</s></p></body></timedtext>`;
    const result = parseTranscriptXml(xml);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "one two three");
  });
});

describe("parseTranscriptXml – edge cases", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(parseTranscriptXml(""), []);
  });

  it("returns empty array for non-XML content", () => {
    assert.deepEqual(parseTranscriptXml("just some text"), []);
  });

  it("returns empty array for malformed XML", () => {
    assert.deepEqual(parseTranscriptXml("<text>unclosed"), []);
  });

  it("returns empty array for XML with no matching tags", () => {
    assert.deepEqual(parseTranscriptXml("<root><item>data</item></root>"), []);
  });
});

describe("extractJsonObject", () => {
  it("extracts simple JSON object", () => {
    const str = 'var x = {"key": "value"};';
    const idx = str.indexOf("{");
    assert.equal(extractJsonObject(str, idx), '{"key": "value"}');
  });

  it("handles nested braces", () => {
    const str = '{"a": {"b": {"c": 1}}}';
    assert.equal(extractJsonObject(str, 0), '{"a": {"b": {"c": 1}}}');
  });

  it("returns null when start char is not {", () => {
    assert.equal(extractJsonObject("hello", 0), null);
  });

  it("returns null for unclosed brace", () => {
    assert.equal(extractJsonObject("{unclosed", 0), null);
  });

  it("extracts object from middle of string", () => {
    const str = 'prefix {"x": 1} suffix';
    const idx = str.indexOf("{");
    assert.equal(extractJsonObject(str, idx), '{"x": 1}');
  });

  it("handles braces inside JSON string values", () => {
    const str = '{"key": "value with { and } inside"}';
    assert.equal(extractJsonObject(str, 0), str);
  });

  it("handles escaped quotes inside strings", () => {
    const str = '{"key": "value with \\"quotes\\" and {braces}"}';
    assert.equal(extractJsonObject(str, 0), str);
  });

  it("handles complex nested JSON with string braces", () => {
    const str = '{"a": {"desc": "use {curly} braces"}, "b": 2}';
    assert.equal(extractJsonObject(str, 0), str);
  });
});
