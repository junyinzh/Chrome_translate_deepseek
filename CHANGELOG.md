# Changelog

## 0.2.0 — 2026-10-18

### Article reading order

- Prioritize visible article text over navigation, sidebars, infoboxes and page controls.
- Send a small opening batch before starting concurrent background batches.
- Reduce normal batch limits from ten units / 6,500 characters to four units / 3,600 characters, with at most two units / 2,400 characters for visible body text.
- Re-rank queued text after scrolling or reflow and rescan viewport content revealed by shorter translations.

### Recovery

- Replace unnumbered provider arrays with explicitly numbered fragment objects.
- Validate each paragraph independently; deliver valid and cached paragraphs without waiting for failed neighbors.
- Retry failed paragraphs alone, then use smaller fragment groups with paragraph context.
- Preserve Wikipedia citation markers; retain link identities and exact original-text restoration.
- Add bounded request timeouts, recovery budgets and Retry-After handling.
- Show repair activity, recovered paragraph counts and error codes. Pause/resume only requeues unsettled units.

### Verification and migration

- Add a synthetic encyclopedia fixture, recovery unit tests and an optional live Wikipedia browser test.
- Reproduce the v0.1.0 St. Moritz lead failure and document measured results in [TESTING.md](TESTING.md).
- Existing settings are retained; the new prompt version automatically separates cache entries. Reload the extension and refresh open web pages to activate this version.

## 0.1.0 — 2026-10-18

Initial local Manifest V3 release with in-place translation, restoration, cache, glossary, dynamic content and whole-page/viewport modes.
