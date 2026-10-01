# Site and hosting operations

These procedures are for repository maintainers. The public integration
reference is [Clankdar checks](../docs/clankdar-checks-v1.md).

## Site and delivery

```console
bun run check:site
python3 -m http.server "${PORT:-$(hra-port clankdar-preview)}" --bind 127.0.0.1 --directory site/dist
bun run check:browser
```

Run builds and repository-wide checks through the installed host scheduler;
use its browser lane for the browser check. Run a preview server separately
and stop it after review. The browser check owns its ephemeral loopback server
and fresh browser contexts. Provision Chromium with `bun x playwright install chromium` for the pinned
Playwright version. Never launch the installed auto-updating Chrome app. The six widths
and two themes run as separate contexts, two at a time by default; pass
`--concurrency 1` to run them one after another. Screenshots are
retained in a new ignored `results/visual-*` directory. The site uses the pinned
Hraness design kit's Paper palette, Lantern material, Nebula Sans and Instrument
Serif, plus the canonical shared footer with no newsletter or support profile.
The site bundles its scripts first-party, including appearance, browser
practice, and consent-aware analytics. Keep the consent region lookup and
analytics hosts aligned with the CSP and browser request classifier.
Challenges, tables, and downloads remain usable without JavaScript.

`bun run check` runs strict TypeScript checking, tests, archived-report replay,
and the static build. `bun run check:browser` verifies responsive layout,
appearance controls, native answer disclosure, same-origin resources, links,
and browser errors. Deliver changes through a current-head pull request and
its passing checks. Generated `site/dist/` stays untracked; published pilot
artifacts are intentional source inputs, not private runtime results.

Verify the linked Hraness `clankdar` project and domain before deploying:

```console
vercel deploy --prod --scope hraness
```

Keep `.vercel/` private. `vercel.json` preserves the restrictive CSP and redirects
legacy `botcaptcha.dev` paths to `clankdar.com`. After deployment, verify routes,
canonical URLs, assets, archive hashes, redirects, and security headers. Retain
the existing project, domain, and previous production deployments for rollback.

`site/generate-icon.py` regenerates the icon PNGs; their hashes live in
`site/BRAND_ASSETS.md`.

## Deployment and recovery

The Worker checks invitation tokens against its `REGISTRATION_TOKEN` secret.
Apply the additive standalone-quota D1 migration before deploying this API.
It creates a new counter table and leaves actor/anchor data untouched. Keep
the existing issuer and wrapping secrets, Cloudflare identities, and R2
bucket. Do not reset counters or overwrite receipt keys. Old `sha256/*`
evidence, actor events, campaigns, and public pages remain intact.

Before migration, inspect the exact database and preserve an export/recovery
point. Old code can be restored while leaving the additive quota table and
any new receipts in place. After deployment, verify issuer continuity,
passing/failing checks, contradictory concurrent submissions, retry after
expiry, exact receipt hashes, independent replay, and preservation across a
redeploy. Qualification controls must be labeled as scripted, not reported
as model benchmark results.

## Check storage

Each completed check is stored as **one JSON receipt** in the
`clankdar-evidence-staging` R2 bucket at `checks/<id>.json`. The receipt
embeds its challenge receipts; no separate receipt objects are written. The
first successful conditional write becomes the result. The stored receipt is
immutable and hash-verifiable, but its key is the check ID, not its content
hash.

Issuance returns an AES-GCM sealed ticket containing the temporary secret
session. Its authenticated context binds the protocol, environment, issuer,
and check ID; its encrypted data binds the policy, deadline, and optional
subject/context. Issuing a check creates no per-check database row or session
object. One atomic counter in the staging D1 database enforces the issuance
[issuance limits](../docs/clankdar-checks-v1.md#storage-and-operational-limits);
it is separate from receipt storage.

## Cloudflare architecture and operating boundary

- **Worker:** HTTP routing, signature verification, public reads and profiles.
- **One SQLite Durable Object per actor:** serialized nonce/session state,
  campaigns, and the append-only actor event chain; this is the source of truth.
- **D1:** a rebuildable directory projection, not the authoritative history.
- **R2:** immutable evidence named by SHA-256 content hash.

No Queue or always-on WebSocket is needed in v1. Idle objects must not be kept
awake. The deployment is designed for the Cloudflare Free plan; confirm the
account's current allowances and measured usage before changing plans.
There is no authorized paid-plan upgrade implied by these defaults. Enforce
platform limits and bounded requests independently of expected low traffic.

The existing static site keeps its current hosting and deployment identity;
the Cloudflare API has a separate origin. A custom-domain configuration is a
deployment concern and must be verified before publishing that hostname as
live. A site migration would require preserving redirects, CSP, and the
existing browser verification gate.

The Worker requires `ISSUER_JWK`, `SESSION_WRAP_KEY`, and
`REGISTRATION_TOKEN` in Cloudflare Secrets. `ISSUER_JWK` signs evidence;
`SESSION_WRAP_KEY` encrypts live session secrets with AES-GCM. Never deploy
against a placeholder D1 database ID. Keep secrets, unpublished seeds,
expected answers, raw bearer tokens, and provider error bodies out of logs
and public D1 rows. Completed evidence reveals seeds by protocol.

Before operational activation, verify the exact account, bindings, deployed
issuer identity, persistence, and recovery path. Run the repository's final
checks and Wrangler dry run, then a bounded live campaign that proves both a
completed result and a miss, with independently replayed R2 evidence.
