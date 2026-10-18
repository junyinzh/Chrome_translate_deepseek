# Verification record

Version 0.2.0, tested on 2026-10-18 using Node.js and a real Chromium Manifest V3 extension in isolated temporary profiles.

## Reproduced Wikipedia failure

The reported page was [St. Moritz on English Wikipedia](https://en.wikipedia.org/wiki/St._Moritz).

- Version 0.1.0 discovered 375 units at a 1600 × 1000 viewport. Its lead paragraph was **30th** in the queue, after navigation, account controls and sidebar labels.
- The third batch contained ten units. Its lead contained 22 source fragments, including a citation marker, inline links and units.
- Three direct live calls using the old array prompt all failed validation with `INVALID_TRANSLATION`. A fourth diagnostic call showed that the lead returned **21 parts for 22 inputs** while the other nine units had matching counts. The old validator discarded the entire batch.
- The same ten source units with the v0.2.0 numbered-parts prompt passed **3/3** direct live calls, without recovery. These responses took 1.87–2.18 seconds in that sample. This comparison tests response structure, not a general translation-quality or production failure-rate guarantee.

The screenshot alone could not establish a specific failure reason: it showed translation still running, with 40 cache hits. Cache hits and concurrent request completion also explain why later paragraphs can appear before an earlier pending paragraph. The queue inspection and live API reproduction establish the additional failure mechanism above.

## Live browser result

`npm run test:wikipedia:live` loads the real page, configures a local key, starts viewport translation with `deepseek-flash`, and checks the first request, lead, link identity and restoration.

Final run after the viewport-reflow fix:

| Measurement | Observed result |
| --- | --- |
| First request | Article title, then lead paragraph |
| First translated lead | 1.507 seconds |
| Completion of discovered viewport content | 13.901 seconds |
| Translated units | 68 |
| Failed units | 0 |
| Automatic repairs needed | 0 |
| Provider calls | 20 |
| Lead link identity | Preserved |
| Lead original HTML after restoration | Exact match |

An earlier run before the final reflow fix translated 67 units and exposed an additional untranslated paragraph as the Chinese text shortened the page. The final version rescans before viewport completion and covers that newly revealed paragraph too.

These are individual observations on one article and viewport, not timing guarantees or a full-page benchmark. Smaller batches favor first-readable-text latency and can increase prompt overhead. API service conditions and webpage structure affect results.

## Automated tests

- `npm test`: **14 unit tests** covering API handling, numbered fragment validation, independent paragraph acceptance, split recovery, Retry-After, bounded retries, timeout and cancellation.
- `npm run test:browser`: **19 integration checks** with a deterministic mock provider and no API credentials.
- `npm run test:browser:live`: the same 19 checks, with the final fixture translation and connection check using real DeepSeek calls.

Browser coverage includes:

1. Public installation starts without a key and accepts user configuration.
2. In-place translation preserves links, listeners, emphasis, formulas, code and editing regions.
3. Restoration returns the exact original fixture body markup.
4. Repeated translation uses cache without new API calls.
5. Dynamic additions and external site updates are translated and restored.
6. Long text nodes split across concurrent batches retain identity.
7. Pause prevents late writes and resume finishes pending work.
8. Authentication failure stops further requests and displays an actionable error.
9. Viewport mode discovers text after scrolling.
10. A synthetic encyclopedia's title and lead precede navigation and sidebars.
11. Valid neighbors appear while only the malformed lead is repaired in smaller pieces.
12. Links, footnotes and original markup survive recovery and restoration.
13. Cached text appears before network completion; pause/resume after partial delivery counts each unit once.
14. A permanent paragraph failure leaves neighbors intact; manual retry sends only that paragraph.
15. Whole-page mode reprioritizes queued body text after scrolling.
16. Viewport mode covers text exposed by translation reflow without a scroll.
17. End-to-end extension translation succeeds.
18. The options-page connection test succeeds.
19. No page JavaScript errors occur.

The encyclopedia fixture is synthetic; CI requires neither Wikipedia access nor credentials. Test manifests add access only to their test destination (localhost or English Wikipedia). The production manifest is unchanged. Local test profiles are removed after each run.

## Local evidence

Reports and images stay in the ignored `test-results/` directory:

- `wikipedia-baseline.json`: original queue order and text fragments.
- `wikipedia-old-api.json`, `wikipedia-mismatch.json`, `wikipedia-new-api.json`: original/new prompt comparison and fragment-count diagnosis.
- `wikipedia-live-report.json`, `wikipedia-v020.png`: latest real-page result and screenshot.
- `browser-report.json`, `browser-live-report.json`: regression results and final status.
- `translated-page.png`, `popup-complete.png`: local fixture UI screenshots.

`scripts/check-release.mjs` audits indexed files for local configuration and API keys. Its `--history` option also scans reachable Git objects. GitHub Actions runs unit tests, the index audit and mock browser tests without API credentials. The repository contains only an empty key configuration example.
