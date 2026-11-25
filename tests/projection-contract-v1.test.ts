/**
 * S2 / gate G2 — the sending half of the Exocortex -> unified-agent projection
 * contract (unified-agent task #279).
 *
 * Minimisation happens here, at the source, not at the receiver: the projector
 * is the only thing that ever sees a full URL or a clean-text excerpt, and it
 * must not put either on the wire. The receiving validator keeps its own
 * pinned golden record; a wire-format change breaks both suites.
 */

import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  KIND_FIELDS,
  MAX_RECORD_BYTES,
  MAX_FOCUS_ENTITY_CHARS,
  MAX_STATE_DIGEST_CHARS,
  ProjectionError,
  projectFocusAnchor,
  type FocusAnchorSource
} from "../src/lib/projection/contract-v1";

const SOURCE: FocusAnchorSource = {
  activeFocusEntity: "S2 projection contract",
  workingStateSummary: "Drafting the versioned projection schema for gate G2.",
  intentCategory: "Deep Work (Drafting/Coding)",
  cognitiveLoadLevel: "High",
  timestampUtc: 1754524800000,
  url: "https://example.com/issues/279"
};

const OPTS = {
  originMachine: "desktop",
  originSurface: "browser" as const,
  trustTier: "local" as const,
  consentBasis: "standing_local_capture" as const,
  projectedAt: 1754524801000
};

describe("projectFocusAnchor — golden path", () => {
  test("produces the versioned envelope the hub expects", async () => {
    const record = await projectFocusAnchor(SOURCE, OPTS);

    expect(record.contract_version).toBe(CONTRACT_VERSION);
    expect(record.kind).toBe("focus_anchor");
    expect(typeof record.record_id).toBe("string");
    expect(record.payload.focus_entity).toBe("S2 projection contract");
    expect(record.payload.intent_category).toBe("Deep Work (Drafting/Coding)");
    expect(record.payload.cognitive_load_level).toBe("High");
    expect(record.payload.state_digest).toBe("Drafting the versioned projection schema for gate G2.");
  });

  test("carries full provenance including consent basis and trust tier", async () => {
    const record = await projectFocusAnchor(SOURCE, OPTS);
    expect(record.provenance).toEqual({
      origin_machine: "desktop",
      origin_surface: "browser",
      captured_at: 1754524800000,
      projected_at: 1754524801000,
      consent_basis: "standing_local_capture",
      trust_tier: "local"
    });
  });

  test("emits exactly the allowlisted payload fields, nothing more", async () => {
    const record = await projectFocusAnchor(SOURCE, OPTS);
    expect(Object.keys(record.payload).sort()).toEqual([...KIND_FIELDS.focus_anchor].sort());
  });

  test("the allowlist itself is pinned", () => {
    expect([...KIND_FIELDS.focus_anchor].sort()).toEqual([
      "cognitive_load_level",
      "focus_entity",
      "intent_category",
      "origin_ref",
      "state_digest"
    ]);
  });

  test("interop golden — byte-for-byte what the Python validator is pinned to", async () => {
    // The receiver pins an equivalent literal (INTEROP_GOLDEN) in its own
    // projection tests. If the wire format changes, both sides fail.
    const record = await projectFocusAnchor(SOURCE, OPTS);
    expect(record).toEqual({
      contract_version: "1.0",
      kind: "focus_anchor",
      record_id: "fa_me0mrk00_9e5c6cec61d711c5",
      provenance: {
        origin_machine: "desktop",
        origin_surface: "browser",
        captured_at: 1754524800000,
        projected_at: 1754524801000,
        consent_basis: "standing_local_capture",
        trust_tier: "local"
      },
      payload: {
        focus_entity: "S2 projection contract",
        intent_category: "Deep Work (Drafting/Coding)",
        cognitive_load_level: "High",
        state_digest: "Drafting the versioned projection schema for gate G2.",
        origin_ref: "9e5c6cec61d711c5"
      }
    });
  });

  test("local, remote and vault origins stay distinguishable", async () => {
    const tiers = await Promise.all(
      (["local", "remote", "vault"] as const).map(async (trustTier) =>
        (await projectFocusAnchor(SOURCE, { ...OPTS, trustTier })).provenance.trust_tier
      )
    );
    expect(tiers).toEqual(["local", "remote", "vault"]);
  });

  test("origin_ref is a stable opaque digest, not the URL", async () => {
    const a = await projectFocusAnchor(SOURCE, OPTS);
    const b = await projectFocusAnchor(SOURCE, { ...OPTS, projectedAt: 999 });
    const other = await projectFocusAnchor({ ...SOURCE, url: "https://example.com/x" }, OPTS);

    expect(a.payload.origin_ref).toMatch(/^[0-9a-f]{16}$/);
    expect(a.payload.origin_ref).toBe(b.payload.origin_ref);
    expect(a.payload.origin_ref).not.toBe(other.payload.origin_ref);
  });
});

