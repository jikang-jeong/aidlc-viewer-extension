'use strict';

// Contract for the contrast layer: report both sides, decide nothing.
//
// The behaviour worth protecting is a refusal. It would be easy, and wrong, to
// subtract the sensor's finding count from the record's item count and call the
// difference a discrepancy: the two answer slightly different questions, so a
// computed delta would look authoritative while being made up. These tests pin
// that no such number is produced, alongside the ordinary reading behaviour.
//
// Fixtures are synthesised. Real runs contain customer intent and this is a
// public repository.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const contrast = require('../src/aidlc/contrast');

function project(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-contrast-'));
  build({
    root,
    record(relDir, contents) {
      const dir = path.join(root, relDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, contrast.RECORD_FILENAME),
        typeof contents === 'string' ? contents : JSON.stringify(contents)
      );
    }
  });
  return root;
}

// A ledger summary shaped the way audit.summarise returns one, with only the
// field the contrast layer reads.
function summaryWith(failures) {
  return { sensorFailures: failures };
}

function failure(stage, findingsCount, detailPath) {
  return {
    sensorId: contrast.TRACEABILITY_SENSOR,
    stage,
    findingsCount: findingsCount === undefined ? undefined : String(findingsCount),
    detailPath
  };
}

test('a record and the sensor verdict on it are reported side by side, unreconciled', () => {
  const root = project(({ record }) => {
    record('inception/domain-design', {
      stage: 'domain-design',
      upstream_ids: ['FR1', 'FR2'],
      coverage: [
        { id: 'FR1', status: 'OK' },
        { id: 'FR2', status: 'OK' }
      ]
    });
  });
  const { rows } = contrast.compare(root, summaryWith([failure('domain-design', 89, 'd.md')]));
  const row = rows.find((r) => r.stage === 'domain-design');
  assert.equal(row.itemCount, 2);
  assert.equal(row.byStatus.get('OK'), 2);
  assert.equal(row.sensorFindings, 89);
  assert.equal(row.sensorFirings, 1);
  // The refusal: no field anywhere claims a difference or a verdict.
  for (const key of Object.keys(row)) {
    assert.ok(
      !/discrepanc|mismatch|delta|verdict|correct|wrong/i.test(key),
      `contrast row must not carry a judgement field, found "${key}"`
    );
  }
});

test('the status vocabulary is whatever the record used, not a fixed set', () => {
  // Three real runs produced OK, Deferred and N/A. A fourth may produce something
  // else, and it must be counted under its own name rather than dropped.
  const root = project(({ record }) => {
    record('a/b', {
      stage: 's',
      coverage: [
        { id: '1', status: 'OK' },
        { id: '2', status: 'Deferred' },
        { id: '3', status: 'N/A' },
        { id: '4', status: 'SomethingNobodyHasSeen' },
        { id: '5' }
      ]
    });
  });
  const { rows } = contrast.compare(root, summaryWith([]));
  const row = rows[0];
  assert.equal(row.byStatus.get('Deferred'), 1);
  assert.equal(row.byStatus.get('SomethingNobodyHasSeen'), 1);
  // A row with no status at all is counted, under a name that says so.
  assert.equal(row.byStatus.get('(unstated)'), 1);
  assert.equal(row.itemCount, 5);
});

test('the stage is taken from inside the record, not from its directory', () => {
  // Pairing on the path would break the moment a record is written somewhere
  // unexpected, and the file states its stage outright.
  const root = project(({ record }) => {
    record('some/unexpected/place', { stage: 'user-stories', coverage: [{ id: '1', status: 'OK' }] });
  });
  const { rows } = contrast.compare(root, summaryWith([failure('user-stories', 4)]));
  assert.equal(rows[0].stage, 'user-stories');
  assert.equal(rows[0].sensorFindings, 4);
});

test('records for a stage that repeats per unit are folded, so the sensor count is stated once', () => {
  // The ledger attributes every firing to the stage, never to a unit. Attaching
  // the same totals to each unit's record would report the sensor's count twice.
  const root = project(({ record }) => {
    record('c/functional-design/u1', {
      stage: 'functional-design',
      coverage: [{ id: '1', status: 'OK' }, { id: '2', status: 'OK' }]
    });
    record('c/functional-design/u2', {
      stage: 'functional-design',
      coverage: [{ id: '3', status: 'OK' }]
    });
  });
  const { rows } = contrast.compare(root, summaryWith([failure('functional-design', 167)]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recordCount, 2);
  assert.equal(rows[0].itemCount, 3);
  assert.equal(rows[0].sensorFindings, 167);
});

test('a stage the sensor faulted with no record found is reported separately', () => {
  // "The record disagrees" and "there is no record" are different states and the
  // second must not be silently folded into the first.
  const root = project(() => {});
  const { rows, faultedWithoutRecord } = contrast.compare(
    root,
    summaryWith([failure('nfr-design', 1)])
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(faultedWithoutRecord, ['nfr-design']);
});

test('a record that cannot be parsed is reported as unreadable, not skipped', () => {
  const root = project(({ record }) => {
    record('a/b', '{"stage": "s", "coverage": [');
  });
  const { rows } = contrast.compare(root, summaryWith([]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].readable, false);
});

test('only records the sensor faulted, or could not read, reach the surface', () => {
  const root = project(({ record }) => {
    record('a/passed', { stage: 'passed', coverage: [{ id: '1', status: 'OK' }] });
    record('a/faulted', { stage: 'faulted', coverage: [{ id: '1', status: 'OK' }] });
  });
  const summary = summaryWith([failure('faulted', 3)]);
  assert.equal(contrast.compare(root, summary).rows.length, 2);
  const shown = contrast.contested(root, summary).rows;
  assert.deepEqual(shown.map((r) => r.stage), ['faulted']);
});

test('a finding count the ledger did not state contributes nothing rather than a guess', () => {
  const root = project(({ record }) => {
    record('a/b', { stage: 's', coverage: [{ id: '1', status: 'OK' }] });
  });
  const { rows } = contrast.compare(
    root,
    summaryWith([failure('s', undefined), failure('s', 'not-a-number'), failure('s', 5)])
  );
  assert.equal(rows[0].sensorFirings, 3);
  assert.equal(rows[0].sensorFindings, 5);
});

test('failures from other sensors are ignored, because they judge artifacts with no self-report', () => {
  const root = project(({ record }) => {
    record('a/b', { stage: 's', coverage: [{ id: '1', status: 'OK' }] });
  });
  const { rows, faultedWithoutRecord } = contrast.compare(
    root,
    summaryWith([{ sensorId: 'required-sections', stage: 's', findingsCount: '99' }])
  );
  assert.equal(rows[0].sensorFindings, 0);
  assert.deepEqual(faultedWithoutRecord, []);
});

test('engine bookkeeping directories are not walked', () => {
  // A sensor writes its own detail files under a dot-prefixed directory. Reading
  // those as if they were agent records would invent rows.
  const root = project(({ root: dir }) => {
    const hidden = path.join(dir, '.aidlc-sensors', 'x');
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, contrast.RECORD_FILENAME), '{"stage":"ghost"}');
  });
  assert.deepEqual(contrast.findRecords(root), []);
});

test('a project with no records at all produces nothing to show', () => {
  const root = project(() => {});
  const result = contrast.contested(root, summaryWith([]));
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.faultedWithoutRecord, []);
});

test('an unreadable directory does not throw', () => {
  assert.deepEqual(contrast.findRecords('/nonexistent/nowhere'), []);
});
