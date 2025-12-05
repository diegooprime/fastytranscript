# Implementation Plan: YouTube Transcript Extension Improvements

## 🎯 Objectives
- Make extension **10x faster** by replacing yt-dlp with native npm package
- Add **clipboard auto-detection** for zero-friction usage
- Add **browser tab detection** for instant URL capture
- Add **timestamp support** for partial transcript extraction
- Switch to **Markdown format** with proper formatting
- Change default to **copy-to-clipboard** for faster workflow
- Add **granular progress indicators** for better UX

---

## 📊 Current State Analysis

### Performance Bottlenecks
- `yt-dlp` spawns child process (~2-3s overhead)
- Sequential title + transcript fetching (utils.ts:164, 235)
- File I/O operations for temp VTT files (utils.ts:201-226)
- No caching mechanism

### Current Dependencies
- `yt-dlp` (external binary, requires separate installation)
- `which` (for binary path resolution)
- `@raycast/api` + `@raycast/utils`

### Current User Flow
1. User manually pastes YouTube URL
2. Waits for single "Fetching..." toast
3. Transcript saves to file (txt format)
4. Manual navigation to Downloads folder

---

## 🚀 Phase 1: Replace yt-dlp with Fast npm Package

### Goal
Eliminate external binary dependency, achieve ~10x speed improvement

### Tasks
- [ ] Install `youtube-transcript` npm package
- [ ] Remove `yt-dlp` related code from utils.ts
- [ ] Remove `which` dependency
- [ ] Rewrite `getYouTubeTranscriptAsPlainText()` function
- [ ] Rewrite `getVideoTranscript()` function
- [ ] Remove VTT processing logic (no longer needed)
- [ ] Update error handling for new API
- [ ] Test transcript fetching for various video types

### Files to Modify
- `package.json` - add `youtube-transcript`, remove `which`
- `src/utils.ts` - complete rewrite of transcript fetching logic
- `src/fetch-youtube-transcript.tsx` - update error messages

### Expected Performance Gain
- **Before**: ~5-8 seconds average
- **After**: ~0.5-1 second average
- **Improvement**: 5-10x faster

---

## 📋 Phase 2: Clipboard & Browser Auto-Detection

### Goal
Enable zero-typing workflow - auto-detect URL from clipboard or browser

### Tasks
- [ ] Add clipboard text reading on command launch
- [ ] Validate clipboard content for YouTube URLs
- [ ] Research browser tab URL detection methods for macOS
- [ ] Implement Safari tab URL detection (via AppleScript)
- [ ] Implement Chrome/Brave tab URL detection
- [ ] Implement Arc browser tab URL detection
- [ ] Create fallback priority: Browser Tab → Clipboard → Manual Input
- [ ] Update command arguments to make URL optional
- [ ] Add preference for "auto-detect source priority"

### Files to Modify
- `src/utils.ts` - add browser detection utilities
- `src/fetch-youtube-transcript.tsx` - add auto-detection logic
- `package.json` - update command arguments

### Browser Detection Approaches
```typescript
// Safari: osascript -e 'tell application "Safari" to return URL of current tab of front window'
// Chrome: osascript -e 'tell application "Google Chrome" to return URL of active tab of front window'
// Arc: osascript -e 'tell application "Arc" to return URL of active tab of front window'
// Brave: osascript -e 'tell application "Brave Browser" to return URL of active tab of front window'
```

### User Flow (New)
1. User watches YouTube video
2. Triggers Raycast command
3. Extension auto-detects URL from browser
4. Transcript instantly copies to clipboard
5. Total time: <2 seconds

---

## ⏱️ Phase 3: Timestamp Support

### Goal
Allow users to extract transcript segments (e.g., "2:30 to 5:45")

### Tasks
- [ ] Add `startTime` optional argument (text input)
- [ ] Add `endTime` optional argument (text input)
- [ ] Create time parser utility (supports "1:30", "90", "90s" formats)
- [ ] Filter transcript entries by timestamp range
- [ ] Handle edge cases (start > end, invalid times, out of bounds)
- [ ] Update Markdown output to show timestamp range
- [ ] Add tests for time parsing logic

### Files to Modify
- `package.json` - add new arguments
- `src/utils.ts` - add time parsing and filtering utilities
- `src/interfaces.ts` - add TimeRange interface
- `src/fetch-youtube-transcript.tsx` - integrate timestamp filtering

