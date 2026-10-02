// Administrator access shares a PA's and an NP's licences, not only a
// physician's (20261002060000_credential_portal_app_licenses.sql). Only the
// type check changes: the name check is the 2026-09-25 line, byte for byte.
// These tests fail when the SQL list of licence types drifts from the app's
// (ALL_LICENSE_TYPES), when it refuses a type the app files as a PA, APRN or
// RN licence, prescriptive authority or practice agreement (licenseKindOf),
// when the name check differs from 2026-09-25 in text or in effect, or when a
// record shared before stops being shared. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ALL_LICENSE_TYPES, LICENSE_TYPES_MD, LICENSE_TYPES_DO, LICENSE_TYPES_PA, LICENSE_TYPES_NP } from '../../src/constants/credentialTypes.js';
import { licenseKindOf } from '../../src/constants/professions.js';
import { postgresFixture, pgSkip, quote as q, withSlotWait } from './postgresFixture.mjs';

const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const MIGRATION_PATH = 'supabase/migrations/20261002060000_credential_portal_app_licenses.sql';
const ROLLBACK_PATH = 'docs/rollback/20261002060000_credential_portal_app_licenses.rollback.sql';
const MIGRATION = read(MIGRATION_PATH);
const ROLLBACK = read(ROLLBACK_PATH);
const PREVIOUS = read('supabase/migrations/20260925040000_credential_portal_admin_access.sql');

// "Other" is free text in every profession's list and was never shared.
const NEVER_SHARED_TYPES = ['Other'];
const APP_TYPES = ALL_LICENSE_TYPES.filter(t => !NEVER_SHARED_TYPES.includes(t));
const APP_KINDS = ['pa', 'aprn', 'rn', 'rx', 'agreement'];
// Types this migration shares for the first time.
const NEW_APP_TYPES = ['State Physician Assistant License', 'APRN License (NP)', 'RN License', 'RN License (Multistate)', 'Prescriptive Authority', 'Practice Agreement', 'PANCE', 'NCLEX-RN'];

const sqlListOf = text => {
  const body = text.match(/function public\.credential_portal_license_types\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/)[1];
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replaceAll("''", "'"));
};

// The whole credential_portal_license_ok definition, and its body between the $$.
const licenseOkOf = text => {
  const all = [...text.matchAll(/create or replace function public\.credential_portal_license_ok\(p_type text, p_name text\)[\s\S]*?\n\$\$;/g)];
  assert.equal(all.length, 1, 'one definition of credential_portal_license_ok');
  return all[0][0];
};
const bodyOf = definition => definition.slice(definition.indexOf('as $$\n') + 'as $$\n'.length, definition.lastIndexOf('$$;'));
// The 2026-09-25 name check: the one line of the old body that reads p_name.
const NAME_LINE_PREFIX = "  and coalesce(p_type,'')||' '||coalesce(p_name,'') !~* ";
const nameLineOf = body => {
  const lines = body.split('\n').filter(l => l.includes('p_name'));
  assert.equal(lines.length, 1, 'p_name is read on one line only');
  assert.ok(lines[0].startsWith(NAME_LINE_PREFIX), lines[0]);
  return lines[0];
};
const PREVIOUS_BODY = bodyOf(licenseOkOf(PREVIOUS));
const PREVIOUS_NAME_LINE = nameLineOf(PREVIOUS_BODY);
// The 2026-09-25 type check: its select line, without "select ".
const PREVIOUS_TYPE = PREVIOUS_BODY.split('\n')[0].replace(/^ select /, '');

test('the migration and its rollback follow the deploy rules', () => {
  for (const [rel, text] of [[MIGRATION_PATH, MIGRATION], [ROLLBACK_PATH, ROLLBACK]]) {
    assert.doesNotMatch(text, /^\s*(begin|commit|rollback)\s*;/im, `${rel} has a top-level transaction line`);
    assert.doesNotMatch(text, /\u2014/, `${rel} has an em dash`);
  }
  assert.match(ROLLBACK, /drop function if exists public\.credential_portal_license_types\(\)/);
  // The rollback restores the 2026-09-25 function exactly.
  assert.equal(licenseOkOf(ROLLBACK), licenseOkOf(PREVIOUS));
});

