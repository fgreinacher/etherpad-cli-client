/**
 * Downstream wire-compatibility vectors.
 *
 * Phase 2 of ether/etherpad#7923: the core repo ships a canonical wire-format
 * fixture, and every client must decode it identically. This test loads that
 * fixture and replays each vector through THIS repo's own Changeset /
 * AttributePool decoders, asserting the resulting text matches byte-for-byte.
 *
 * The fixture path is overridable via the ETHERPAD_WIRE_VECTORS env var,
 * defaulting to the vendored copy under test/fixtures/.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import * as Changeset from '../src/Changeset.js';
import AttributePool, {type JsonableAttributePool} from '../src/AttributePool.js';

interface WireVector {
  name: string;
  initialText: string;
  changeset: string;
  pool: JsonableAttributePool;
  resultText: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, 'fixtures', 'wire-vectors.json');
const fixturePath = process.env.ETHERPAD_WIRE_VECTORS || defaultPath;

const vectors = JSON.parse(readFileSync(fixturePath, 'utf8')) as WireVector[];

assert.ok(Array.isArray(vectors) && vectors.length > 0, `no vectors found in ${fixturePath}`);

for (const vector of vectors) {
  test(`wire-vector: ${vector.name}`, () => {
    // Reconstruct the attribute pool exactly as it arrived on the wire.
    const pool = new AttributePool().fromJsonable(vector.pool);

    // Apply the changeset to the starting text using the repo's own decoder.
    // applyToText is text-only (attributes do not change document text), which
    // is exactly what the resultText assertion checks; the pool round-trip is
    // exercised so a broken fromJsonable would surface via applyToAText below.
    const text = Changeset.applyToText(vector.changeset, vector.initialText);
    assert.equal(text, vector.resultText, `text mismatch for ${vector.name}`);

    // Also drive the full attributed-text path so the AttributePool decode is
    // genuinely exercised (mustGetAttrib resolves the *N slots against pool).
    const atext = {text: vector.initialText, attribs: ''};
    const applied = Changeset.applyToAText(vector.changeset, atext, pool);
    assert.equal(applied.text, vector.resultText, `atext mismatch for ${vector.name}`);
  });
}
