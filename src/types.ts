export type TranscriptSegment = {
  text: string;
  start: number;
  duration: number;
};

export type TranscriptOptions = {
  timestamps?: boolean;
  includeTitle?: boolean;
};

export type TranscriptResult = {
  transcript: string;
  title: string;
};

export type YtDlpSubtitleTrack = {
  url: string;
  ext: string;
};

export type YtDlpSubtitleTrackMap = Record<string, YtDlpSubtitleTrack[]>;

export type YtDlpInfo = {
  subtitles?: YtDlpSubtitleTrackMap;
  automatic_captions?: YtDlpSubtitleTrackMap;
};

export type YouTubeOEmbedResponse = {
  title?: string;
};
