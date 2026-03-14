/**
 * Tests for comm persistence load sanitization and atomic write.
 * Run: node --import tsx lib/commPersistence.test.ts  (or: npx tsx lib/commPersistence.test.ts)
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadCommState, scheduleCommSave } from "./commPersistence";

const TEST_DIR = path.join(os.tmpdir(), `comm-persistence-test-${Date.now()}`);

function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  process.env.COMM_STATE_PATH = path.join(TEST_DIR, "comm_state.json");
}

function teardown() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  delete process.env.COMM_STATE_PATH;
}

function writeState(obj: unknown) {
  const p = process.env.COMM_STATE_PATH as string;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

describe("loadCommState", () => {
  before(setup);
  after(teardown);

  it("filters messages with invalid ts (NaN from 'x' or Infinity)", () => {
    writeState({
      channels: {
        "1": [
          { id: "a", ts: "x", from: "ADMIN", text: "bad" },
          { id: "b", ts: 1234567890, from: "ADMIN", text: "good" },
        ],
      },
    });
    const loaded = loadCommState();
    assert.deepStrictEqual(loaded[1]?.map((m) => m.id), ["b"]);
  });

  it("ackedAt='x' becomes undefined (unacked)", () => {
    writeState({
      channels: {
        "1": [{ id: "a", ts: 1234567890, from: "ADMIN", text: "hi", urgent: true, ackedAt: "x" }],
      },
    });
    const loaded = loadCommState();
    assert.strictEqual(loaded[1]?.[0]?.ackedAt, undefined);
  });

  it("urgent='false' does NOT become urgent", () => {
    writeState({
      channels: {
        "1": [{ id: "a", ts: 1234567890, from: "ADMIN", text: "hi", urgent: "false" }],
      },
    });
    const loaded = loadCommState();
    assert.strictEqual(loaded[1]?.[0]?.urgent, false);
  });

  it("pad key '1.9' is rejected (does not overwrite pad 1)", () => {
    writeState({
      channels: {
        "1": [{ id: "a", ts: 1234567890, from: "ADMIN", text: "pad1" }],
        "1.9": [{ id: "b", ts: 1234567890, from: "ADMIN", text: "pad1.9" }],
      },
    });
    const loaded = loadCommState();
    assert.deepStrictEqual(loaded[1]?.map((m) => m.text), ["pad1"]);
    assert.strictEqual(loaded[1.9 as number], undefined);
  });

  it("valid data passes through unchanged", () => {
    writeState({
      channels: {
        "2": [
          { id: "x", ts: 1700000000000, from: "JUDGE", text: "ok", urgent: true, ackedAt: 1700000001000 },
        ],
      },
    });
    const loaded = loadCommState();
    assert.strictEqual(loaded[2]?.length, 1);
    assert.strictEqual(loaded[2]?.[0]?.urgent, true);
    assert.strictEqual(loaded[2]?.[0]?.ackedAt, 1700000001000);
  });
});

describe("scheduleCommSave (atomic write)", () => {
  before(setup);
  after(teardown);

  it("writes to .tmp then renames; tmp does not linger", () => {
    return new Promise<void>((resolve, reject) => {
      const p = process.env.COMM_STATE_PATH as string;
      const tmpPath = p + ".tmp";

      scheduleCommSave(() => ({ 1: [{ id: "t", ts: Date.now(), from: "ADMIN", text: "test" }] }));

      setTimeout(() => {
        try {
          assert.ok(fs.existsSync(p), "final file exists");
          assert.ok(!fs.existsSync(tmpPath), "tmp file does not linger");
          const content = JSON.parse(fs.readFileSync(p, "utf8"));
          assert.strictEqual(content.channels["1"]?.[0]?.text, "test");
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 1100);
    });
  });
});
