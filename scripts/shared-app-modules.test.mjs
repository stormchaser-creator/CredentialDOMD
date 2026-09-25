// The app modules the edge functions share, copied under
// supabase/functions/_shared/app/ by scripts/sync-shared-app-modules.mjs.
//
// A copy that drifts from its source is a second scanner prompt, a second
// identifier gate, a second set of category rules: a certificate forwarded to
// docs@ would be read and filed differently from the same certificate
// uploaded in the app, and nobody would see it until a physician did. So every
// copy must be its source to the byte, and nothing else may live there.
// Run: node --test scripts/shared-app-modules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT, SOURCE_DIR, TARGET_DIR, ROOTS, planCopies, driftProblems, importsOf, specifierProblem, banner,
} from "./sync-shared-app-modules.mjs";

test("every shared copy matches its source (run node scripts/sync-shared-app-modules.mjs if not)", () => {
  assert.deepEqual(driftProblems(), []);
});

test("the copy set follows imports from the roots", () => {
  const rels = planCopies().map((p) => p.rel);
  for (const r of ROOTS) assert.ok(rels.includes(r), `${r} is copied`);
  // The dependencies the scanner and the category rules pull in.
  for (const dep of ["utils/scanDates.js", "utils/receiptScan.js", "constants/expenseCategories.js"]) {
    assert.ok(rels.includes(dep), `${dep} is copied because a root imports it`);
  }
});

test("every import inside a copy is relative, has its extension and resolves to another copy", () => {
  const plan = planCopies();
  const have = new Set(plan.map((p) => p.rel));
  for (const p of plan) {
    for (const spec of importsOf(p.content)) {
      assert.equal(specifierProblem(spec), "", `${p.target}: ${spec}`);
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(p.rel), spec));
      assert.ok(have.has(next), `${p.target} imports ${spec}, which is not in the copy set`);
    }
  }
});

test("each copy exports exactly what its source exports", async () => {
  for (const p of planCopies()) {
    const src = await import(pathToFileURL(path.join(REPO_ROOT, p.source)).href);
    const copy = await import(pathToFileURL(path.join(REPO_ROOT, p.target)).href);
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(src).sort(), p.target);
  }
});

test("the scanner prompt the edge function sends is the app's prompt", async () => {
  const src = await import(pathToFileURL(path.join(REPO_ROOT, SOURCE_DIR, "utils/scannerCore.js")).href);
  const copy = await import(pathToFileURL(path.join(REPO_ROOT, TARGET_DIR, "utils/scannerCore.js")).href);
  for (const deg of ["DO", "MD", ""]) {
    for (const cats of [[], ["Hospital ID Badges"]]) {
      assert.equal(copy.SYSTEM_PROMPT(deg, cats), src.SYSTEM_PROMPT(deg, cats));
      const parts = [{ inlineData: { mimeType: "application/pdf", data: "AAAA" } }, { text: src.scanPdfText(deg) }];
      assert.deepEqual(copy.scanRequestBody({ degreeType: deg, categories: cats, parts }), src.scanRequestBody({ degreeType: deg, categories: cats, parts }));
    }
  }
  // The typographic apostrophe in the travel type list must survive the copy
  // as the character the model is asked for, not as a literal backslash-u.
  assert.ok(copy.SYSTEM_PROMPT("DO").includes(`Driver${String.fromCodePoint(0x2019)}s License`));
});

test("a drifted or stray copy is reported", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shared-app-"));
  try {
    cpSync(path.join(REPO_ROOT, SOURCE_DIR, "utils"), path.join(dir, SOURCE_DIR, "utils"), { recursive: true });
    cpSync(path.join(REPO_ROOT, SOURCE_DIR, "constants"), path.join(dir, SOURCE_DIR, "constants"), { recursive: true });
    cpSync(path.join(REPO_ROOT, TARGET_DIR), path.join(dir, TARGET_DIR), { recursive: true });
    assert.deepEqual(driftProblems(dir), []);

    const target = path.join(dir, TARGET_DIR, "utils/customCategories.js");
    writeFileSync(target, readFileSync(target, "utf8").replace("mrn|medical", "medical"));
    assert.deepEqual(driftProblems(dir), [`${TARGET_DIR}/utils/customCategories.js differs from ${SOURCE_DIR}/utils/customCategories.js`]);

    writeFileSync(target, banner("utils/customCategories.js") + readFileSync(path.join(dir, SOURCE_DIR, "utils/customCategories.js"), "utf8"));
    mkdirSync(path.join(dir, TARGET_DIR, "utils"), { recursive: true });
    writeFileSync(path.join(dir, TARGET_DIR, "utils/forked.js"), "export const x = 1;\n");
    assert.deepEqual(driftProblems(dir), [`${TARGET_DIR}/utils/forked.js has no source in the copy set`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an extensionless or package import is refused", () => {
  assert.match(specifierProblem("./receiptScan"), /no \.js extension/);
  assert.match(specifierProblem("react"), /not a relative path/);
  assert.equal(specifierProblem("../constants/expenseCategories.js"), "");
  assert.deepEqual(importsOf(`import a from "./a.js";\nexport { b } from "../b.js";\nconst c = await import("./c.js");`), ["./a.js", "../b.js", "./c.js"]);
});
