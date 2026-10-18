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

A paragraph is represented internally as an id and an ordered list of text fragments. Each fragment corresponds to an existing text node or a slice of a long text node. The provider receives a numbered object such as `{"0":"Read the ","1":"paper","2":"."}` and must return every key exactly once. Numeric keys are reconstructed in source order. The model sees all fragments together to recover sentence-level context.

The content script writes returned strings into `Text.data`. It never replaces an element's HTML with model output. Links, emphasis wrappers, equations, code and event listeners retain their existing DOM identities.

Long text nodes are split near sentence or whitespace boundaries at approximately 2,200 characters. Paragraph units contain up to 50 fragments and approximately 2,400 source characters. Citation markers matching `.reference` or `.mw-ref` stay unchanged and do not enter translation requests.

## Reading order and first-result latency

The queue ranks visible article text first, followed by nearby article text below the viewport, visible auxiliary content, further body text, body text above the viewport and other auxiliary content. `article`, `main`, `[role=main]`, ordinary paragraph/heading elements and Wikipedia's content container identify body text; navigation, sidebars, infoboxes, hatnotes and page controls are secondary. Within a rank, units follow vertical position and original discovery order. The generic heuristic can still need adapters for unusual sites.

One small opening batch completes before additional requests start. It contains at most two units and 2,400 characters; on the reproduced Wikipedia page these are the title and lead paragraph. Later visible-body batches use the same limits; other batches use at most four units, 3,600 characters and 60 fragments. Default concurrency remains two after the opening request. Long units are not truncated to meet a batch limit.

The queue is re-ranked from current element rectangles before dispatch. Whole-page mode also listens for scrolling. Viewport mode scans again before reporting completion, covering paragraphs exposed when translations shorten the page. Already running requests are not preempted on scroll, and later concurrent requests can finish out of order.

API responses stream to the worker and require complete JSON validation. Valid paragraphs are delivered immediately through progress messages while invalid neighbors undergo recovery; cached paragraphs are delivered before network work. A per-unit settled flag prevents duplicate application/counting and ensures pause only requeues unfinished units. Smaller requests favor first-readable-text latency at the cost of more requests and prompt overhead.

## Original-text tracking

Each text-node record stores its original value, source slices, translated slices and the last value written by PageLingo. A translation result is applied only if the node is still connected, still belongs to that record, and still contains the expected text.

Restoration follows the same check, so an independent site update is not overwritten with stale text. Newly detected site updates get their own source records. A generation id prevents cancelled or previous requests from modifying a later translation session.

## Dynamic content and interaction

A debounced `MutationObserver` detects inserted nodes and external text changes. Mutations matching PageLingo's own last write are ignored. Viewport mode also scans after scrolling. Pending units are retained on pause; resume starts a new request generation. Restore disconnects observation before writing original text back.

Translation cache keys cover the prompt version, model, target language, glossary, page title and exact source fragments. Cached translations are reused across page visits. Cache storage is bounded; errors and incomplete model responses are never cached.

## Failure handling

- Validate each paragraph independently. Keep successful paragraphs when other paragraph ids, fragment keys or fragment counts are invalid.
- Retry an invalid paragraph alone; if it still fails and contains multiple fragments, request groups of at most eight fragments with the original full paragraph as context. Apply the reconstructed paragraph only when all its fragments validate.
- Retry a network/429/5xx failure once per request group, honoring `Retry-After` up to ten seconds. Structural errors and timeouts trigger smaller requests instead of repeating the entire batch.
- Stop on invalid credentials, insufficient balance, access denial or invalid model parameters.
- Give individual provider requests 30 seconds, each batch's complete recovery process 120 seconds and at most 32 provider calls. Abort outstanding work on pause, tab closure or navigation.
- Refresh the worker's activity timer every 20 seconds only while a bounded network request is in flight; release that timer when the request finishes or is cancelled.
- Abort pending work when its tab navigates to a different page.
- Keep failed paragraph units available for retry while preserving successfully translated text.
- Report repair state, recovered counts, pending requests and remaining errors with error codes. Internal status also records request/retry counts and error categories without credentials or source text.
- Leave protected areas and externally modified nodes untouched.

## Acceptance criteria

- Extension loads in current Chromium without JavaScript errors.
- Users can configure their key through options or an optional ignored local file and make a real DeepSeek request.
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

PDF and image translation, nested frames, shadow DOM, additional site-specific adapters, automatic site language rules, bilingual layout and Chrome Web Store publication are subsequent features. The current deliverable is a loadable local extension with a documented installation path.
