import { Detail, Clipboard, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { extractVideoId, getVideoTranscript, formatTranscriptAsMarkdown } from "./utils";

export default function Command() {
  const [markdown, setMarkdown] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchTranscript() {
      try {
        // Read from clipboard
        let videoUrl: string | null = null;
        try {
          const clipboardText = await Clipboard.readText();
          if (clipboardText && extractVideoId(clipboardText)) {
            videoUrl = clipboardText;
          }
        } catch {
          // Clipboard read failed
        }

        if (!videoUrl) {
          setMarkdown("# ❌ No YouTube URL Found\n\nCopy a YouTube URL to your clipboard, then try again.");
          setIsLoading(false);
          return;
        }

        const videoId = extractVideoId(videoUrl);
        if (!videoId) {
          setMarkdown(`# ❌ Invalid URL\n\nNot a valid YouTube link.\n\n**URL:** ${videoUrl}`);
          setIsLoading(false);
          return;
        }

        // Fetch transcript
        let result;
        try {
          result = await getVideoTranscript(videoId);
        } catch (fetchError) {
          const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
          setMarkdown(
            `# ❌ Error\n\n${msg}\n\n**Video ID:** ${videoId}\n**URL:** https://youtube.com/watch?v=${videoId}`,
          );
          setIsLoading(false);
          return;
        }

        const { transcript, title } = result;

        // Format as Markdown
        const markdownContent = formatTranscriptAsMarkdown(transcript, videoId, title);

        // Copy to clipboard
        await Clipboard.copy(markdownContent);

        await showToast({
          style: Toast.Style.Success,
          title: "Copied to clipboard!",
        });

        setMarkdown(markdownContent);
        setIsLoading(false);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setMarkdown(`# ❌ Error\n\n${errorMessage}`);
        setIsLoading(false);
      }
    }

    fetchTranscript();
  }, []);

  return <Detail isLoading={isLoading} markdown={isLoading ? "" : markdown} />;
}
