import {
  Detail,
  Clipboard,
  showToast,
  Toast,
  getPreferenceValues,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
  extractVideoId,
  getVideoTranscript,
  formatTranscriptAsMarkdown,
} from "./utils";

export default function Command() {
  const [markdown, setMarkdown] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchTranscript() {
      try {
        const clipboardText = await Clipboard.readText();
        const videoId = clipboardText ? extractVideoId(clipboardText) : null;

        if (!videoId) {
          setMarkdown(
            "# ❌ No YouTube URL Found\n\nCopy a YouTube URL to your clipboard, then try again.",
          );
          return;
        }

        const prefs = getPreferenceValues<{ includeTimestamps: boolean }>();
        const { transcript, title } = await getVideoTranscript(videoId, {
          timestamps: prefs.includeTimestamps,
        });

        const markdownContent = formatTranscriptAsMarkdown(
          transcript,
          videoId,
          title,
        );

        await Clipboard.copy(markdownContent);
        setMarkdown(markdownContent);

        void showToast({
          style: Toast.Style.Success,
          title: "Copied to clipboard!",
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setMarkdown(`# ❌ Error\n\n${errorMessage}`);
      } finally {
        setIsLoading(false);
      }
    }

    void fetchTranscript();
  }, []);

  return <Detail isLoading={isLoading} markdown={isLoading ? "" : markdown} />;
}
