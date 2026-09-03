#!/usr/bin/env node
import { parseHarnessArgs } from "./args.mjs";
import { loadConfig } from "./config.mjs";
import { createClient } from "./http.mjs";
import { Report } from "./report.mjs";
import { runSmoke } from "./suites/smoke.mjs";
import { runContracts } from "./suites/contracts.mjs";
import { runData } from "./suites/data.mjs";

const profiles = {
  smoke: [runSmoke],
  contracts: [runContracts],
  data: [runContracts, runData],
  all: [runSmoke, runContracts, runData],
};

let config;
let profile;
try {
  const parsed = parseHarnessArgs(process.argv.slice(2));
  profile = parsed.profile;
  config = loadConfig(process.env, { baseUrl: parsed.baseUrl });
} catch (error) {
  console.error(`설정 오류: ${error.message}`);
  process.exit(2);
}

console.log(`Betting Analysis Harness — ${profile}`);
console.log(`대상: ${config.baseUrl}\n`);

const context = {
  config,
  client: createClient(config),
  report: new Report(),
  state: {},
};

for (const suite of profiles[profile]) await suite(context);
const counts = context.report.summary();
process.exitCode = counts.FAIL > 0 ? 1 : 0;
