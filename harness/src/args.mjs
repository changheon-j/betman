export const HARNESS_PROFILES = ["smoke", "contracts", "data", "all"];

export function parseHarnessArgs(argv) {
  let profile;
  let baseUrl;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--")) {
      if (argument !== "--base-url") throw new Error(`Unknown option: ${argument}`);
      if (baseUrl !== undefined) throw new Error("--base-url may only be provided once.");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--base-url requires a URL.");
      baseUrl = value;
      index += 1;
      continue;
    }

    if (profile !== undefined) throw new Error("Only one profile may be provided.");
    if (!HARNESS_PROFILES.includes(argument)) throw new Error(`Unknown profile: ${argument}`);
    profile = argument;
  }

  return { profile: profile ?? "all", baseUrl };
}
