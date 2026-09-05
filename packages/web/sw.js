/**
 * THE APP SHELL'S CACHE — and nothing else's.
 *
 * WHAT THIS IS FOR. manifold's server is authoritative for scene state and reconciliation, so
 * an offline lens can only honestly do one thing: LOAD, and say it is disconnected. That is the
 * whole scope of this worker. It caches the SHELL — the document, the build's own hashed
 * assets, the icon, the web app manifest — so the chrome paints with no network and the
 * disconnected condition is a named state (`packages/web/src/lens.tsx`) instead of a blank page.
 * It is not offline editing, not a write queue, and not a second reconciliation path.
 *
 * WHAT IT NEVER TOUCHES. Every door — `/api`, `/ws`, `/healthz` — passes straight through, and
 * so does every CROSS-ORIGIN request. That second exclusion is the load-bearing one: the
 * instance a lens looks at is configurable (AXIOMS §The portable lens), so this worker must not
 * know, cache, or hard-bake an API origin. It answers for the origin that served it, which is
 * the shell, and is deliberately blind to wherever the data lives.
 *
 * WHY HAND-ROLLED. Workbox is the obvious library and was rejected on the invariant-8 test
 * ("boring, small, pinned"): it would add a build-time dependency and a generated worker to
 * save roughly the eighty lines below, and what it buys — runtime routing strategies, precache
 * revisioning, background sync — is either already answered by vite's content-hashed filenames
 * or explicitly out of scope. The whole cache policy here is three sentences long; a
 * dependency whose configuration is longer than the code it replaces is not a saving.
 *
 * THE UPDATE FLOW, which is the part a cache gets WRONG by default:
 *
 *   1. Every build gets its own cache name (`manifold-shell-<build>`), where `<build>` folds in
 *      a digest of the shipped asset names and bytes, including HTML and generated identity.
 *      A deploy cannot leave a browser pinned to an old lens: the new worker precaches into a
 *      new cache, and `activate` deletes every older `manifold-shell-*`.
 *   2. A live page is NEVER swapped underneath itself. The new generation installs and WAITS;
 *      the page sees it waiting and OFFERS the update (`lens.tsx`). Accepting it tells this
 *      worker to stop waiting and reloads when control changes, so the page comes back on one
 *      build's assets. `skipWaiting()` in `install` would instead serve a running React tree
 *      chunks from a different build; a bare reload would not do it at all, because a reloading
 *      tab is still a client of the old registration and the wait would outlive it.
 *   3. Navigations are network-FIRST, cache-second. A cached shell must not outlive the server
 *      it describes: the document is revalidated on every load, so the very next navigation
 *      after a deploy fetches the new document, and the cache is only consulted when the network
 *      is genuinely unavailable.
 *   4. Protocol skew is refused, not degraded. Revalidating the document is not enough on its
 *      own — a tab open across a deploy holds an old bundle — so `lens.tsx` compares this
 *      build's `PROTOCOL_VERSION` against the instance's `/healthz` and REFUSES with an update
 *      path when they disagree (`AGENTS.md` invariant 10, whose worked example is `v0.5.0`).
 *
 * The `SHELL` line below is rewritten by `packages/web/vite.config.ts` at build time — this file
 * is shipped by the ONE existing vite build, not by a second build target. The literal that
 * stands here is what a reader gets when they open the file: an empty precache, which degrades
 * to "network-first with no fallback" rather than to a lie.
 */

const SHELL = { build: "unbuilt", assets: [] }; // MANIFOLD_SHELL

const CACHE_PREFIX = "manifold-shell-";
const CACHE = `${CACHE_PREFIX}${SHELL.build}`;

/**
 * The one document every route falls back to, mirroring the server's own SPA fallback: the
 * shell is the same bytes for `/`, `/p/:id` and every plugin route, so one cache entry answers
 * for all of them instead of one entry per URL a viewer happened to visit.
 */
const SHELL_DOCUMENT = "/index.html";

const ASSETS = new Set(SHELL.assets);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` so the precache is filled from the network rather than from an HTTP cache that
      // may still hold the previous deploy's document.
      await cache.addAll(SHELL.assets.map((asset) => new Request(asset, { cache: "reload" })));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        // Only ever this worker's own generations: another cache on the same origin belongs to
        // somebody else, and a cache sweep that guesses is a cache sweep that deletes.
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * THE HANDOVER, and it has to be asked for. A reload alone does NOT release a registration —
 * the reloading tab is still a client of it — so a waiting generation would sit there until every
 * tab closed, which is a browser pinned to an old lens by a different route. The page therefore
 * says "stop waiting" and reloads when control changes (`lens.tsx`).
 *
 * ANY message means that, because there is exactly one thing a page has to tell this worker and a
 * name both programs must spell identically is a join nothing checks. A second message would need
 * a discriminator, and this comment is where it goes.
 */
self.addEventListener("message", () => {
  void self.skipWaiting();
});

async function shellDocument(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(SHELL_DOCUMENT, fresh.clone());
    return fresh;
  } catch (unreachable) {
    const cached = await cache.match(SHELL_DOCUMENT);
    // No cached shell on a first visit with no network: the browser's own failure is the honest
    // answer, because there is nothing to paint and pretending otherwise would be the lie.
    if (cached === undefined) throw unreachable;
    return cached;
  }
}

async function shellAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  // Content-hashed: a URL in this set can never have different bytes, so there is nothing to
  // revalidate and the cache is the fast, offline-correct answer.
  if (cached !== undefined) return cached;
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Not our origin, not our business: the instance may live anywhere, and this worker holds no
  // opinion about it.
  if (url.origin !== self.location.origin) return;
  // A door is never the shell's business, whichever verb it is dialed with.
  const { pathname } = url;
  if (pathname === "/healthz" || pathname.startsWith("/api") || pathname.startsWith("/ws")) return;
  if (request.mode === "navigate") {
    event.respondWith(shellDocument(request));
    return;
  }
  if (ASSETS.has(pathname)) event.respondWith(shellAsset(request));
});
