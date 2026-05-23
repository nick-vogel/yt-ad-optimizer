# YT Studio Ad Slot Optimizer

Chrome extension that automates cleanup of manually-placed mid-roll ad slots in YouTube Studio's monetization editor. It removes warning-flagged ad slots and manual slots that are too close together, while leaving automatic ad slots untouched.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this directory
5. The extension icon appears in your toolbar

## Usage

1. Open YouTube Studio and navigate to a video's **Monetization > Ads** page
2. Click the extension icon in your toolbar
3. Configure:
   - **Min seconds between manual ads** — manual ad slots closer together than this are removed (default: 60s)
   - **Dry run** — preview what would be deleted without actually deleting
   - **Re-run after save** — automatically save and re-scan up to 3 times until no warnings remain
4. Click **Run Optimizer**
5. Review the log output for details on each marker's classification and fate

## How It Works

1. **Read** — scans all ad break markers on the timeline
2. **Classify** — clicks each marker to determine if it's Manual or Automatic and reads its exact timestamp
3. **Filter** — keeps automatic slots (they also reset the spacing window), removes warning slots, removes manual slots too close to the last kept slot
4. **Delete** — removes filtered markers in reverse order to avoid DOM position shifts
5. **Save & Re-run** — optionally saves and repeats until clean

## Updating Selectors

YouTube Studio's DOM structure may change over time. All CSS selectors are centralized in `selectors.js`. If the extension stops working after a YouTube update:

1. Open YouTube Studio's monetization editor
2. Use Chrome DevTools to inspect the relevant elements
3. Update the selectors in `selectors.js`
4. Reload the extension in `chrome://extensions`

## Chrome Web Store

To publish to the Chrome Web Store:

1. Replace placeholder icons in `icons/` with proper 16x16, 48x48, and 128x128 PNG icons
2. Zip the extension directory
3. Upload at the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
