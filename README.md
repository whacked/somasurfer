# Linked 3D Atlas Explorer

Explore anatomy and research through linked, reusable 3D atlas views.

Planning baseline: DOG-1. Atlas v1 technical plan: DOG-2.

## Layout

- `docs/alc-1-spec.md` — ALC-1, the anatomical addressing system v1 is built on.
- `docs/alc-1-admissibility.md` — measured admissibility report. Generated; CI
  fails if it drifts from the code.
- `docs/performance-budget.md` — the performance budget, the machine it is
  stated for, and the current measurement.
- `packages/alc` — reference implementation of ALC-1, with its conformance
  suite. Apache-2.0.
- `packages/atlas-web` — the static build: prebuilt JSON indexes plus a client
  bundle, no backend. Apache-2.0.
- `packages/atlas-assets` — atlas geometry, labels and templates. **Licensed
  separately**; see below.
- `tools/` — the CI gates. One script per gate, each runnable on its own.

## ALC-1 in one minute

A short, human-transcribable, hierarchical address for a place in the body or brain.

```
BD-T07-03O-531      body, T7 level, three o'clock, outer, cell 531
BV-L-471025         brain, left hemisphere, AC-PC proportional cell 471025
```

Truncating an address always yields a valid, coarser address that contains it.
Addresses are dimensionless, so one address means the same anatomical place in
an adult, a child, or a population-specific template; only the millimetres
differ. See the spec for the precision ladders and for the one rule that is
easy to get wrong (never compare addresses across subjects with `===`).

## Checks

Node is pinned in `.nvmrc`. Everything is dependency-free — there is nothing to
install.

```
npm run ci                  # everything CI runs, in order
```

Or one gate at a time:

```
npm run check:node          # the running Node matches .nvmrc
npm run test:counted        # conformance suite + a floor on how many tests ran
npm run audit:check         # generated docs are byte-identical to the code
npm run audit:template      # body template admissibility (idle until one exists)
npm run check:licences      # no asset licence can reach the Apache-2.0 code
npm run build               # the static site into packages/atlas-web/dist
npm run perf:check          # the performance budget, against the fixture
npm run verify:gates        # break each gate on purpose; each must be caught
```

To look at the built site:

```
npm run build && node packages/atlas-web/serve.mjs
```

### Why the test count is a gate

`packages/alc`'s test script was `node --test test/`. That runs none of the
37 real tests. Measured on Node 24.21:

| invocation | real tests run | exit code |
| --- | --- | --- |
| `node --test test/` | 0 | 1 |
| `node --test 'test/*.nope.ts'` | 0 | **0** |
| `node --test 'test/*.test.ts'` | all | 0 |

The first is survivable — something goes red. The second is the one that ends
careers: zero tests, clean exit, a green tick on a build that checked nothing.
Nothing but the count distinguishes it from a passing run.

So `ci/expected-test-counts.json` states how many tests each suite must
actually run, and `tools/check-test-count.mjs` reads the count out of the TAP
summary and fails if it is short. Raise the floor when you add tests. Never
lower it to make CI green.

## Licensing

Code is **Apache-2.0** (root `LICENSE`). Atlas assets are licensed separately
in `packages/atlas-assets`, which carries its own `LICENSE` and
`ATTRIBUTION.md`.

The separation is structural. If the atlas meshes arrive under a share-alike
licence, the obligation must reach the assets and nothing else, so
`tools/check-licence-separation.mjs` enforces on every push that:

1. every package declares `atlas.licenceClass` as `code` or `asset`;
2. no code package depends on an asset package;
3. no code package imports from one;
4. asset packages are outside the npm workspace list, so npm never links them
   into `node_modules` where an import would resolve;
5. every asset package has its own `LICENSE`, `ATTRIBUTION.md` and
   `attribution.json`, and every payload file is attributed exactly once with a
   licence, a holder and a source;
6. no asset bytes appear in the shipped JavaScript, CSS, HTML or JSON indexes;
7. every shipped asset copy is byte-identical to its source — a build that
   re-encodes an asset has adapted it.

The client fetches assets at runtime as separate files, served beside their own
licence. `packages/atlas-web/build.mjs` only ever byte-copies them.

The asset licence itself is **pending** decision D1 on DOG-2. Until that lands,
`packages/atlas-assets` holds first-party placeholder geometry only. The
mechanism above does not depend on the outcome, which is why it was built
first.
