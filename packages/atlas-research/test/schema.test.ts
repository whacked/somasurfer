import { strict as assert } from 'node:assert';
import test from 'node:test';

import { loadDataset, ResearchDataError, validateDataset } from '../src/index.ts';
import { readJson } from './helpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

const RAW = readJson('fixtures/research.fixture.json') as Raw;

/** A fresh deep copy of the fixture, mutated by `edit`, then validated. */
function broken(edit: (d: Raw) => void): readonly { path: string; message: string }[] {
  const copy = structuredClone(RAW);
  edit(copy);
  const { dataset, problems } = validateDataset(copy);
  assert.equal(dataset, null, 'this dataset should not have loaded');
  return problems;
}

/** Assert at least one problem whose path and message match. */
function hasProblem(
  problems: readonly { path: string; message: string }[],
  path: string | RegExp,
  message: string | RegExp,
): void {
  const match = problems.some(
    (p) =>
      (typeof path === 'string' ? p.path === path : path.test(p.path)) &&
      (typeof message === 'string' ? p.message.includes(message) : message.test(p.message)),
  );
  assert.ok(
    match,
    `no problem matched ${path} / ${message}. Got:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
test('the fixture loads, and reports what it is', () => {
  const d = loadDataset(RAW);
  assert.equal(d.schema, 'research/1');
  assert.equal(d.papers.length, 5);
  assert.equal(d.findings.length, 14);
  assert.equal(
    d.findings.reduce((n, f) => n + f.mappings.length, 0),
    19,
  );
  assert.equal(d.authoredAgainst.status, 'fixture', 'the fixture must not claim to be authored against the real index');
  // The honesty signal is that the record exists and lists its gaps, not that
  // it contains a particular word.
  assert.ok(d.curation.citationCheck.length > 0, 'the curation record states what was and was not checked');
  assert.ok(d.curation.notRecorded.length > 0, 'the curation record lists what it did not record');
});

test('an unknown schema version is refused, not guessed at', () => {
  const problems = broken((d) => {
    d.schema = 'research/2';
  });
  hasProblem(problems, '$.schema', 'must be exactly "research/1"');
  // And nothing else is reported: a reader that cannot name the version has no
  // business interpreting the fields.
  assert.equal(problems.length, 1);
});

test('every problem is collected, not just the first', () => {
  const problems = broken((d) => {
    d.papers[0].title = '';
    d.papers[1].year = 'nineteen oh nine';
    d.findings[0].statement = '';
  });
  assert.ok(problems.length >= 3, `expected at least three problems, got ${problems.length}`);
});

test('loadDataset throws, listing every problem', () => {
  const copy = structuredClone(RAW);
  copy.papers[0].sourceUrl = 'javascript:alert(1)';
  copy.findings[0].topics = [];
  assert.throws(
    () => loadDataset(copy),
    (e: unknown) => {
      assert.ok(e instanceof ResearchDataError);
      assert.ok(e.problems.length >= 2);
      assert.ok(e.message.includes('research dataset rejected'));
      return true;
    },
  );
});

// --- identity and referential integrity ------------------------------------

test('ids must match their prefixed patterns', () => {
  hasProblem(
    broken((d) => {
      d.papers[0].id = 'Glasser2016';
    }),
    '$.papers[0].id',
    'must match',
  );
  hasProblem(
    broken((d) => {
      d.findings[0].id = 'f1';
    }),
    '$.findings[0].id',
    'must match',
  );
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].id = 'm1';
    }),
    /mappings\[0\]\.id$/,
    'must match',
  );
});

test('duplicate ids are refused at every level', () => {
  hasProblem(
    broken((d) => {
      d.papers[1].id = d.papers[0].id;
    }),
    '$.papers[1].id',
    'duplicate paper id',
  );
  hasProblem(
    broken((d) => {
      d.findings[1].id = d.findings[0].id;
    }),
    '$.findings[1].id',
    'duplicate finding id',
  );
  // Mapping ids are what a highlight traces back to, so a duplicate means
  // hover can show the wrong provenance.
  hasProblem(
    broken((d) => {
      d.findings[1].mappings[0].id = d.findings[0].mappings[0].id;
    }),
    '$.findings[1]',
    'duplicate mapping id',
  );
});

test('a finding must point at a paper that exists', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].paperId = 'paper:does-not-exist';
    }),
    '$.findings[0].paperId',
    'no paper with id',
  );
});

test('a paper with no findings is refused', () => {
  hasProblem(
    broken((d) => {
      d.findings = d.findings.filter((f: Raw) => f.paperId !== d.papers[3].id);
    }),
    '$.papers[3]',
    'has no findings',
  );
});

test('a finding with no mappings is refused', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].mappings = [];
    }),
    '$.findings[0].mappings',
    'at least one region mapping',
  );
});

test('one finding may not map the same structure twice', () => {
  hasProblem(
    broken((d) => {
      // findings[1] maps areas 44 and 45; point the second at 44 as well.
      d.findings[1].mappings[1].structureId = d.findings[1].mappings[0].structureId;
    }),
    /mappings\[1\]\.structureId$/,
    'one finding maps a structure once',
  );
});

// --- the trust boundary on URLs and identifiers ----------------------------

test('a non-http(s) source URL is refused outright, not defanged', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example.com/paper',
    'doi:10.1038/nature18933',
    'file:///etc/passwd',
  ]) {
    hasProblem(
      broken((d) => {
        d.papers[0].sourceUrl = url;
      }),
      '$.papers[0].sourceUrl',
      'absolute http(s) URL',
    );
  }
});

test('a missing sourceUrl key is a problem; an explicit null is fine', () => {
  hasProblem(
    broken((d) => {
      delete d.papers[0].sourceUrl;
    }),
    '$.papers[0].sourceUrl',
    'use null when there is no source URL',
  );
  const ok = structuredClone(RAW);
  ok.papers[0].sourceUrl = null;
  assert.ok(validateDataset(ok).dataset, 'an explicit null is a stated fact and must load');
});

test('identifier kind and value must agree', () => {
  hasProblem(
    broken((d) => {
      d.papers[1].identifier = { kind: 'none', value: '10.1000/x' };
    }),
    '$.papers[1].identifier.value',
    'must be null when kind is "none"',
  );
  hasProblem(
    broken((d) => {
      d.papers[0].identifier = { kind: 'doi', value: 'nature18933' };
    }),
    '$.papers[0].identifier.value',
    'does not look like a doi',
  );
  hasProblem(
    broken((d) => {
      d.papers[0].identifier = { kind: 'pmid', value: 'PMC12345' };
    }),
    '$.papers[0].identifier.value',
    'does not look like a pmid',
  );
  hasProblem(
    broken((d) => {
      d.papers[0].identifier = { kind: 'url', value: 'javascript:alert(1)' };
    }),
    '$.papers[0].identifier.value',
    'absolute http(s) URL',
  );
});

// --- text fields -----------------------------------------------------------

test('control, bidi and zero-width characters are refused in text', () => {
  for (const nasty of [
    `title with a NUL ${String.fromCharCode(0)} in it`,
    `right-to-left ${String.fromCharCode(0x202e)} override`,
    `zero width ${String.fromCharCode(0x200b)} space`,
    `byte order ${String.fromCharCode(0xfeff)} mark`,
  ]) {
    hasProblem(
      broken((d) => {
        d.papers[0].title = nasty;
      }),
      '$.papers[0].title',
      'control, bidi or zero-width',
    );
  }
});

test('angle brackets in text are ordinary characters and load fine', () => {
  // Deliberately NOT escaped or rejected: `<` appears in real titles and in
  // real DOIs. The rule is that the viewer inserts text as text; mangling the
  // data here would be the wrong fix in the wrong place.
  const ok = structuredClone(RAW);
  ok.papers[0].title = 'Cortex <in vivo> & "ex vivo"';
  const { dataset } = validateDataset(ok);
  assert.ok(dataset);
  assert.equal(dataset.papers[0].title, 'Cortex <in vivo> & "ex vivo"');
});

test('an empty or over-long text field is refused', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].statement = '   ';
    }),
    '$.findings[0].statement',
    'must not be empty',
  );
  hasProblem(
    broken((d) => {
      d.findings[0].statement = 'x'.repeat(2001);
    }),
    '$.findings[0].statement',
    'longer than the 2000-character cap',
  );
});

test('a date must be a real calendar date', () => {
  hasProblem(
    broken((d) => {
      d.papers[0].provenance.assertedOn = '2026-02-30';
    }),
    '$.papers[0].provenance.assertedOn',
    'not a real calendar date',
  );
  hasProblem(
    broken((d) => {
      d.papers[0].provenance.assertedOn = '09/10/2026';
    }),
    '$.papers[0].provenance.assertedOn',
    /ISO date|longer than/,
  );
});

// --- provenance ------------------------------------------------------------

test('a curator inference must say what was inferred', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].provenance = {
        assertedBy: 'Staff Engineer (GStack)',
        assertedOn: '2026-10-09',
        basis: 'curator-inference',
        confidence: 'medium',
      };
    }),
    /mappings\[0\]\.provenance\.note$/,
    'required when basis is "curator-inference"',
  );
});

test('an unknown basis or confidence is refused', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].provenance.basis = 'obvious';
    }),
    /provenance\.basis$/,
    'must be one of',
  );
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].provenance.confidence = 'very high';
    }),
    /provenance\.confidence$/,
    'must be one of',
  );
});

test('provenance is required on the paper, the finding and the mapping alike', () => {
  hasProblem(
    broken((d) => {
      delete d.papers[0].provenance;
    }),
    '$.papers[0].provenance',
    'needs a provenance record',
  );
  hasProblem(
    broken((d) => {
      delete d.findings[0].provenance;
    }),
    '$.findings[0].provenance',
    'needs a provenance record',
  );
  hasProblem(
    broken((d) => {
      delete d.findings[0].mappings[0].provenance;
    }),
    /mappings\[0\]\.provenance$/,
    'needs a provenance record',
  );
});

// --- evidence --------------------------------------------------------------

test('a locator and its status may not contradict each other', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].evidence.locatorStatus = 'recorded';
    }),
    /evidence\.locator$/,
    'is null but locatorStatus says "recorded"',
  );
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].evidence.locator = 'Fig. 2';
    }),
    /evidence\.locator$/,
    'is present but locatorStatus says "not-recorded"',
  );
});

test('a missing locator key is a problem; an explicit null with the status is fine', () => {
  hasProblem(
    broken((d) => {
      delete d.findings[0].mappings[0].evidence.locator;
    }),
    /evidence\.locator$/,
    'use null with locatorStatus "not-recorded"',
  );
  const ok = structuredClone(RAW);
  ok.findings[0].mappings[0].evidence = {
    summary: 'shown in the second figure',
    kind: 'figure',
    locator: 'Fig. 2',
    locatorStatus: 'recorded',
  };
  assert.ok(validateDataset(ok).dataset);
});

// --- spatial detail --------------------------------------------------------

test('a malformed ALC address in a curated covering is a load failure', () => {
  hasProblem(
    broken((d) => {
      d.findings[7].mappings[0].spatial.cells = ['BV-L-9'];
    }),
    /spatial\.cells\[0\]$/,
    'not a valid ALC address',
  );
  hasProblem(
    broken((d) => {
      d.findings[7].mappings[0].spatial.cells = ['BV-L-1-2'];
    }),
    /spatial\.cells\[0\]$/,
    'not a valid ALC address',
  );
  hasProblem(
    broken((d) => {
      d.findings[7].mappings[0].spatial.cells = ['BD-C08-01I'];
    }),
    /spatial\.cells\[0\]$/,
    'not a valid ALC address',
  );
});

test('curated cells may not claim more precision than the mapping declares', () => {
  hasProblem(
    broken((d) => {
      d.findings[7].mappings[0].spatial = {
        kind: 'cells',
        cells: ['BV-L-041234'],
        method: 'over-precise on purpose',
        digits: 3,
      };
    }),
    /spatial\.cells\[0\]$/,
    'refinement digits but the mapping declares',
  );
});

test('an unknown spatial kind is refused', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].spatial = { kind: 'approximate', reason: 'near enough' };
    }),
    /spatial\.kind$/,
    'must be one of',
  );
});

test('region-level must say why there is no finer location', () => {
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].spatial = { kind: 'region-level' };
    }),
    /spatial\.reason$/,
    'expected a string',
  );
});

test('coordinates must be three finite numbers in a named space', () => {
  hasProblem(
    broken((d) => {
      d.findings[12].mappings[0].spatial.pointsMm = [[-52, -18]];
    }),
    /pointsMm\[0\]$/,
    'three finite numbers',
  );
  hasProblem(
    broken((d) => {
      d.findings[12].mappings[0].spatial.pointsMm = [[-52, null, 7]];
    }),
    /pointsMm\[0\]$/,
    'three finite numbers',
  );
  hasProblem(
    broken((d) => {
      d.findings[12].mappings[0].spatial.pointsMm = [];
    }),
    /spatial\.pointsMm$/,
    'at least one',
  );
  hasProblem(
    broken((d) => {
      d.findings[12].mappings[0].spatial.frame = 'BR';
    }),
    /spatial\.frame$/,
    'must be one of',
  );
});

// --- dataset-level records -------------------------------------------------

test('the dataset must say which index it was authored against', () => {
  hasProblem(
    broken((d) => {
      delete d.authoredAgainst;
    }),
    '$.authoredAgainst',
    'which name index',
  );
  hasProblem(
    broken((d) => {
      d.authoredAgainst.status = 'probably-real';
    }),
    '$.authoredAgainst.status',
    'must be one of',
  );
});

test('a partitioned dataset must say, per structure, which index should name it', () => {
  /** The fixture, re-declared as partitioned over the namespaces it uses. */
  const partitioned = (edit: (p: Raw) => void): Raw => {
    const ids = new Set<string>();
    for (const f of RAW.findings) for (const m of f.mappings) ids.add(m.structureId);
    const a: Raw = {
      status: 'partitioned',
      partitions: [
        {
          id: 'everything',
          status: 'placeholder',
          nameIndexVersion: 'fixture-names-2026.10.1',
          structureIds: [...ids].sort(),
          reason: 'the fixture is synthetic by construction',
        },
      ],
    };
    edit(a);
    return a;
  };

  // A version pinned at the top level alongside partitions would read as if it
  // covered the whole dataset.
  hasProblem(
    broken((d) => {
      d.authoredAgainst = partitioned(() => {});
      d.authoredAgainst.nameIndexVersion = 'fixture-names-2026.10.1';
    }),
    '$.authoredAgainst.nameIndexVersion',
    'must be absent when status is "partitioned"',
  );

  // Partitions on a non-partitioned dataset: two declarations, one of them
  // unchecked.
  hasProblem(
    broken((d) => {
      d.authoredAgainst = { nameIndexVersion: 'fixture-names-2026.10.1', status: 'fixture', partitions: [] };
    }),
    '$.authoredAgainst.partitions',
    'must be absent unless status is "partitioned"',
  );

  // The exhaustiveness rule, in both directions. An id in no partition is
  // gated by nothing; a partition entry no mapping uses is a stale claim.
  hasProblem(
    broken((d) => {
      d.authoredAgainst = partitioned((p) => {
        p.partitions[0].structureIds = p.partitions[0].structureIds.slice(1);
      });
    }),
    '$.authoredAgainst.partitions',
    'no partition contains',
  );
  hasProblem(
    broken((d) => {
      d.authoredAgainst = partitioned((p) => {
        p.partitions[0].structureIds.push('HCP-MMP1:never-mapped');
      });
    }),
    '$.authoredAgainst.partitions',
    'which no mapping uses',
  );
  hasProblem(
    broken((d) => {
      d.authoredAgainst = partitioned((p) => {
        p.partitions.push({ ...p.partitions[0], id: 'twice' });
      });
    }),
    '$.authoredAgainst.partitions',
    'is in both',
  );

  // A placeholder with no reason is indistinguishable from unfinished work;
  // a reason on a resolvable partition is an excuse for nothing.
  hasProblem(
    broken((d) => {
      d.authoredAgainst = partitioned((p) => {
        delete p.partitions[0].reason;
      });
    }),
    '$.authoredAgainst.partitions[0].reason',
    'must record why',
  );
  hasProblem(
    broken((d) => {
      d.authoredAgainst = partitioned((p) => {
        p.partitions[0].status = 'real';
      });
    }),
    '$.authoredAgainst.partitions[0].reason',
    'only a placeholder partition',
  );
});

test('structureIdSources must describe the namespaces the mappings actually use', () => {
  // The hole this closes: the declaration was checked for shape and never
  // against the data, in either direction.
  hasProblem(
    broken((d) => {
      d.structureIdSources = ['HCP-MMP1'];
    }),
    '$.structureIdSources',
    'does not declare "ATLAS-LABEL"',
  );
  hasProblem(
    broken((d) => {
      d.structureIdSources = ['HCP-MMP1', 'ATLAS-LABEL', 'FMA'];
    }),
    '$.structureIdSources[2]',
    'which no mapping uses',
  );
  // A CURIE that disagrees with the namespace it claims. This is the shape a
  // half-finished crosswalk leaves behind.
  hasProblem(
    broken((d) => {
      d.findings[0].mappings[0].structureIdSource = 'FMA';
    }),
    /mappings\[0\]\.structureId$/,
    'but structureIdSource says "FMA"',
  );
});

test('the curation record is required in full', () => {
  for (const key of ['curatedBy', 'curatedOn', 'method', 'citationCheck', 'notRecorded']) {
    hasProblem(
      broken((d) => {
        delete d.curation[key];
      }),
      `$.curation.${key}`,
      /expected|must/,
    );
  }
});

test('a version is required, because a stored highlight without one is unreproducible', () => {
  hasProblem(
    broken((d) => {
      d.version = '';
    }),
    '$.version',
    'must not be empty',
  );
});

test('a non-object dataset is refused without crashing', () => {
  for (const junk of [null, 42, 'research/1', [], undefined]) {
    const { dataset, problems } = validateDataset(junk);
    assert.equal(dataset, null);
    assert.ok(problems.length > 0);
  }
});
