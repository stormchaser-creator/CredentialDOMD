import test from "node:test";
import assert from "node:assert/strict";
import { reconcileDocumentLinks } from "../src/utils/documentLinks.js";

const NEW = ["licenses", "documents", "customRecords"];
const ids = (r) => Object.fromEntries(r.documents.map(d => [d.id, d.linkedTo || ""]));

test("a link to a record that no longer exists is cleared", () => {
  const r = reconcileDocumentLinks({ licenses: [], documents: [{ id: "d", linkedTo: "licenses:GONE" }] }, NEW);
  assert.equal(ids(r).d, "");
  assert.equal(r.cleared.length, 1);
});

test("a live link is kept", () => {
  const r = reconcileDocumentLinks({ licenses: [{ id: "L" }], documents: [{ id: "d", linkedTo: "licenses:L" }] }, NEW);
  assert.equal(ids(r).d, "licenses:L");
  assert.equal(r.cleared.length + r.relinked.length, 0);
});

test("a link written by a NEWER version is never cleared", () => {
  // The bug this file exists for: the old sweep cleared any link it could not
  // match, in the cloud, so an old tab on a second device unfiled everything
  // filed into a collection newer than itself.
  const OLD = ["licenses", "documents"];
  const r = reconcileDocumentLinks({ licenses: [], documents: [{ id: "d", linkedTo: "customRecords:C1" }] }, OLD);
  assert.equal(ids(r).d, "customRecords:C1");
  assert.equal(r.cleared.length, 0);
});

test("a document an older version unfiled is put back where its record says", () => {
  const data = { customRecords: [{ id: "C1", documentIds: ["d"] }], documents: [{ id: "d", linkedTo: "" }] };
  const r = reconcileDocumentLinks(data, NEW);
  assert.equal(ids(r).d, "customRecords:C1");
  assert.equal(r.relinked.length, 1);
});

test("a document filed somewhere else since is never pulled back", () => {
  const data = {
    licenses: [{ id: "L" }],
    customRecords: [{ id: "C1", documentIds: ["d"] }],
    documents: [{ id: "d", linkedTo: "licenses:L" }],
  };
  const r = reconcileDocumentLinks(data, NEW);
  assert.equal(ids(r).d, "licenses:L");
  assert.equal(r.relinked.length, 0);
});

test("a claim from a deleted record restores nothing", () => {
  const data = { customRecords: [], documents: [{ id: "d", linkedTo: "" }] };
  assert.equal(ids(reconcileDocumentLinks(data, NEW)).d, "");
});

test("paused application links count as live", () => {
  const r = reconcileDocumentLinks({ documents: [{ id: "d", linkedTo: "answerBank:A1" }] }, NEW, ["answerBank:A1"]);
  assert.equal(ids(r).d, "answerBank:A1");
});

test("malformed input is survivable", () => {
  assert.doesNotThrow(() => reconcileDocumentLinks(undefined, NEW));
  assert.doesNotThrow(() => reconcileDocumentLinks({ documents: [null, 7, { id: "x" }], customRecords: [{ id: "C", documentIds: "nope" }] }, NEW));
  assert.doesNotThrow(() => reconcileDocumentLinks({ documents: [{ id: "x", linkedTo: 5 }] }, null));
});

test("links no version ever writes are cleared, so the file is reachable again", () => {
  for (const bad of ["justAnId", "licenses:", "documents:d2", ":x"]) {
    const r = reconcileDocumentLinks({ licenses: [{ id: "L" }], documents: [{ id: "d", linkedTo: bad }] }, NEW);
    assert.equal(ids(r).d, "", `${JSON.stringify(bad)} must be cleared`);
  }
  // but a well-formed link from a newer version still stands
  const r = reconcileDocumentLinks({ documents: [{ id: "d", linkedTo: "someFutureSection:X" }] }, NEW);
  assert.equal(ids(r).d, "someFutureSection:X");
});