### Time Format Support
- **"1:30"** → 90 seconds
- **"90"** → 90 seconds
- **"90s"** → 90 seconds
- **"1:30:45"** → 5445 seconds (1h 30m 45s)

### Transcript Entry Structure
```typescript
interface TranscriptEntry {
  text: string;
  offset: number;  // milliseconds
  duration: number; // milliseconds
}
```

---

## 📝 Phase 4: Markdown Format Conversion

### Goal
Output clean, formatted Markdown instead of plain text

### Tasks
- [ ] Create Markdown formatter function
- [ ] Add video title as H1 header
- [ ] Add metadata section (video ID, language, duration, timestamp range)
- [ ] Format transcript text with proper paragraphs (group by natural pauses)
- [ ] Add optional timestamps as H2 headers every 30 seconds
- [ ] Add horizontal rules between sections
- [ ] Test rendering in various Markdown viewers
- [ ] Update file extension logic (.txt → .md)

### Files to Modify
- `src/utils.ts` - add `formatTranscriptAsMarkdown()` function
- `src/fetch-youtube-transcript.tsx` - integrate Markdown formatting
- `src/interfaces.ts` - update TranscriptResult interface

### Markdown Template
```markdown
# [Video Title]

**Video ID:** dQw4w9WgXcQ
**Language:** English (en)
**Duration:** 3:42
**Extracted:** Full transcript / 1:30 - 3:45

---

[Transcript text with proper paragraphs and formatting]

---

*Generated by Fetch YouTube Transcript for Raycast*
```

---

## 📎 Phase 5: Clipboard-First UX

### Goal
Make "copy to clipboard" the default action for instant usage

### Tasks
- [ ] Change default action from "save" to "copy" in package.json
- [ ] Update preference default value
- [ ] Update UI labels (save should appear as secondary option)
- [ ] Update filename extension: `_transcript.txt` → `_transcript.md`
- [ ] Update toast messages for clipboard action
- [ ] Add "Paste in [App]" quick action suggestions
- [ ] Test clipboard handling with large transcripts (>100KB)

### Files to Modify
- `package.json` - update default values
- `src/fetch-youtube-transcript.tsx` - update action logic and messages

### Toast Message Updates
- **Before**: "Transcript fetched and saved"
- **After**: "Transcript copied to clipboard" (primary)
- **After**: "Transcript saved as video_transcript.md" (secondary)

---

## ✨ Phase 6: Parallel Operations & Progress

### Goal
Maximize speed with concurrent operations and provide real-time feedback

### Tasks
- [ ] Refactor title + transcript fetching to use `Promise.all()`
- [ ] Implement progress stages with individual toasts
- [ ] Add percentage indicator for long transcripts
- [ ] Add cancel functionality for slow operations
- [ ] Optimize Markdown formatting performance
- [ ] Add retry logic for network failures (3 attempts with exponential backoff)
- [ ] Test with various network conditions (fast/slow/intermittent)

### Files to Modify
- `src/utils.ts` - refactor to parallel operations
- `src/fetch-youtube-transcript.tsx` - add progress indicators

### Progress Stages
1. **"Detecting URL..."** (if auto-detect enabled)
2. **"Validating YouTube URL..."**
3. **"Fetching transcript..."** (with spinner)
4. **"Formatting as Markdown..."**
5. **"Copied to clipboard!"** (success) or **"Saved to ~/Downloads"** (success)

### Parallel Operations Example
```typescript
// Before (Sequential - Slow)
const title = await getTitle(videoId);
const transcript = await getTranscript(videoId);

// After (Parallel - Fast)
const [title, transcript] = await Promise.all([
  getTitle(videoId),
  getTranscript(videoId)
]);
```

---

## 🎨 Phase 7: Update Preferences & UI

### Goal
Reflect all new options and defaults in extension settings

### Tasks
- [ ] Update default action dropdown (change default to "copy")
- [ ] Add "Auto-detect URL source" preference (Browser/Clipboard/Both/Manual)
- [ ] Add "Markdown format options" preference (include timestamps, include metadata)
- [ ] Add "Browser priority" preference (Safari → Chrome → Arc → Brave)
- [ ] Remove yt-dlp installation instructions from README
- [ ] Update command descriptions
- [ ] Add screenshots for new features

### Files to Modify
- `package.json` - update preferences section
- `README.md` - complete rewrite
- `CHANGELOG.md` - add version 3.0.0 entry

