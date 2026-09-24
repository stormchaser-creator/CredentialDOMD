import test from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

// A React hooks violation is not a style problem, it crashes the running app.
//
// On 2026-09-22 a useMemo was placed below AppInner's early returns, so it ran
// on some renders and not others. Every signed-in load died with React error
// #310 and the app looked like it simply would not open. The repo's own eslint
// config already catches this; nothing ran it. This does.
//
// Scoped to the hook rules on purpose: `eslint .` reports about 1,500
// pre-existing errors across the repo, mostly in vendored code, so a blanket
// gate could not be turned on today. These rules are the ones that break users.
const CRASH_RULES = [
  "react-hooks/rules-of-hooks",
  "react-hooks/set-state-in-render",
  // An undefined name is a ReferenceError the moment that line runs. The load
  // path is exercised by a harness that supplies its own globals, so a
  // forgotten import can pass every test and still crash sign-in for real.
  "no-undef",
];

test("no React hooks rule violations anywhere in src", async () => {
  const eslint = new ESLint();
  const results = await eslint.lintFiles(["src"]);
  const offences = [];
  for (const file of results) {
    for (const m of file.messages) {
      if (m.severity === 2 && CRASH_RULES.includes(m.ruleId)) {
        offences.push(`${file.filePath.replace(process.cwd() + "/", "")}:${m.line}  ${m.ruleId}  ${m.message}`);
      }
    }
  }
  assert.deepEqual(offences, [],
    `A hooks violation crashes the app for every user who reaches that render:\n${offences.join("\n")}`);
});
