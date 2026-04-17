import {
  Clipboard,
  closeMainWindow,
  getPreferenceValues,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { extractVideoId, getVideoTranscript } from "./utils";

export default async function Command() {
  try {
    await closeMainWindow({ clearRootSearch: true });

    const clipboardText = await Clipboard.readText();
    const videoId = clipboardText ? extractVideoId(clipboardText) : null;

    if (!videoId) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No YouTube URL in clipboard",
      });
      return;
    }

    const prefs = getPreferenceValues<{ includeTimestamps: boolean }>();
    const { transcript } = await getVideoTranscript(videoId, {
      timestamps: prefs.includeTimestamps,
      includeTitle: false,
    });

    await Clipboard.copy(transcript);
    await showHUD("Transcript copied");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showToast({
      style: Toast.Style.Failure,
      title: "Transcript failed",
      message,
    });
  }
}
