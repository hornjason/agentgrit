import { describe, expect, it } from "bun:test";

function parseArgs(args: string[]): { text?: string; issue?: number; file?: string; limit: number; verbose: boolean } {
  let text: string | undefined;
  let issue: number | undefined;
  let file: string | undefined;
  let limit = 10;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text" && args[i + 1]) {
      text = args[++i];
    } else if (args[i] === "--issue" && args[i + 1]) {
      issue = parseInt(args[++i], 10);
    } else if (args[i] === "--file" && args[i + 1]) {
      file = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10) || 10;
    } else if (args[i] === "--verbose") {
      verbose = true;
    }
  }

  return { text, issue, file, limit, verbose };
}

describe("context parseArgs --verbose", () => {
  it("returns verbose: true when --verbose present", () => {
    const result = parseArgs(["--text", "hello", "--verbose"]);
    expect(result.verbose).toBe(true);
    expect(result.text).toBe("hello");
  });

  it("returns verbose: false when --verbose absent", () => {
    const result = parseArgs(["--text", "hello"]);
    expect(result.verbose).toBe(false);
  });

  it("works with --verbose before other flags", () => {
    const result = parseArgs(["--verbose", "--text", "test query", "--limit", "5"]);
    expect(result.verbose).toBe(true);
    expect(result.text).toBe("test query");
    expect(result.limit).toBe(5);
  });

  it("parses all flags correctly alongside verbose", () => {
    const result = parseArgs(["--text", "query", "--issue", "42", "--verbose", "--limit", "20"]);
    expect(result.verbose).toBe(true);
    expect(result.text).toBe("query");
    expect(result.issue).toBe(42);
    expect(result.limit).toBe(20);
  });
});