describe("projectFocusAnchor — privacy (baseline 2026-08-07 section 6, MUST NOT)", () => {
  const ADVERSARIAL: FocusAnchorSource & Record<string, unknown> = {
    activeFocusEntity: "Reviewing https://banking.example.com/account?token=secret123",
    workingStateSummary:
      "Comparing quarterly figures — see https://banking.example.com/statement and file:///home/user/secrets.txt",
    intentCategory: "Deep Work (Drafting/Coding)",
    cognitiveLoadLevel: "Overload",
    timestampUtc: 1754524800000,
    url: "https://banking.example.com/account/details?token=secret123",
    // fields an incautious refactor might spread onto the projection
    pageTitle: "Private Account Overview",
    cleanTextExcerpt: "CONFIDENTIAL BALANCE: $1,000,000. Account owner: Anthony.",
    textContent: "the entire page body",
    openTabsContext: [{ url: "https://mail.example.com/inbox", title: "Inbox" }],
    browsingHistory: ["https://a.example.com", "https://b.example.com"],
    vectorAnchor: new Array(384).fill(0.1),
    userActions: ["click_transfer", "input_password"]
  };

  test("no URL, page text, tab context, history or embedding reaches the wire", async () => {
    const record = await projectFocusAnchor(ADVERSARIAL, OPTS);
    const wire = JSON.stringify(record);

    for (const probe of [
      "http://",
      "https://",
      "file://",
      "chrome-extension://",
      "banking.example.com",
      "mail.example.com",
      "secrets.txt",
      "CONFIDENTIAL",
      "Private Account Overview",
      "token=secret123",
      "input_password",
      "the entire page body"
    ]) {
      expect(wire).not.toContain(probe);
    }
  });

  test("internal source keys are dropped, not passed through", async () => {
    const record = await projectFocusAnchor(ADVERSARIAL, OPTS);
    const keys = Object.keys(record.payload);
    for (const leaked of [
      "url",
      "pageTitle",
      "cleanTextExcerpt",
      "textContent",
      "openTabsContext",
      "browsingHistory",
      "vectorAnchor",
      "userActions"
    ]) {
      expect(keys).not.toContain(leaked);
    }
  });

  test("a URL smuggled into free text is redacted, not emitted", async () => {
    const record = await projectFocusAnchor(ADVERSARIAL, OPTS);
    expect(record.payload.state_digest).toContain("[redacted-link]");
    expect(record.payload.focus_entity).toContain("[redacted-link]");
  });

  test("state_digest comes from workingStateSummary only, never from page text", async () => {
    // state_digest is the contract's one intentional free-text channel. It must
    // carry the user's own working-state summary and never be back-filled from
    // cleanTextExcerpt, which is where captured page body text lives.
    const record = await projectFocusAnchor(ADVERSARIAL, OPTS);
    expect(record.payload.state_digest).toContain("Comparing quarterly figures");
    expect(record.payload.state_digest).not.toContain("CONFIDENTIAL");
    expect(record.payload.state_digest).not.toContain("Account owner");
  });

  test("an empty working-state summary projects as empty, not as page text", async () => {
    const record = await projectFocusAnchor(
      { ...ADVERSARIAL, workingStateSummary: null },
      OPTS
    );
    expect(record.payload.state_digest).toBe("");
  });
});

