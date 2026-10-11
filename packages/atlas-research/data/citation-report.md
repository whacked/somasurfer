# Citation audit — the research seed’s 30 sources

GENERATED from `data/citation-report.json` by `tools/lib/citation-summary.mjs`.
Do not hand-edit: `tools/check-research-dataset.mjs` re-renders this file and fails if it differs.
Regenerate the underlying data with `node tools/verify-research-citations.mjs`.

- **Retrieved on:** 2026-10-09
- **Dataset:** `research-seed-2026.10.1` (30 papers)
- **Source `crossref`:** `https://api.crossref.org/works` — DOI registration agency metadata. Authoritative for whether a DOI is registered and what it points at.
- **Source `pubmed`:** `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` — NLM bibliographic index, used as an independent second route. Covers biomedical journals; does not index monographs.

This is a **point-in-time** record. Each row below is evidence that a named source returned
particular metadata on the date above — not a standing guarantee that it still does.

## Outcome

| status | papers | meaning |
| --- | --- | --- |
| `verified` | 28 | asserted DOI resolved through Crossref to the paper claimed |
| `unresolved` | 2 | the queries ran and no candidate matched |

**28 of 30** papers carry an identifier justified by a named source. **2** carry none.

Both routes run for every paper, whatever the dataset asserts. **26** of the 28 identifiers were *also* returned by an independent title-and-author search that was never given the DOI.

### Unresolved — no machine-resolvable identifier

For a monograph this is the **correct** record rather than a gap: books largely predate the DOI.
The queries that were tried are recorded per row in the JSON, so the next reader does not repeat them.

- **`paper:brodmann-1909-localisation`** — Brodmann K (1909), *Vergleichende Lokalisationslehre der Grosshirnrinde*.
  Venue as recorded: Johann Ambrosius Barth, Leipzig.
  both routes answered; no candidate matched on title, first author and year. Nearest: crossref#0 10.53846/goediss-1201: "\"Eine vergleichende Genexpressionsanalyse von Gap- Junction- Strukturproteinen in oralen Plattenepithelkarzinomen und gesunder Schleimhaut\"" (null) — title differs, firstAuthor absent, year absent; crossref#1 10.1002/andp.18922840116: "Ueber eine zur Untersuchung sehr zäher Flüssigkeiten geeignete Modification der Transpirationsmethode" (1893) — title differs, firstAuthor match, year differs; crossref#2 10.1007/bf02565747: "Ueber die minimale Dimension der assoziierten Primideale der Komplettion eines lokalen Integritätsbereiches" (1975) — title differs, firstAuthor match, year differs; crossref#3 10.1002/andp.18922810111: "Untersuchungen über den Reibungscoefficienten von Flüssigkeiten" (1892) — title differs, firstAuthor match, year differs. Left as kind "none" rather than attaching a near miss.
- **`paper:bogduk-2012-lumbar-anatomy`** — Bogduk N (2012), *Clinical and Radiological Anatomy of the Lumbar Spine, 5th edition*.
  Venue as recorded: Churchill Livingstone, Edinburgh.
  both routes answered; no candidate matched on title, first author and year. Nearest: crossref#0 10.1097/00007632-198407000-00006: "The Menisci of the Lumbar Zygapophyseal Joints" (1984) — title differs, firstAuthor match, year differs; crossref#1 10.1007/978-3-662-05347-8_3: "Functional Anatomy of the Disc and Lumbar Spine" (2003) — title differs, firstAuthor match, year differs; crossref#2 10.1097/00007632-198207000-00001: "The Clinical Anatomy of the Cervical Dorsal Rami" (1982) — title differs, firstAuthor match, year differs; crossref#3 10.1097/00007632-199602010-00031: "Lumbar Discography" (1996) — title differs, firstAuthor match, year differs. Left as kind "none" rather than attaching a near miss.

## Every paper

`t`/`f`/`y` are title / first author / year: `=` equal, `⊃` one contains the other, `±1` off by one, `≠` differs, `∅` absent.

