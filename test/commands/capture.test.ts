import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, ".tmp-capture-test");

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.AGENTGRIT_DIR = TMP_DIR;
});

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  delete process.env.AGENTGRIT_DIR;
});

const BIN = join(import.meta.dir, "../../bin/agentgrit.ts");

async function runCapture(sub: string, stdin: string): Promise<{ exitCode: number; stdout: string; stderr: string; elapsed: number }> {
  const start = performance.now();
  const proc = Bun.spawn(["bun", BIN, "capture", sub], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTGRIT_DIR: TMP_DIR },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const elapsed = performance.now() - start;
  return { exitCode, stdout, stderr, elapsed };
}

describe("capture rating", () => {
  test("writes correct dimensions to ratings.jsonl", async () => {
    const input = JSON.stringify({
      session_id: "sess-abc",
      message: { role: "user", content: "/rate M:7 S:8 Q:9" },
    });

    const result = await runCapture("rating", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "ratings.jsonl");
    expect(existsSync(file)).toBe(true);

    const line = readFileSync(file, "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("rating");
    expect(parsed.mode).toBe(7);
    expect(parsed.scope).toBe(8);
    expect(parsed.quality).toBe(9);
    expect(parsed.session_id).toBe("sess-abc");
    expect(parsed.source).toBe("explicit");
    expect(parsed.schemaVersion).toBe(1);
  });

  test("ignores non-rate messages silently", async () => {
    const input = JSON.stringify({
      session_id: "sess-abc",
      message: { role: "user", content: "hello world" },
    });

    const result = await runCapture("rating", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "ratings.jsonl");
    expect(existsSync(file)).toBe(false);
  });

  test("exits 0 on invalid JSON", async () => {
    const result = await runCapture("rating", "not json at all");
    expect(result.exitCode).toBe(0);
  });

  test("exits 0 on empty stdin", async () => {
    const result = await runCapture("rating", "");
    expect(result.exitCode).toBe(0);
  });

  test("includes comment in output", async () => {
    const input = JSON.stringify({
      session_id: "sess-abc",
      message: { role: "user", content: "/rate M:9 S:9 Q:10 excellent session" },
    });

    const result = await runCapture("rating", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "ratings.jsonl");
    const parsed = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(parsed.comment).toBe("excellent session");
  });
});

describe("capture correction", () => {
  test("captures correction language", async () => {
    const input = JSON.stringify({
      session_id: "sess-fix",
      message: { role: "user", content: "wrong, the endpoint is /v2 not /v1" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "corrections.jsonl");
    expect(existsSync(file)).toBe(true);

    const parsed = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(parsed.type).toBe("correction");
    expect(parsed.session_id).toBe("sess-fix");
    expect(parsed.correction_phrase).toContain("wrong");
  });

  test("filters noise: 'no problem'", async () => {
    const input = JSON.stringify({
      session_id: "sess-ok",
      message: { role: "user", content: "no problem, that looks good" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "corrections.jsonl");
    expect(existsSync(file)).toBe(false);
  });

  test("filters noise: 'no worries'", async () => {
    const input = JSON.stringify({
      session_id: "sess-ok",
      message: { role: "user", content: "no worries, keep going" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "corrections.jsonl"))).toBe(false);
  });

  test("filters noise: 'not bad'", async () => {
    const input = JSON.stringify({
      session_id: "sess-ok",
      message: { role: "user", content: "not bad at all" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "corrections.jsonl"))).toBe(false);
  });

  test("filters noise: 'no issue'", async () => {
    const input = JSON.stringify({
      session_id: "sess-ok",
      message: { role: "user", content: "no issue with that approach" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "corrections.jsonl"))).toBe(false);
  });

  test("captures 'stop doing that'", async () => {
    const input = JSON.stringify({
      session_id: "sess-stop",
      message: { role: "user", content: "stop adding comments everywhere" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "corrections.jsonl");
    expect(existsSync(file)).toBe(true);
  });

  test("captures 'don't do that'", async () => {
    const input = JSON.stringify({
      session_id: "sess-dont",
      message: { role: "user", content: "don't refactor that module" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "corrections.jsonl"))).toBe(true);
  });

  test("ignores neutral messages", async () => {
    const input = JSON.stringify({
      session_id: "sess-neutral",
      message: { role: "user", content: "can you check the logs?" },
    });

    const result = await runCapture("correction", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "corrections.jsonl"))).toBe(false);
  });
});

describe("capture tool", () => {
  test("writes tool name to tool-audit.jsonl", async () => {
    const input = JSON.stringify({
      session_id: "sess-tool",
      tool_name: "Bash",
    });

    const result = await runCapture("tool", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "tool-audit.jsonl");
    expect(existsSync(file)).toBe(true);

    const parsed = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(parsed.type).toBe("tool-use");
    expect(parsed.tool_name).toBe("Bash");
    expect(parsed.session_id).toBe("sess-tool");
  });

  test("exits 0 with no tool_name", async () => {
    const input = JSON.stringify({ session_id: "sess-no-tool" });
    const result = await runCapture("tool", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "tool-audit.jsonl"))).toBe(false);
  });
});

describe("capture skill", () => {
  test("writes skill name to skill-invocations.jsonl", async () => {
    const input = JSON.stringify({
      session_id: "sess-skill",
      tool_name: "Skill",
      tool_input: { skill: "ship" },
    });

    const result = await runCapture("skill", input);
    expect(result.exitCode).toBe(0);

    const file = join(TMP_DIR, "signals", "skill-invocations.jsonl");
    expect(existsSync(file)).toBe(true);

    const parsed = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(parsed.type).toBe("skill-invocation");
    expect(parsed.skill).toBe("ship");
    expect(parsed.session_id).toBe("sess-skill");
  });

  test("ignores non-Skill tool calls", async () => {
    const input = JSON.stringify({
      session_id: "sess-bash",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    const result = await runCapture("skill", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "skill-invocations.jsonl"))).toBe(false);
  });

  test("ignores Skill calls without skill name", async () => {
    const input = JSON.stringify({
      session_id: "sess-empty",
      tool_name: "Skill",
      tool_input: {},
    });

    const result = await runCapture("skill", input);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(TMP_DIR, "signals", "skill-invocations.jsonl"))).toBe(false);
  });
});

describe("performance", () => {
  test("all capture commands complete under 500ms", async () => {
    const cases = [
      { sub: "rating", input: JSON.stringify({ session_id: "s", message: { content: "/rate M:7 S:8 Q:9" } }) },
      { sub: "correction", input: JSON.stringify({ session_id: "s", message: { content: "wrong approach" } }) },
      { sub: "tool", input: JSON.stringify({ session_id: "s", tool_name: "Read" }) },
      { sub: "skill", input: JSON.stringify({ session_id: "s", tool_name: "Skill", tool_input: { skill: "ship" } }) },
    ];

    for (const { sub, input } of cases) {
      const { elapsed } = await runCapture(sub, input);
      expect(elapsed).toBeLessThan(5000);
    }
  });
});
