# Verification record

## Version 0.3.1 — higher translation concurrency (`developemnt`)

Verified on 2026-10-21: all 19 unit tests, 19 browser regression checks and 14 link-following browser checks pass. Settings checks cover the new default of 12, the full 1–12 selector, upper/lower bounds and preservation of saved lower values.

Live performance measurements used `deepseek-flash` and a frozen [St. Moritz article](https://en.wikipedia.org/wiki/St._Moritz) body: 33 text units, 375 fragments and 13,345 source characters. The v0.3.0 implementation was tested with only its concurrency limit raised in an isolated copy; article-first scheduling, the serial opening batch, prompts, validation and recovery were retained.

| Concurrent batches | Fixed-batch median, 3 runs | Range | Isolated Chromium extension, 1 run |
| --- | --- | --- | --- |
| 3 | 10.727 s | 10.677–11.195 s | 10.839 s |
| 6 | 6.347 s | 6.195–6.582 s | 6.699 s |
| 12 | 5.159 s | 4.727–5.233 s | 5.240 s |

Fixed-batch runs replayed the same 12 batches through the original API and recovery functions, rotating concurrency order as 3/6/12, 12/3/6 and 6/12/3. Each run used 9,103 input tokens; output token counts varied slightly. Extension-local translation caching was bypassed, while provider-side input caching remained enabled. The first run had fewer provider cache hits; rotation and medians reduce that ordering effect.

The real extension loaded the same frozen HTML in an isolated Chromium profile, clearing its translation cache between runs. All 33 units translated with no failures, retries or local cache hits; exact original-markup restoration passed. Reflow changed grouping to 13 requests at concurrency 3 versus 12 requests at 6/12. The fixed-batch comparison excludes this variable.

In this sample, 12 reduced median completion time by 51.9% versus 3 and 18.7% versus 6. Only 11 batches remain after the opening batch, so concurrency above 12 cannot add parallel work here. These measurements do not establish an optimum for other pages, models or service conditions, and translation semantics were not manually scored. The limit is per page; concurrent tabs have separate queues.

Existing installations retain their saved concurrency. Reload the extension, select **12** under **同时翻译的批次**, save and refresh the article. New installations use 12 automatically.

## Version 0.3.0 — link following (`developemnt`)

Tested on 2026-10-18. The 19 unit tests and original 19 browser regression checks pass. The navigation suite adds 14 mock-provider checks; its live variant adds a 15th check using DeepSeek to translate the selected article and the article reached through its next link.

`npm run test:follow` covers:

- Default-off behavior and denied permission with working manual translation.
- Popup activation, same-tab next links and reloads.
- Child-tab inheritance with `rel=noopener`, while independent tabs stay untranslated.
- Cross-origin links, server redirects and back navigation to a visited article.
- SPA route changes; restore keeps the current document untranslated.
- Session restoration after actual service-worker termination through the DevTools protocol.
- Group-wide stop, including SPA updates and subsequent navigation in child tabs.
- Address-bar-style navigation ending the tab's reading session.
- No page JavaScript errors.

The unit suite additionally covers stale document IDs, permission revocation, worker-state restoration, unknown history destinations and late child events after switching off. `npm run test:follow:live` uses a locally configured key for its last two documents; reports omit credentials.

Headless Chrome cannot exercise the native permission dialog visually. The navigation fixture temporarily pregrants the requested optional permissions; it calls the real popup request path and separately stubs a denied response. The normal extension regression suite still loads the production optional-permission declaration without granting it. No test modifies the user's normal browser profile or the shipped permission manifest.

Local evidence: `test-results/follow-browser-report.json`, `follow-browser-live-report.json` and `popup-follow.png`. GitHub Actions runs the unit, original browser and navigation suites on `main` and `developemnt` without credentials.

## Version 0.2.0 baseline

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
