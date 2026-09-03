import assert from "node:assert/strict";
import test from "node:test";
import { parseHarnessArgs } from "../src/args.mjs";

test("defaults to the all profile without a CLI base URL", () => {
  assert.deepEqual(parseHarnessArgs([]), { profile: "all", baseUrl: undefined });
});

test("preserves the selected profile while parsing --base-url", () => {
  assert.deepEqual(
    parseHarnessArgs(["smoke", "--base-url", "https://example.com/app/"]),
    { profile: "smoke", baseUrl: "https://example.com/app/" },
  );
});

test("accepts --base-url before the profile", () => {
  assert.deepEqual(
    parseHarnessArgs(["--base-url", "http://127.0.0.1:4173", "contracts"]),
    { profile: "contracts", baseUrl: "http://127.0.0.1:4173" },
  );
});

test("rejects unknown, incomplete, duplicate, and extra CLI arguments", () => {
  assert.throws(() => parseHarnessArgs(["--target", "https://example.com"]), /unknown option.*--target/i);
  assert.throws(() => parseHarnessArgs(["all", "--base-url"]), /requires a URL/i);
  assert.throws(() => parseHarnessArgs(["--base-url", "https://one.example", "--base-url", "https://two.example"]), /only be provided once/i);
  assert.throws(() => parseHarnessArgs(["all", "smoke"]), /only one profile/i);
  assert.throws(() => parseHarnessArgs(["unknown"]), /unknown profile.*unknown/i);
});
