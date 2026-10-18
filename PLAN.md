# PageLingo implementation plan

## Objective

Provide a personal Chrome extension that accepts a DeepSeek API key, translates the current web page by replacing text at its original location, and restores the original text on demand.

## Architecture

1. **Popup:** reads public preferences, grants access through the user's extension action, injects the page script, starts or pauses translation and displays current status.
2. **Content script:** walks eligible text nodes, groups them by rendered paragraph, keeps references to original nodes and sends text batches to the background worker.
3. **Background worker:** reads the API key, checks the translation cache, calls the fixed official DeepSeek endpoint and validates model output before returning it.
4. **Options page:** edits the API key, target language, model, scope, concurrency, dynamic translation preference and terminology glossary.

The extension uses Manifest V3. The production manifest declares `activeTab`, `scripting` and `storage`, plus access to `https://api.deepseek.com/*`. There is no content script registered globally across all sites; translation starts after a user action.

## Translation representation

A paragraph is represented as an id and an ordered list of text fragments. Each fragment corresponds to an existing text node or a slice of a long text node. The model sees all fragments together to recover sentence-level context, and must return the same ids and fragment counts.

The content script writes returned strings into `Text.data`. It never replaces an element's HTML with model output. Links, emphasis wrappers, equations, code and event listeners retain their existing DOM identities.

Long text nodes are split near sentence or whitespace boundaries. Paragraph units have an approximate 3,000-character budget; API batches contain at most 10 units and approximately 6,500 source characters. Two batches can run concurrently by default. API responses stream to the worker and are assembled and validated before a batch is applied.

## Original-text tracking

Each text-node record stores its original value, source slices, translated slices and the last value written by PageLingo. A translation result is applied only if the node is still connected, still belongs to that record, and still contains the expected text.

Restoration follows the same check, so an independent site update is not overwritten with stale text. Newly detected site updates get their own source records. A generation id prevents cancelled or previous requests from modifying a later translation session.

## Dynamic content and interaction

A debounced `MutationObserver` detects inserted nodes and external text changes. Mutations matching PageLingo's own last write are ignored. Viewport mode also scans after scrolling. Pending units are retained on pause; resume starts a new request generation. Restore disconnects observation before writing original text back.

Translation cache keys cover the prompt version, model, target language, glossary, page title and exact source fragments. Cached translations are reused across page visits. Cache storage is bounded; errors and incomplete model responses are never cached.

## Failure handling

- Retry transient network failures, rate limiting, server failures and invalid or incomplete model output up to two times.
- Stop on invalid credentials, insufficient balance, access denial or invalid model parameters.
- Abort a request after 90 seconds, and abort outstanding work immediately on pause or tab closure.
- Refresh the worker's activity timer every 20 seconds only while a bounded network request is in flight; release that timer when the request finishes or is cancelled.
- Abort pending work when its tab navigates to a different page.
- Keep failed paragraph units available for retry while preserving successfully translated text.
- Leave protected areas and externally modified nodes untouched.

## Acceptance criteria

- Extension loads in current Chromium without JavaScript errors.
- Supplied key is imported at first installation and can make a real DeepSeek request.
- Ordinary paragraph text is replaced at its existing location.
- Links, event handlers, emphasis, code, formulas, editable regions and inputs survive translation.
- Restore reconstructs the original body markup for an unchanged fixture.
- A repeated translation uses the persistent cache.
- Dynamic additions and text updates are translated and restored correctly.
- Pausing prevents late responses from altering the page; resuming completes pending work.
- Authentication errors stop further work and appear in the UI.
- Viewport mode leaves below-the-fold text unchanged until it becomes visible.
- The full extension-to-DeepSeek-to-page path works with a locally configured key.

## Deferred scope

PDF and image translation, nested frames, shadow DOM, site-specific adapters, automatic site language rules, bilingual layout and Chrome Web Store publication are subsequent features. The current deliverable is a loadable local extension with a documented installation path.
