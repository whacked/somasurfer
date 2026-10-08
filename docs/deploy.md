# Deploying the atlas skeleton

The site is a static directory. There is no backend, no database and no build
service: `node packages/atlas-web/build.mjs` produces `dist/`, and any static
host can serve it.

## Target: GitHub Pages

Chosen because the artefact is prebuilt JSON and native ES modules, which is
exactly what Pages serves well; because the repository already needs GitHub
for pull requests, so it adds no new account or secret; and because a static
host cannot develop a backend by accident, which is a property worth keeping.

`.github/workflows/pages.yml` does it, and will not run until CI is green on
`main` — a deploy that outran its gate would defeat the gate. The base path
comes from `actions/configure-pages`, not from an assumption, because a
project site is served from `/<repo>/` rather than from `/`.

Once the repository has a GitHub remote:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Nothing else; no branch, no folder.
2. Merge to `main`, or run the `Deploy` workflow manually.
3. The URL is `https://<owner>.github.io/<repo>/` and is printed by the
   workflow's final step.

No secrets are needed. The workflow authenticates with the built-in
`GITHUB_TOKEN` through `id-token: write`.

## Current status: not deployed

This repository has **no git remote** — `project.codebase.repoUrl` is unset
and the checkout is a local managed folder — and no GitHub credentials are
available to this agent. A connection request is pending with the responsible
user.

Until that lands there is nowhere to push and no host to deploy to, so the URL
in DOG-6's acceptance criteria does not exist yet. Everything that produces it
is committed and verified: the build runs, the artefact is correct, the deploy
workflow is written, and the artefact is uploaded by CI on every run
(`atlas-static-build`) so it can be inspected without a deploy.

To verify the artefact locally in the meantime:

```
node packages/atlas-web/build.mjs
node packages/atlas-web/serve.mjs          # http://localhost:8080/
```

Verified on 2026-10-08 against a local server: `index.html`, `app/app.js`,
`app/style.css`, `data/atlas-index.json`, the asset payloads,
`assets/LICENSE`, `assets/ATTRIBUTION.md` and the root `LICENSE` all serve
200 with correct content types; a path-traversal request and a missing path
both return 404; and the asset attribution is present in the served HTML.

## If Pages is not the answer

The only thing the artefact needs from a host is "serve this directory". If
the decision goes to a different host, the parts that change are
`.github/workflows/pages.yml` and the `--base` argument. Nothing in
`build.mjs`, the licence separation rules or the performance budget depends on
the choice.

One constraint does carry over, and it is not negotiable: assets must be
served as **separate files** from `dist/assets/`, beside the `LICENSE` and
`ATTRIBUTION.md` that ship there. A host or bundler that inlines them would
turn mere aggregation into a derivative work.
`tools/check-licence-separation.mjs` runs against the deployed artefact in the
deploy workflow for exactly that reason.
