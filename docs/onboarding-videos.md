# Adding Videos to the Onboarding Tutorial

The setup tutorial (the guided overlay new users see on first login, also under the
"Tutorial" button in the top bar) has a video slot on every step. Until a video is
added, each step shows a styled "video coming soon" placeholder — the tutorial works
fine without them.

## How to add a video (no coding required)

1. **Record your screen** for one step (QuickTime on Mac: File → New Screen Recording).
   Keep it short — 30 to 90 seconds per step is ideal.
2. **Export/convert it to `.mp4`** (H.264). Most tools output this by default.
3. **Drop the file into `public/videos/`** in the project. Create the folder if it
   doesn't exist. Name it after the step, e.g. `create-wallet.mp4`.
4. **Open `public/js/onboarding-steps.js`** and find the step. Change one line:

   ```js
   videoSrc: null,
   ```

   to

   ```js
   videoSrc: '/videos/create-wallet.mp4',
   ```

5. Reload the dashboard. The player appears in that step automatically.

## The 8 steps and suggested file names

| # | Step id | Suggested file |
| --- | --- | --- |
| 1 | `create-wallet` | `/videos/create-wallet.mp4` |
| 2 | `export-key` | `/videos/export-key.mp4` |
| 3 | `add-key-to-bot` | `/videos/add-key-to-bot.mp4` |
| 4 | `connect-polymarket` | `/videos/connect-polymarket.mp4` |
| 5 | `builder-codes` | `/videos/builder-codes.mp4` |
| 6 | `add-builder-credentials` | `/videos/add-builder-credentials.mp4` |
| 7 | `fund-wallet` | `/videos/fund-wallet.mp4` |
| 8 | `start-bot` | `/videos/start-bot.mp4` |

## Notes

- **Never show a real private key on screen while recording.** Use a throwaway wallet
  you'll never fund, or blur the key in editing.
- Videos are served straight from the app, so large files slow the page; aim for
  under ~20 MB per clip (720p is plenty).
- The tutorial remembers progress per workspace, can be skipped any time (Esc), and
  re-launched from the "Tutorial" button in the top bar.
