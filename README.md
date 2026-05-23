# Mid-Roll Manager

Chrome extension for bulk-inserting and cleaning up mid-roll ad slots in the Studio monetization editor. Insert ad slots at regular intervals, then clean up redundant or too-close placements — all from a simple popup UI.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this directory
5. The extension icon appears in your toolbar

## Usage

1. Open the Studio monetization editor for any video (**Monetization > Ads**)
2. Click the extension icon in your toolbar

### Insert Mode

- **Place an ad every N seconds** — interval between inserted ad slots (default: 60s)
- **Start at (seconds)** — where to begin placing ads (default: 60s)
- **Dry run** — preview planned placements without inserting
- Click **Insert Ad Slots** to place them

### Cleanup Mode

- **Min seconds between ads** — manual slots closer than this are removed; automatic slots are always kept but count toward spacing
- **Dry run** — preview what would be deleted
- Click **Run Cleanup** to remove redundant slots

### Speed Control

Both modes have a configurable speed (ms) setting. Default is 50ms per operation. Increase if your browser lags or placements are missed.

## How It Works

### Insert

1. Seeks the video playhead to each target timestamp
2. Clicks "Insert ad slot" to create a slot at that position
3. Skips positions where ad slots already exist

### Cleanup

1. Reads all ad break rows from the panel (type, timestamp, warning status)
2. Filters: keeps automatic slots, removes warnings, removes manual slots too close to the nearest kept slot
3. Deletes in reverse chronological order to avoid DOM position shifts

## Permissions

This extension requests minimal permissions:

| Permission | Why |
|---|---|
| `activeTab` | Interact with the current tab when you click the extension icon |
| `host_permissions: studio.youtube.com` | Content script must run on the Studio monetization editor |

No data is collected or transmitted. See [PRIVACY.md](PRIVACY.md) for details.

## Updating Selectors

The Studio DOM structure may change over time. All CSS selectors are centralized in `selectors.js`. If the extension stops working:

1. Open the Studio monetization editor
2. Use Chrome DevTools to inspect the relevant elements
3. Update the selectors in `selectors.js`
4. Reload the extension in `chrome://extensions`

## Chrome Web Store

To publish:

1. Zip the extension directory (excluding `debug-selectors.js`, `.git/`, `.idea/`)
2. Upload at the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. Provide the [PRIVACY.md](PRIVACY.md) content as the privacy policy URL or inline text
4. Use the permissions justification table above when prompted
