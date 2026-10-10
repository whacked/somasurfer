# Which atlas a link lands in

**Status:** decided, DOG-72. **Decided by:** CTO, against DOG-1 §2/§7 and plan §7.
**Cite this file** rather than restating the rule; two restatements in two
packages is what produced DOG-72 in the first place.

## The question

A URL carries an address whose frame belongs to the other atlas — `?a=BV-L-4721`
— and does **not** carry an `atlas` parameter. Does the viewer switch?

The viewer said no (`state.js`, `applyView`: *"a brain address in a body link
selects without switching — same rule as a click"*). The QA matrix said yes
(`brain-deep-link-resolves`: *"arriving by URL is the one way the brain atlas may
be entered without the explicit action, because the user named it"*). Both are
defensible and both were written down as settled, which is why this needed a
decision rather than a defect report.

## The rule

> **The `atlas` parameter decides the atlas. Nothing else does.**
>
> 1. `atlas` present and known → that atlas.
> 2. `atlas` absent → the default atlas, `body`. The address does **not** vote.
> 3. An address whose frame belongs to another atlas is still **selected**,
>    resolved, and named — and the view must say so and offer the move
>    (`selection.elsewhere` → the `cross_atlas_offer` message → *Open brain
>    atlas*).
> 4. A refused address changes nothing at all, including the atlas.

So the viewer's rule stands, and the matrix row was the side that changed.

## Why

**The accepted requirement is already met.** Plan §7 asks that *every address in
the URL restores the same view*. `encodeView` emits `atlas=` whenever the atlas
is not the default, so every link the product produces round-trips exactly, and
the `cross-atlas-restore` rows pass. No accepted requirement asks for the implied
switch; it was a nicety, and it was being enforced as a must-pass row.

**One rule beats two.** Under rule 2 there is a single total mapping from URL to
atlas. The alternative needs a second rule for the case it creates: a
hand-written `?a=BV-L-4721&atlas=body` names one atlas and implies another, and
something has to break the tie. There is no such case here.

**The harm DOG-1 §2 names is losing your place, and a link has no place to
lose.** That is the strongest argument *for* the implied switch, and it is why
this was close: on a cold page load nothing is taken away from anyone. It loses
to cost. The switch has to happen in `applyView`, before the address is known to
resolve, which is the seam where the "a refusal changes nothing" invariant lives
(rule 4) — the reference viewer already carries a comment about getting this
wrong once. The offer costs one click and no invariant.

**The offer already exists.** `select()` sets `elsewhere`; `app.js` renders the
sentence and the *Open brain atlas* button. The implied switch is new code at the
densest seam in the viewer; the decision that needs no new code is the one to
take this close to release.

## What each side carries

| Side | Consequence |
| --- | --- |
| Matrix (`atlas-qa`) | `brain-deep-link-resolves` asserts the decided rule; `brain-deep-link-restores` covers the round trip that `cross-atlas-restore` actually claims; `cross-atlas-link-honours-the-explicit-atlas` pins rule 1 against rule 2. `cross_atlas_offer` joins the message vocabulary, and the integrity gate requires it on any row whose address lives elsewhere. |
| Reference viewer | No longer switches on `fromUrl`; emits the offer instead. |
| Viewer (`atlas-web`) | **The rule is right and the implementation is not yet.** A cross-atlas selection is half-applied: it draws its cell and flies the camera in an atlas that cannot contain it, while the panel says *"The view has not been changed."* See DOG-75. |

## What this rule does not excuse

A cross-atlas selection must be **expressible**. `toView()` reads
`state.address[state.atlas]`, and `select()` files the address under the atlas it
belongs to, so a brain address selected in the body atlas is absent from the URL
the page then shows. The view cannot be copied, shared or restored — reachable by
pasting an address, with no URL involved, so it is not a consequence of this
decision. It is a plan §7 deep-link defect in its own right, and it is DOG-75's
second half.
