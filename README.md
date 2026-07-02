# Poll Ranker

A frameless, transparent, always-on-top desktop widget for live-streaming
educators. Launch real-time A–E polls during a YouTube Live session; students
vote in the live chat; the app captures votes locally, scores them by
correctness and speed, and renders an animated leaderboard overlay.

Built on the `classroom-timer` Electron base (frameless/transparent window,
`alwaysOnTop`, Windows hardware-acceleration patch, IPC settings pipeline).

## Architecture

```
main.js              Electron main process. Owns windows, the cumulative
                     session model, scraper lifecycle, and all IPC.
src/scraper.js       Local YouTube Live chat ingestion (hidden BrowserWindow
                     + DOM MutationObserver). Avoids the Data API v3 quota.
src/scoring.js       Pure scoring/ranking logic. Cumulative session, speed
                     points, per-question tally, Top-N, CSV. No dependencies.
src/license.js       Subscription verification seam (STUB — see below).
src/poll.html/css/js The widget UI + full-screen leaderboard (state machine).
src/settings.html/js Onboarding console: license, stream URL, latency buffer.
```

### User flow (4-phase state machine)

1. **Initiation** — pick poll time (10–150 s) + option count (4/5), click Start.
2. **Active polling** — analog countdown clock; chat captured silently.
3. **Selection** — on Time Out, pick the correct answer (turns green) → Show Results.
4. **Leaderboard** — full-screen overlay: left = this question's vote breakdown
   + GOLD/SILVER/BRONZE + stats; right = cumulative Top Performers.

A session accumulates across questions. "Next Question" keeps scores;
"End Session" clears them.

## Running

```bash
npm install      # downloads the Electron binary (needs network)
npm start        # launch the widget
npm run build:win   # NSIS installer (Windows)
npm run build:mac   # DMG (macOS)
```

## Important caveats (read these)

**1. License verification is a STUB.** `src/license.js` accepts
`PRO-2026-TEACHER`, `DEMO-DEMO-DEMO`, or any `DEV-XXXX-XXXX` key, locally and
offline. Swap the body of `verifyLicense()` for a Supabase/Firebase call when
ready — the rest of the app only depends on the returned shape
`{ valid, plan, reason? }`.

**2. "Millisecond" timing is relative, not true reaction time.** YouTube Live
chat is delivered in *batches* (the page updates every few seconds) and the
broadcast itself is delayed. We timestamp when a vote is *observed on the
teacher's machine*. The latency-buffer setting normalises the average delay,
but the ms ordering is a *relative* ranking within the capture window, not the
instant a student pressed Enter.

**3. DOM scraping is fragile + a ToS gray area.** The scraper reads YouTube's
live-chat popout DOM under the teacher's own IP (deliberately avoiding the
Data API quota). YouTube can change its markup at any time, which would break
capture — the selectors are centralised in `src/scraper.js` (`PAGE_SCRAPER`)
for easy updates. This approach is also against YouTube's Terms of Service.

**4. Voter identity.** The popout DOM doesn't reliably expose channel IDs, so
de-duplication keys on the author photo URL (which embeds the channel's avatar
id), falling back to the display handle.
```