test("the SQL list of licence types is the app's list, without Other", () => {
  const list = sqlListOf(MIGRATION);
  assert.equal(new Set(list).size, list.length, 'no type listed twice');
  assert.deepEqual([...list].sort(), [...APP_TYPES].sort());
  // Each profession's own list is covered, so a type added to one of them
  // fails this test until the SQL lists it too.
  for (const types of [LICENSE_TYPES_MD, LICENSE_TYPES_DO, LICENSE_TYPES_PA, LICENSE_TYPES_NP]) {
    for (const t of types) if (!NEVER_SHARED_TYPES.includes(t)) assert.ok(list.includes(t), t);
  }
});

test('the name check is the 2026-09-25 line byte for byte, and only the type check changed', () => {
  const body = bodyOf(licenseOkOf(MIGRATION));
  // The new body: one parenthesised type check, then the old name line, then nothing.
  assert.equal(nameLineOf(body), PREVIOUS_NAME_LINE);
  assert.ok(body.startsWith(' select (\n'), body);
  assert.ok(body.endsWith(`\n  )\n${PREVIOUS_NAME_LINE}\n`), body);
  const typePart = body.slice(' select (\n'.length, body.length - `\n  )\n${PREVIOUS_NAME_LINE}\n`.length);
  // The type part reads only the type, is a plain "or" of tests, and starts
  // with the 2026-09-25 type check, unchanged.
  assert.doesNotMatch(typePart, /p_name/);
  assert.doesNotMatch(typePart, /\band\b|\bnot\b|!~/i);
  const disjuncts = typePart.split('\n').map(l => l.trim()).map(l => l.replace(/^or /, ''));
  assert.equal(disjuncts[0], PREVIOUS_TYPE);
  for (const d of disjuncts) assert.match(d, /^(coalesce\(p_type,''\) ~\* '|btrim\(coalesce\(p_type,''\)\) = any\(public\.credential_portal_license_types\(\)\)$)/, d);
});

// The 2026-09-25 name check written out in JS (\m and \M as \b).
const PREVIOUS_NAME_REFUSAL = new RegExp(PREVIOUS_NAME_LINE.slice(NAME_LINE_PREFIX.length).replace(/^'|'$/g, '').replaceAll('\\m', '\\b').replaceAll('\\M', '\\b'), 'i');
const nameRefused = (type, name) => PREVIOUS_NAME_REFUSAL.test(`${type || ''} ${name || ''}`);
const PHYSICIAN = /(medical licen[cs]e|state medical|osteopathic|\bdea\b|controlled substance|board|ecfmg|usmle|comlex|\bbls\b|\bacls\b|\batls\b|\bpals\b|\bnrp\b|fluoroscop|laser|certif)/i;
// btrim trims spaces only, where String#trim also trims tabs and line breaks.
const btrim = text => String(text || '').replace(/^ +| +$/g, '');
const typeOk = type => APP_TYPES.includes(btrim(type)) || PHYSICIAN.test(type || '') || APP_KINDS.includes(licenseKindOf(type));
const expected = (type, name) => typeOk(type) && !nameRefused(type, name);

test('the JS copy of the 2026-09-25 name check reads the line it was built from', () => {
  for (const name of ['Travel', 'Compact licence for travel assignments', 'Birth center', 'boarding', 'TSA PreCheck', 'Colorado Driver\'s License', 'Naturalisation']) assert.ok(nameRefused('RN License', name), name);
  for (const name of ['WI Physician Assistant License', 'Synthetic', 'Tsarina', 'Visage', null]) assert.ok(!nameRefused('RN License', name), name);
});

// Licence words split by a line break, CR, or the Unicode line and paragraph
// separators: JS "." stops at each, so the app reads none as a licence.
const LINE_BREAK_TYPES = ['APRN\nlicense', 'RN\nlicense', 'Nurse practitioner\nregistration', 'APRN\rlicense', 'RN\r\nlicense',
  'APRN\u2028license', 'RN\u2029license', 'Registered nurse\nlicence', 'CRNP\nrecognition', 'APRN\n\nLicense (NP)'];

// Code points around JS "\s": the ICU-only spaces (U+001C-U+001F, U+0085),
// the JS-only one (U+FEFF), the other JS spaces, and near misses (U+180E was
// a space in old Unicode, U+200B never was).
const LEADING_CHARACTERS = [0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xfeff, 0x0b, 0x0c, 0xa0, 0x1680, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000, 0x180e, 0x200b, 0x2028]
  .map(c => String.fromCodePoint(c));
const LEADING_TYPES = ['RN License', 'Registered nurse licence', 'Prescriptive Authority', 'Practice Agreement'];

// Types a member can hold: the app's own, what production holds today, and
// what a member or an import may type.
const CORPUS = [
  ...ALL_LICENSE_TYPES,
  'Medical License', 'State Medical License (MD)', 'Board Certification', 'Driver License', 'Marriage Certificate', 'Passport',
  'Physician Associate License', "Physician's Assistant License", 'Physician’s Assistant License', 'Physicians Assistant Licence',
  'physician assistant license', 'PA License', 'ARNP License', 'CRNP Certificate', 'Nurse Practitioner Recognition', 'APN Registration',
  'APRN Approval', 'Registered Nurse License', 'RN licence (compact)', 'rn license', 'Nurse License', 'RN', 'Prescriptive Authority (Schedule II)',
  'Practice Agreement - collaborative', 'practice agreement', 'Practice Notes', 'Prescription pad', 'Collaboration letter',
  'Physician Assistant Program Diploma', 'NCLEX', 'Travel RN License', 'Birth Center Practice Agreement', ' RN License ', '', null,
  // A type from sync, an import or the scanner can carry a line break. A JS
  // "." never crosses one, so licenseKindOf does not read these as licences.
  ...LINE_BREAK_TYPES,
  // And these it does, with the break outside the words it reads.
  '\nRN License', 'RN License\n', 'APRN License (NP)\n', 'RN License (Multistate)\r\n', 'APRN\u00a0License', '\tPANCE', 'PANCE\n',
  // Leading characters: Postgres "\s" follows the database locale (ICU in
  // production: U+001C-U+001F and U+0085 are space, U+FEFF is not), JS "\s"
  // does not, so the SQL spells out the JS class. Each one before the words
  // the app reads, whether or not JS counts it as space.
  ...LEADING_CHARACTERS.flatMap(c => LEADING_TYPES.map(type => `${c}${type}`)),
];

// Ordinary licence names: shared under every type that passes.
const ORDINARY = [null, '', 'Wisconsin', 'Synthetic name', 'WI Physician Assistant License', 'TX APRN License', 'TX RN License', 'NCLEX-RN',
  'Compact licence, Texas', 'Collaborative practice agreement, Synthetic Clinic', 'TX prescriptive authority', 'PANCE', 'Locum tenens licence - Arizona',
  'Tsarina Clinic', 'Visage Dermatology'];

// The 2026-09-25 name matrix: names that rule refused for every record, by
// identity, travel, boarding or birth word, under every spelling and order the
// previous reviews tried, and the licence names around those words the
// decision of 2026-10-02 accepts are not shared.
const NAME_MATRIX = (() => {
  const names = [
    "Colorado Driver's License", 'Driver license', 'Passport scan', 'State ID', 'Photo ID', 'ID card', 'Identification', 'Real ID', 'TSA PreCheck', 'tsa',
    'Global Entry', 'NEXUS card', 'Visa', 'Social Security card', 'SSN', 'Green card', 'Citizenship certificate', 'Naturalization certificate',
    'Naturalisation', 'Marriage certificate', 'Divorce decree', 'Name change order',
    'Birth certificate', 'Certificate of live birth', 'Long form birth', 'Proof of birth', 'Birth', 'Boarding', 'Boarding pass', 'Boarding passage',
    'Birth recordkeeping', 'BIRTH_CERTIFICATE.pdf', 'Travel I.D.', 'Documents for travel', 'ID for travel', 'Scan: travel-documents', 'Travel',
    // Licence names around those words: refused, accepted limitation.
    'Compact licence for travel assignments', 'Birth center collaborative agreement', 'Birthing center agreement', 'Birth centre NRP',
    'Travel NP licence - Arizona', 'Travel locums licence', 'Travel nurse, Texas', 'Travel contract', 'Travel PA, Arizona', 'Travel cardiology',
    'Travel Idaho compact', 'Traveling NP licence', 'Travelling RN - New York', 'Travel nurse 2026', 'Travel locum tenens', 'Travel med-surg',
    'RN licence for travel', 'Travelnurse documents',
  ];
  for (const [a, b] of [['Birth', 'certificate'], ['birth', 'cert'], ['Birth', 'record'], ['Boarding', 'pass'], ['Boarding', 'card'], ['Travel', 'document'],
    ['Travel', 'itinerary'], ['Travel', 'ID'], ['travel', 'visa'], ['Travel', 'card']]) {
    for (const sep of [' ', '  ', '-', '_', '', '.', ' / ', ', ']) names.push(`${a}${sep}${b}`);
  }
  for (const a of ['Travel', 'travel', 'Traveling', 'Travelling', 'Traveler', 'Travellers', 'Travel-related', 'Travel related', 'Travel  -']) {
    for (const b of ['document', 'documents', 'documentation', 'docs', 'papers', 'paperwork', 'authorization', 'authorisation', 'records', 'record', 'itin', 'itinerary',
      'ID', 'card', 'visa', 'permit', 'pass', 'passport', 'ticket', 'insurance', 'approval', 'letter', 'clearance', 'waiver', 'scan', 'copy', 'file', 'form', 'info', '2026', '']) {
      names.push(`${a} ${b}`, `${b} ${a}`);
    }
  }
  const phrases = ['Travel nurse', 'Travel RN', 'Travel physician', 'Travel locums', 'Travel assignment', 'Travel contract', 'Travel license',
    'Travel cardiology', 'Travel Idaho compact', 'Traveling NP', 'Travelling RN New York', 'Traveler PA', 'Travel ICU nurse', 'Travel doctor locums licence'];
  const documents = ['documents', 'documentation', 'papers', 'records', 'authorization', 'ID', 'I.D.', 'flight confirmation', 'itinerary', 'ticket',
    'booking', 'hotel', 'insurance', 'receipt', 'card', 'pass', 'scan', 'letter', 'clearance', 'stuff', 'packet'];
  for (const phrase of phrases) {
    names.push(phrase);
    for (const doc of documents) names.push(`${phrase} ${doc}`, `${doc} ${phrase}`, `${phrase}, Texas - ${doc}`, `${phrase} licence ${doc}`);
  }
  return [...new Set(names)];
})();

test('every name in the matrix was refused by the 2026-09-25 name check', () => {
  for (const name of NAME_MATRIX) assert.ok(nameRefused('', name), name);
  for (const name of ORDINARY) assert.ok(!nameRefused('', name), String(name));
  assert.ok(NAME_MATRIX.length > 1000, `${NAME_MATRIX.length} names`);
});

test('a PA, APRN, RN, prescriptive authority and practice agreement licence is shareable; a non-licence is not', { timeout: withSlotWait(180000), skip: pgSkip() }, async t => {
  const db = await postgresFixture({ port: 57421 });
  t.after(() => db.close());
  const ok = async (type, name = null) => (await db.sql(`select public.credential_portal_license_ok(${q(type)}, ${q(name)})`)) === 't';
  // The function before this migration, from its own file, under another
  // name, and its name check alone.
  await db.sql(licenseOkOf(PREVIOUS).replace('public.credential_portal_license_ok', 'public.previous_license_ok'), 'postgres');
  await db.sql(`create or replace function public.previous_name_ok(p_type text, p_name text) returns boolean language sql immutable as $$
 select true
${PREVIOUS_NAME_LINE}
$$;`, 'postgres');
  // Every type and name pair in one query, crossed inside Postgres.
  // collation: run every function under that collation, as a database whose
  // default locale it is would (production: ICU en-US).
  const cross = (types, names, collation = null) => {
    const c = collation ? ` collate "${collation}"` : '';
    return `(select tt.t, nn.n, public.credential_portal_license_ok(tt.t${c}, nn.n${c}) now, public.previous_license_ok(tt.t${c}, nn.n${c}) before,
      public.previous_name_ok(tt.t${c}, nn.n${c}) name_ok, public.previous_name_ok(''${c}, nn.n${c}) name_alone_ok
    from json_array_elements_text(${q(JSON.stringify(types))}::json) tt(t) cross join json_array_elements_text(${q(JSON.stringify(names))}::json) nn(n)) x`;
  };
  const pairs = async (types, names, collation) => JSON.parse(await db.sql(`select coalesce(json_agg(json_build_array(t, n, now, before, name_ok) order by t, n), '[]') from ${cross(types, names, collation)}`, 'postgres'));

  await t.test('the live function body carries the 2026-09-25 name line byte for byte', async () => {
    const live = await db.sql(`select prosrc from pg_proc where oid = 'public.credential_portal_license_ok(text,text)'::regprocedure`, 'postgres');
    const previous = await db.sql(`select prosrc from pg_proc where oid = 'public.previous_license_ok(text,text)'::regprocedure`, 'postgres');
    assert.equal(nameLineOf(live), nameLineOf(previous));
    assert.equal(nameLineOf(live), PREVIOUS_NAME_LINE);
    // psql trims the trailing newline of the body.
    assert.ok(live.endsWith(`\n  )\n${PREVIOUS_NAME_LINE}`), live);
  });

  await t.test('the live list equals the app list', async () => {
    const live = JSON.parse(await db.sql(`select to_json(public.credential_portal_license_types())`));
    assert.deepEqual([...live].sort(), [...APP_TYPES].sort());
  });

  await t.test('every type the app offers any profession is shareable under an ordinary name, Other never', async () => {
    for (const type of APP_TYPES) for (const name of ORDINARY) assert.equal(await ok(type, name), true, `${type} / ${name}`);
    assert.equal(await ok('Other', 'Synthetic'), false);
    for (const type of NEW_APP_TYPES) assert.equal(await ok(type, 'Synthetic'), true, type);
    for (const type of NEW_APP_TYPES) {
      assert.equal(await db.sql(`select public.previous_license_ok(${q(type)}, 'Synthetic')`, 'postgres'), 'f', `${type} was refused before this migration`);
    }
  });

  await t.test('a typed PA, APRN or RN licence, prescriptive authority or practice agreement is shared under an ordinary name', async () => {
    for (const type of CORPUS.filter(t => APP_KINDS.includes(licenseKindOf(t)))) {
      for (const name of ORDINARY) assert.equal(await ok(type, name), !nameRefused(type, name), `${type} / ${name}`);
    }
  });

  await t.test('the SQL reads every type and name as the JS rule does', async () => {
    const rows = await pairs(CORPUS, [...ORDINARY, ...NAME_MATRIX.slice(0, 400)]);
    assert.ok(rows.length > 10000, `${rows.length} pairs`);
    for (const [type, name, now] of rows) assert.equal(now, expected(type, name), `${JSON.stringify(type)} / ${JSON.stringify(name)}`);
  });

  // Production's database locale is ICU (en_US.UTF-8, provider i), where
  // Postgres "\s" and "\y" differ from this C-locale cluster. The same
  // comparison under the ICU en-US collation, which selects the same regex
  // rules as an ICU default locale.
  const ICU = 'en-US-x-icu';
  const icuMissing = await db.sql(`select count(*) = 0 from pg_collation where collname = ${q(ICU)}`, 'postgres') === 't';
  await t.test('under the ICU locale production uses, the SQL still reads every type and name as the JS rule does', { skip: icuMissing && `collation ${ICU} not in this PostgreSQL build` }, async () => {
    // The collation really changes the regex rules: an ICU "\s" takes U+001F, a C one does not.
    assert.equal(await db.sql(`select chr(31) collate "${ICU}" ~ '^\\s$', chr(31) collate "C" ~ '^\\s$'`, 'postgres'), 't|f');
    const rows = await pairs(CORPUS, [...ORDINARY, ...NAME_MATRIX.slice(0, 400)], ICU);
    assert.ok(rows.length > 10000, `${rows.length} pairs`);
    for (const [type, name, now] of rows) assert.equal(now, expected(type, name), `ICU ${JSON.stringify(type)} / ${JSON.stringify(name)}`);
    // The leading characters, one by one: shared exactly when the app reads the type.
    for (const c of LEADING_CHARACTERS) for (const type of LEADING_TYPES) {
      const typed = `${c}${type}`;
      const live = await db.sql(`select public.credential_portal_license_ok(${q(typed)} collate "${ICU}", 'Synthetic' collate "${ICU}")`, 'postgres');
      assert.equal(live === 't', APP_KINDS.includes(licenseKindOf(typed)), `U+${c.codePointAt(0).toString(16)} ${type}`);
    }
  });

  await t.test('every record the 2026-09-25 rule refused for its name is still refused, under every type', async () => {
    const types = [...new Set([...CORPUS, ...APP_TYPES])];
    const result = JSON.parse(await db.sql(`select json_build_object(
        'pairs', count(*),
        'refusedForName', count(*) filter (where not name_alone_ok),
        'names', count(distinct n) filter (where not name_alone_ok),
        'leaks', coalesce(json_agg(json_build_array(t, n)) filter (where now and not name_ok), '[]'),
        'nameLeaks', coalesce(json_agg(json_build_array(t, n)) filter (where now and not name_alone_ok), '[]'))
      from ${cross(types, NAME_MATRIX)}`, 'postgres'));
    assert.equal(result.pairs, types.length * NAME_MATRIX.length);
    assert.equal(result.names, NAME_MATRIX.length, 'every matrix name was refused by 2026-09-25 for its name');
    assert.equal(result.refusedForName, result.pairs);
    assert.deepEqual(result.nameLeaks, []);
    assert.deepEqual(result.leaks, []);
  });

  await t.test('every record shared before is still shared, and a new share differs only by type', async () => {
    const result = JSON.parse(await db.sql(`select json_build_object(
        'pairs', count(*),
        'lost', coalesce(json_agg(json_build_array(t, n)) filter (where before and not now), '[]'),
        'undecomposed', coalesce(json_agg(json_build_array(t, n)) filter (where now and not name_ok), '[]'),
        'newTypes', coalesce(json_agg(distinct t) filter (where now and not before), '[]'),
        'newlyShared', count(*) filter (where now and not before))
      from ${cross(CORPUS, [...ORDINARY, ...NAME_MATRIX])}`, 'postgres'));
    assert.equal(result.pairs, CORPUS.length * (ORDINARY.length + NAME_MATRIX.length));
    assert.deepEqual(result.lost, [], 'a record shared before is no longer shared');
    // Shared = the type passes and the 2026-09-25 name check passes.
    assert.deepEqual(result.undecomposed, []);
    assert.ok(result.newlyShared > 0);
    for (const type of result.newTypes) {
      assert.ok(APP_TYPES.includes(String(type).trim()) || APP_KINDS.includes(licenseKindOf(type)), `${type} newly shared`);
    }
  });

  await t.test('an identity document filed under any licence type is still refused', async () => {
    for (const type of ['State Physician Assistant License', 'APRN License (NP)', 'RN License', 'Prescriptive Authority', 'Practice Agreement']) {
      assert.equal(await ok(type, "Wisconsin Driver's License"), false, type);
      assert.equal(await ok(type, 'Passport scan'), false, type);
    }
    assert.equal(await ok('Driver License', 'RN License'), false);
    assert.equal(await ok('Travel RN License', 'Compact'), false);
    assert.equal(await ok('Birth Center Practice Agreement', 'Synthetic'), false);
  });

  await t.test('accepted limitation: a licence named for travel or a birth center is not shared', async () => {
    for (const [type, name] of [['RN License (Multistate)', 'Compact licence for travel assignments'], ['Practice Agreement', 'Birth center collaborative agreement'],
      ['APRN License (NP)', 'Travel NP licence - Arizona'], ['State Medical License', 'Travel locums licence']]) {
      assert.equal(await ok(type, name), false, `${type} / ${name}`);
    }
  });

  await t.test('a type split across lines is refused, as licenseKindOf does not read it as a licence', async () => {
    for (const type of LINE_BREAK_TYPES) {
      assert.ok(!APP_KINDS.includes(licenseKindOf(type)) && !PHYSICIAN.test(type), JSON.stringify(type));
      assert.equal(await ok(type, 'Synthetic'), false, JSON.stringify(type));
      assert.equal(await db.sql(`select public.previous_license_ok(${q(type)}, 'Synthetic')`, 'postgres'), 'f', JSON.stringify(type));
    }
    // Words on one line still read, whatever surrounds them.
    for (const type of ['\nRN License', 'RN License\n', 'APRN License (NP)\n', 'APRN\u00a0License']) {
      assert.ok(APP_KINDS.includes(licenseKindOf(type)), JSON.stringify(type));
      assert.equal(await ok(type, 'Synthetic'), true, JSON.stringify(type));
    }
  });

  await t.test('accepted limitation: an excluded word in the type refuses the record whatever its name; a listed type has none', async () => {
    // Renaming does not share it; changing the type to a listed one does.
    for (const [type, name] of [['RN License (travel)', 'TX RN License'], ['Travel Nurse Certification', 'TX RN cert'], ['APRN License (birth center)', 'Synthetic']]) {
      assert.ok(typeOk(type), type);
      assert.equal(await ok(type, name), false, `${type} / ${name}`);
      assert.equal(await ok(type, 'Synthetic'), false, `${type} / Synthetic`);
    }
    assert.equal(await ok('RN License', 'TX RN License'), true);
    assert.equal(await ok('Certification', 'TX RN cert'), true);
    for (const type of APP_TYPES) assert.ok(!nameRefused(type, ''), `${type} carries an excluded word`);
  });

  await t.test('only the service role may run either function', async () => {
    const grants = await db.rows(`select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') can
      from pg_proc p cross join pg_roles r where p.proname in ('credential_portal_license_ok','credential_portal_license_types')
      and r.rolname in ('anon','authenticated','service_role') order by 1, 2`, 'postgres');
    assert.deepEqual(grants.map(g => [g.proname, g.rolname, g.can]), [
      ['credential_portal_license_ok', 'anon', false], ['credential_portal_license_ok', 'authenticated', false], ['credential_portal_license_ok', 'service_role', true],
      ['credential_portal_license_types', 'anon', false], ['credential_portal_license_types', 'authenticated', false], ['credential_portal_license_types', 'service_role', true],
    ]);
    // No grant to PUBLIC either.
    const publicAcl = await db.sql(`select count(*) from pg_proc p, aclexplode(p.proacl) a
      where p.proname in ('credential_portal_license_ok','credential_portal_license_types') and a.grantee = 0`, 'postgres');
    assert.equal(publicAcl, '0');
  });

  await t.test('the rollback restores the physician-only check and runs twice; the migration then applies again', async () => {
    await db.sql(ROLLBACK, 'postgres'); await db.sql(ROLLBACK, 'postgres');
    assert.equal(await ok('State Physician Assistant License'), false);
    assert.equal(await ok('State Medical License (DO)', 'Colorado'), true);
    assert.equal(await db.sql(`select to_regprocedure('public.credential_portal_license_types()') is null`, 'postgres'), 't');
    await db.sql(MIGRATION, 'postgres'); await db.sql(MIGRATION, 'postgres');
    assert.equal(await ok('State Physician Assistant License'), true);
    assert.equal(await ok('APRN License (NP)'), true);
  });
});
