# Verification record

Tested on 2026-10-18 using Node.js and a real Chromium Manifest V3 extension in an isolated, temporary browser profile.

## Results

- `npm test`: **8 tests passed**.
- `npm run test:live`: a locally configured key successfully translated three sample blocks through the official DeepSeek API. The initial request took 1.52 seconds and used 435 tokens; this is one observed request, not a general latency estimate.
- `npm run test:browser`: **12 integration checks passed** with a mock provider and no API credentials.
- `npm run test:browser:live`: **12 integration checks passed**, including real extension-to-DeepSeek-to-page translation and the options-page connection test. No page JavaScript errors were recorded in either mode.

## Browser checks

1. Public installation starts without a key and accepts user configuration.
2. In-place translation with preserved links, link listeners, emphasis, formulas, code and editing regions.
3. Exact original body markup after restoration.
4. Cached repeat translation without further API requests.
5. Translation and restoration of dynamically inserted text and external site updates.
6. A long text node split across concurrent batches retains its identity and restores exactly.
7. Cancellation on pause, followed by successful resume.
8. Authentication failure stops further work and displays an error.
9. Viewport translation discovers newly visible text after scrolling.
10. Real DeepSeek translation through the installed extension.
11. Successful connection test from the options page.
12. No browser JavaScript errors.

The deterministic cases use a mock provider response inside the temporary extension worker. Browser tests now default to this mock provider throughout and require no credentials. The separate `npm run test:browser:live` command performs the final translation and connection checks with a locally configured DeepSeek key. The temporary test manifest grants access to the localhost fixture; this grant is not present in the shipped manifest.

## Artifacts

- `test-results/live-api.json`: initial live API request, translations, token counts and elapsed time.
- `test-results/browser-report.json`: mock-provider integration results and final page status.
- `test-results/browser-live-report.json`: live-provider integration results and final page status.
- `test-results/settings.png`: settings-page screenshot.
- `test-results/popup.png`: popup before translation.
- `test-results/popup-complete.png`: popup after real translation.
- `test-results/translated-page.png`: real translated fixture with preserved links, formatting, formulas, code and inputs.

The screenshots were visually inspected. These tests cover the supplied representative HTML fixture; they do not establish compatibility with every website. Test profiles are temporary and separate from normal browsing profiles.

## Public distribution checks

The repository includes an empty configuration example. The actual `local-config.json`, local reports, browser profiles, environment files and npm dependencies are excluded from version control. `scripts/check-release.mjs` inspects the Git index and can also scan reachable Git objects before publication.

The README screenshots are copied to `docs/images/` after visual inspection; generated reports remain local. GitHub Actions runs unit tests, the release audit and mock-provider browser checks without API credentials.
