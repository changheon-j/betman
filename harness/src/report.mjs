export class Report {
  #results = [];

  async check(suite, name, operation) {
    try {
      const detail = await operation();
      this.#results.push({ status: "PASS", suite, name, detail });
      console.log(`PASS  [${suite}] ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (error) {
      this.#results.push({ status: "FAIL", suite, name, detail: error.message });
      console.error(`FAIL  [${suite}] ${name} — ${error.message}`);
    }
  }

  skip(suite, name, detail) {
    this.#results.push({ status: "SKIP", suite, name, detail });
    console.log(`SKIP  [${suite}] ${name} — ${detail}`);
  }

  summary() {
    const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
    for (const result of this.#results) counts[result.status] += 1;
    console.log(`\n결과: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped`);
    return counts;
  }
}
