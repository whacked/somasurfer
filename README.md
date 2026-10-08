# Linked 3D Atlas Explorer

Explore anatomy and research through linked, reusable 3D atlas views.

Planning baseline: DOG-1. Atlas v1 technical plan: DOG-2.

## Layout

- `docs/alc-1-spec.md` — ALC-1, the anatomical addressing system v1 is built on.
- `packages/alc` — reference implementation of ALC-1, with its conformance suite.

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

```
cd packages/alc
node --test test/conformance.test.ts
node test/measure.mjs
```
