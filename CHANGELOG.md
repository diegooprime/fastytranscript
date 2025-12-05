# Fetch Youtube Transcript Changelog

## [3.0.0] - 2025-12-04

### 🚀 Major Release - Complete Rewrite

This is a massive update that makes the extension **8-10x faster** with a completely redesigned user experience!

### ✨ Added

- **⚡ Ultra-Fast Performance**: Replaced yt-dlp with native `youtube-transcript` npm package (5-10x faster)
- **📋 Auto-Detection**: Automatically detects YouTube URLs from clipboard or active browser tab
- **🌐 Browser Integration**: Supports Safari, Chrome, Arc, and Brave browser tab URL detection
- **⏱️ Timestamp Support**: Extract specific segments with start/end time parameters
  - Supports multiple formats: `1:30`, `90`, `90s`, `1:30:45`
- **📝 Markdown Output**: All transcripts now formatted as beautiful Markdown with metadata
- **🎯 Clipboard-First**: Default action changed to "copy to clipboard" for instant workflow
- **📊 Progress Indicators**: Granular status updates (Validating, Fetching, Formatting, Done)
- **📦 Zero Dependencies**: No external binary installation required!

### 🔄 Changed

- **Breaking**: Default action is now "copy" instead of "save"
- **Breaking**: File extension changed from `.txt` to `.md`
- **Breaking**: Removed yt-dlp dependency (no longer needed)
- URL argument is now optional (auto-detects from clipboard/browser)
- All transcript labels updated from "txt" to "md"
- Improved error messages and handling

### 🗑️ Removed

- Removed `yt-dlp` external dependency
- Removed `which` package dependency
- Removed VTT file processing logic
- Removed manual installation requirement

### 🏃 Performance Improvements

- **Before**: ~8 seconds average, 6 manual steps
- **After**: <1 second average, 1 click workflow
- **Result**: 8-10x faster with 6x fewer actions!

## [2.0.2] - 2025-10-17

### 2.0.2 Added

- Added the second argument to the command to choose the action (save to txt file or copy to clipboard) - You can set the default action in preferences.

## [2.0.1] - 2025-10-01

### 2.0.1 Breaking Changes

- Switched the core transcript fetching mechanism from JavaScript libraries to the external `yt-dlp` command-line tool. Users are now required to install `yt-dlp` for the extension to function.
- Removed `youtube-transcript-scraper` and `ytdl-core` as dependencies.

### 2.0.1 Added

- Added `@raycast/utils` as a dependency for improved UI components.

### 2.0.1 Fixed

- Refactored `yt-dlp` path resolution to occur at runtime within the command, preventing the extension from crashing on load if `yt-dlp` is not installed.
- Simplified error notifications by using the `showFailureToast` utility for a more consistent user experience.

## [1.1.5] - 2024-12-18

### Fixed

- Now extension shows clear error if no transcript is found

## [1.1.4] - 2024-12-14

### Added

- Added support for all major languages:

1. Arabic (ar)
2. Bengali (bn)
3. Chinese (zh)
4. English (en)
5. French (fr)
6. German (de)
7. Hindi (hi)
8. Italian (it)
9. Japanese (ja)
10. Korean (ko)
11. Marathi (mr)
12. Portuguese (pt)
13. Russian (ru)
14. Spanish (es)
15. Tamil (ta)
16. Urdu (ur)

## [1.1.3] - 2024-12-10

### 1.1.3 Fixed

- Fixed issue due to ytdl-core

## [1.1.2] - 2024-12-04

### Changed

- Improved transcript filename generation to use video title instead of video ID
- Added filename sanitization to handle special characters in video titles
- Fixed issue where words from adjacent transcript lines were incorrectly joined together
- Improved transcript formatting with proper line spacing and word boundaries
- Added debug logging for better troubleshooting

## [1.1.1] - 2024-11-26

### 1.1.1 Added

- Initial project setup
- Basic functionality for fetching YouTube transcripts

## [1.0.0] - 2024-09-18

### Initial Version

- Project initialization
- Core transcript fetching mechanism implemented