| paper | status | identifier | justified by | match |
| --- | --- | --- | --- | --- |
| `paper:brodmann-1909-localisation` | `unresolved` | — | — | t≠ f∅ y∅ |
| `paper:glasser-2016-mmp1` | `verified` | `10.1038/nature18933` | crossref | t= f= y= |
| `paper:amunts-1999-broca` | `verified` | `10.1002/(sici)1096-9861(19990920)412:2<319::aid-cne10>3.0.co;2-7` | crossref | t= f= y= |
| `paper:amunts-2020-julich-brain` | `verified` | `10.1126/science.abb4588` | crossref | t= f= y= |
| `paper:zilles-2010-brodmann-centenary` | `verified` | `10.1038/nrn2776` | crossref | t= f= y= |
| `paper:desikan-2006-gyral-parcellation` | `verified` | `10.1016/j.neuroimage.2006.01.021` | crossref | t= f= y= |
| `paper:tzourio-mazoyer-2002-aal` | `verified` | `10.1006/nimg.2001.0978` | crossref | t= f= y= |
| `paper:fan-2016-brainnetome` | `verified` | `10.1093/cercor/bhw157` | crossref | t= f= y= |
| `paper:yeo-2011-intrinsic-networks` | `verified` | `10.1152/jn.00338.2011` | crossref | t= f⊃ y= |
| `paper:power-2011-functional-areas` | `verified` | `10.1016/j.neuron.2011.09.006` | crossref | t= f= y= |
| `paper:hagmann-2008-structural-core` | `verified` | `10.1371/journal.pbio.0060159` | crossref | t= f= y= |
| `paper:van-essen-2013-hcp` | `verified` | `10.1016/j.neuroimage.2013.05.041` | crossref | t= f= y= |
| `paper:mazziotta-2001-icbm` | `verified` | `10.1098/rstb.2001.0915` | crossref | t⊃ f= y= |
| `paper:fonov-2011-unbiased-templates` | `verified` | `10.1016/j.neuroimage.2010.07.033` | crossref | t= f= y= |
| `paper:fischl-2012-freesurfer` | `verified` | `10.1016/j.neuroimage.2012.01.021` | crossref | t= f= y= |
| `paper:eickhoff-2005-anatomy-toolbox` | `verified` | `10.1016/j.neuroimage.2004.12.034` | crossref | t= f= y= |
| `paper:mesulam-1998-sensation-to-cognition` | `verified` | `10.1093/brain/121.6.1013` | crossref | t= f= y= |
| `paper:raichle-2001-default-mode` | `verified` | `10.1073/pnas.98.2.676` | crossref | t= f= y= |
| `paper:buckner-2008-default-network` | `verified` | `10.1196/annals.1440.011` | crossref | t⊃ f= y= |
| `paper:price-2012-language-review` | `verified` | `10.1016/j.neuroimage.2012.04.062` | crossref | t= f= y= |
| `paper:hickok-2007-dual-stream` | `verified` | `10.1038/nrn2113` | crossref | t= f= y= |
| `paper:kanwisher-1997-fusiform-face-area` | `verified` | `10.1523/JNEUROSCI.17-11-04302.1997` | crossref | t= f= y= |
| `paper:epstein-1998-parahippocampal-place-area` | `verified` | `10.1038/33402` | crossref | t= f= y= |
| `paper:penfield-1937-somatotopy` | `verified` | `10.1093/brain/60.4.389` | crossref | t= f= y= |
| `paper:catani-2008-virtual-dissection` | `verified` | `10.1016/j.cortex.2008.05.004` | crossref | t= f= y= |
| `paper:mitsuhashi-2009-bodyparts3d` | `verified` | `10.1093/nar/gkn613` | crossref | t= f= y= |
| `paper:rosse-2003-fma` | `verified` | `10.1016/j.jbi.2003.11.007` | crossref | t= f= y= |
| `paper:mungall-2012-uberon` | `verified` | `10.1186/gb-2012-13-1-r5` | crossref | t= f= y= |
| `paper:panjabi-1991-thoracic-morphometry` | `verified` | `10.1097/00007632-199108000-00006` | crossref | t= f= y= |
| `paper:bogduk-2012-lumbar-anatomy` | `unresolved` | — | — | t≠ f= y≠ |

## What this does not establish

Crossref and PubMed confirm that a paper **exists** and what its metadata is. They say nothing
about whether a paper **claims what this dataset attributes to it**. The seed asserts
`provenance.basis: "published-text"` with `confidence: "high"` across its findings and region
mappings, and that assertion is not supported by anything in this report. It is reviewable only
by a person reading the sources, and it is the assertion that carries the real risk: a citation
that resolves perfectly while the claim attached to it is not what the paper found.

Also unchecked here: whether a DOI still resolves today, and whether the `venue` volume and page
run is correct. The gate compares the dataset against this committed report offline; it does not
re-fetch.