---

## 📚 Phase 8: Documentation & Testing

### Goal
Ensure all features work correctly and users understand new capabilities

### Tasks
- [ ] Update README with new features
- [ ] Add usage examples for timestamps
- [ ] Add troubleshooting section
- [ ] Document browser support
- [ ] Create test plan for all features
- [ ] Test with 20+ different YouTube videos (various languages, lengths, types)
- [ ] Test clipboard detection on fresh system
- [ ] Test browser detection with all supported browsers
- [ ] Test timestamp edge cases
- [ ] Test Markdown rendering
- [ ] Update CHANGELOG.md with version 3.0.0

### Test Cases
- ✅ Standard video (5-10 mins, English)
- ✅ Long video (>1 hour)
- ✅ Short video (<1 min)
- ✅ Non-English video (Spanish, Chinese, etc.)
- ✅ Video without captions
- ✅ Private/deleted video (error handling)
- ✅ Playlist URL (should extract first video)
- ✅ Live stream (if captions available)
- ✅ Timestamp extraction (valid range)
- ✅ Timestamp extraction (invalid range)
- ✅ Clipboard detection (valid URL)
- ✅ Clipboard detection (invalid content)
- ✅ Browser detection (each supported browser)
- ✅ Large transcript (>1MB)

---

## 📦 Dependencies Changes

### Remove
- ❌ `which` (no longer needed without yt-dlp)
- ❌ `yt-dlp` external binary

### Add
- ✅ `youtube-transcript` (core transcript fetching)

### Keep
- ✅ `@raycast/api`
- ✅ `@raycast/utils`

---

## 🎯 Success Metrics

### Performance
- **Transcript fetch time**: 5-8s → <1s (5-10x improvement)
- **Total time to clipboard**: 10s → <2s (5x improvement)
- **User actions required**: 3 clicks → 1 click (3x reduction)

### User Experience
- **Typing required**: Full URL → Zero (clipboard/browser detection)
- **File management**: Manual → Optional (clipboard-first)
- **Format quality**: Plain text → Formatted Markdown

### Reliability
- **No external dependencies**: yt-dlp installation no longer required
- **Faster updates**: Pure npm package, no binary updates needed
- **Better error handling**: Direct API errors instead of child process errors

---

## 🚧 Potential Challenges & Mitigation

### Challenge 1: Browser Detection on macOS Security
**Issue**: macOS may require accessibility permissions for AppleScript
**Mitigation**: Graceful fallback to clipboard detection, clear error messages

### Challenge 2: youtube-transcript API Reliability
**Issue**: Package depends on YouTube's internal API (may break)
**Mitigation**: Add fallback to youtube-transcript-plus, implement retry logic

### Challenge 3: Large Transcript Performance
**Issue**: Videos >3 hours may have huge transcripts
**Mitigation**: Stream processing, chunked clipboard writes, progress indicators

### Challenge 4: Timestamp Accuracy
**Issue**: Transcript timestamps may not be precise
**Mitigation**: Allow ±2 second buffer, document limitations

---

## 📅 Estimated Timeline

- **Phase 1**: 2-3 hours (core speed improvement)
- **Phase 2**: 2-3 hours (auto-detection)
- **Phase 3**: 1-2 hours (timestamps)
- **Phase 4**: 1-2 hours (Markdown)
- **Phase 5**: 1 hour (UX updates)
- **Phase 6**: 2 hours (parallel + progress)
- **Phase 7**: 1 hour (preferences)
- **Phase 8**: 2-3 hours (docs + testing)

**Total**: 12-17 hours

---

## 🎉 Expected Outcome

### Before
```
User: [Opens Raycast] → [Types command] → [Pastes URL] → [Waits 8s]
     → [Opens Downloads folder] → [Opens .txt file] → [Copies content]
Total: ~25 seconds, 6 actions
```

### After
```
User: [Opens Raycast while on YouTube] → [Presses Enter]
     → Transcript in clipboard in <2 seconds
Total: ~2 seconds, 1 action
```

**12x faster workflow, 6x fewer actions** 🚀

---

## 📝 Version History

- **v2.0.1** (Current): Uses yt-dlp, saves to file
- **v3.0.0** (Planned): Fast npm package, clipboard-first, Markdown, auto-detection

---

*Plan created: 2025-12-03*
*Status: Ready for implementation*
