import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts/check_commit_identity.sh");

// Split so this tracked file does not itself contain a Gmail address.
const GMAIL = "planted" + "@" + "gmail.com";
const PUBLIC_EMAIL = "anonb3ll@pm.me";

// Every git process here ignores the developer's global and system config, so
// ambient signing, fsmonitor, hooksPath or templateDir settings cannot slow a
// commit down or change what it does. Only the fixture repo's own config applies.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      ...env,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function check(dir: string, range: string) {
  return spawnSync("bash", [SCRIPT, "--repo", dir, "--range", range], {
    encoding: "utf8",
    env: GIT_ENV,
  });
}

function head(dir: string) {
  return git(dir, ["rev-parse", "HEAD"]);
}

describe("commit identity check", () => {
  let dir = "";
  let base = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "commit-id-"));
    git(dir, ["init", "-b", "main"]);
    appendFileSync(
      join(dir, ".git", "config"),
      `[core]\n\tfsmonitor = false\n[commit]\n\tgpgsign = false\n[user]\n\tname = anonb3ll\n\temail = ${PUBLIC_EMAIL}\n`,
    );
    git(dir, ["commit", "--allow-empty", "-m", "base"]);
    base = head(dir);
  });

  beforeEach(() => {
    git(dir, ["reset", "--hard", base]);
    rmSync(join(dir, "identities"), { force: true });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a planted Gmail commit fails and the address is not printed", () => {
    git(dir, ["commit", "--allow-empty", "-m", "planted"], {
      GIT_AUTHOR_NAME: "anonb3ll",
      GIT_AUTHOR_EMAIL: GMAIL,
      GIT_COMMITTER_NAME: "anonb3ll",
      GIT_COMMITTER_EMAIL: PUBLIC_EMAIL,
    });
    const sha = head(dir);
    const result = check(dir, `${base}..HEAD`);
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(`${sha} author-email`);
    expect(output).not.toContain(GMAIL);
    expect(output).not.toContain("@");
  });

  test("an anonb3ll@pm.me commit passes", () => {
    git(dir, ["commit", "--allow-empty", "-m", "public identity"]);
    const result = check(dir, `${base}..HEAD`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("a noreply address that embeds the handle passes", () => {
    const noreply = "7+" + "ant" + "mbel" + "@users.noreply.github.com";
    git(dir, ["commit", "--allow-empty", "-m", "private noreply"], {
      GIT_AUTHOR_NAME: "anonb3ll",
      GIT_AUTHOR_EMAIL: noreply,
      GIT_COMMITTER_NAME: "anonb3ll",
      GIT_COMMITTER_EMAIL: PUBLIC_EMAIL,
    });
    expect(check(dir, `${base}..HEAD`).status).toBe(0);
  });

  test("GitHub noreply and web-flow committers pass", () => {
    git(dir, ["commit", "--allow-empty", "-m", "web flow"], {
      GIT_AUTHOR_NAME: "anonb3ll",
      GIT_AUTHOR_EMAIL: PUBLIC_EMAIL,
      GIT_COMMITTER_NAME: "web-flow",
      GIT_COMMITTER_EMAIL: "noreply@github.com",
    });
    expect(check(dir, `${base}..HEAD`).status).toBe(0);
  });

  test("a Co-authored-by Gmail trailer fails without printing the address", () => {
    git(
      dir,
      ["commit", "--allow-empty", "-m", "subject", "-m", `Co-authored-by: Helper <${GMAIL}>`],
      {
        GIT_AUTHOR_NAME: "anonb3ll",
        GIT_AUTHOR_EMAIL: PUBLIC_EMAIL,
        GIT_COMMITTER_NAME: "anonb3ll",
        GIT_COMMITTER_EMAIL: PUBLIC_EMAIL,
      },
    );
    const sha = head(dir);
    const result = check(dir, `${base}..HEAD`);
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(`${sha} co-authored-by`);
    expect(output).not.toContain(GMAIL);
    expect(output).not.toContain("@");
  });

  test("the Cloud Build identity file uses the same rules", () => {
    git(dir, ["commit", "--allow-empty", "-m", "planted"], {
      GIT_AUTHOR_NAME: "anonb3ll",
      GIT_AUTHOR_EMAIL: GMAIL,
      GIT_COMMITTER_NAME: "anonb3ll",
      GIT_COMMITTER_EMAIL: PUBLIC_EMAIL,
    });
    const raw = spawnSync(
      "git",
      ["-C", dir, "log", "-z", "--format=%H%n%an%n%ae%n%cn%n%ce%n%b", `${base}..HEAD`],
      { env: GIT_ENV },
    );
    expect(raw.status).toBe(0);
    const path = join(dir, "identities");
    writeFileSync(path, raw.stdout);
    const result = spawnSync("bash", [SCRIPT, "--file", path], { encoding: "utf8", env: GIT_ENV });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(GMAIL);
  });
});