describe("projectFocusAnchor — size limits", () => {
  test("over-long free text is clamped to the documented limits", async () => {
    const record = await projectFocusAnchor(
      { ...SOURCE, activeFocusEntity: "a".repeat(500), workingStateSummary: "b".repeat(900) },
      OPTS
    );
    expect(record.payload.focus_entity.length).toBeLessThanOrEqual(MAX_FOCUS_ENTITY_CHARS);
    expect(record.payload.state_digest.length).toBeLessThanOrEqual(MAX_STATE_DIGEST_CHARS);
  });

  test("the emitted record always fits the wire budget", async () => {
    const record = await projectFocusAnchor(
      { ...SOURCE, activeFocusEntity: "a".repeat(50000), workingStateSummary: "b".repeat(50000) },
      OPTS
    );
    expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeLessThanOrEqual(
      MAX_RECORD_BYTES
    );
  });

  test("an absurd origin machine label is rejected rather than silently trimmed", async () => {
    await expect(
      projectFocusAnchor(SOURCE, { ...OPTS, originMachine: "m".repeat(200) })
    ).rejects.toThrow(ProjectionError);
  });
});

describe("projectFocusAnchor — malformed and untrusted input", () => {
  test.each([[null], [undefined], ["a string"], [42], [[]]])(
    "rejects a non-object source (%p)",
    async (bad) => {
      await expect(projectFocusAnchor(bad as never, OPTS)).rejects.toThrow(ProjectionError);
    }
  );

  test("rejects a source with no focus entity — fails closed", async () => {
    await expect(
      projectFocusAnchor({ ...SOURCE, activeFocusEntity: null }, OPTS)
    ).rejects.toThrow(ProjectionError);
  });

  test("rejects an unknown intent category", async () => {
    await expect(
      projectFocusAnchor({ ...SOURCE, intentCategory: "Doing Crimes" as never }, OPTS)
    ).rejects.toThrow(ProjectionError);
  });

  test("rejects an unknown cognitive load level", async () => {
    await expect(
      projectFocusAnchor({ ...SOURCE, cognitiveLoadLevel: "Nuclear" as never }, OPTS)
    ).rejects.toThrow(ProjectionError);
  });

  test("rejects a non-finite or negative capture timestamp", async () => {
    await expect(projectFocusAnchor({ ...SOURCE, timestampUtc: NaN }, OPTS)).rejects.toThrow(
      ProjectionError
    );
    await expect(projectFocusAnchor({ ...SOURCE, timestampUtc: -1 }, OPTS)).rejects.toThrow(
      ProjectionError
    );
  });

  test.each([["origin_surface"], ["trust_tier"], ["consent_basis"]])(
    "rejects an out-of-vocabulary %s",
    async (field) => {
      const key = { origin_surface: "originSurface", trust_tier: "trustTier", consent_basis: "consentBasis" }[
        field
      ] as keyof typeof OPTS;
      await expect(
        projectFocusAnchor(SOURCE, { ...OPTS, [key]: "definitely-not-valid" } as never)
      ).rejects.toThrow(ProjectionError);
    }
  );

  test("a null focus anchor (no frames captured yet) is refused, not projected as empty", async () => {
    await expect(
      projectFocusAnchor(
        {
          activeFocusEntity: null,
          workingStateSummary: null,
          intentCategory: null,
          cognitiveLoadLevel: null,
          timestampUtc: null,
          url: null
        },
        OPTS
      )
    ).rejects.toThrow(ProjectionError);
  });
});
