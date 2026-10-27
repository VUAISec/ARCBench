import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { judgeOnce, judgeRawOnce, type JudgeClientOptions } from "../src/judge/client.ts";

const OPTS: JudgeClientOptions = {
  apiKey: "test-key",
  baseUrl: "https://example.invalid/api/v1",
  requestTimeoutMs: 1000,
  maxTransientRetries: 2,
  retryBaseDelayMs: 0,
  maxParseRetries: 1,
};

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: "test/judge",
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: 900,
      completion_tokens: 2,
      cost: 0.0001,
      completion_tokens_details: { reasoning_tokens: 0 },
      ...extra,
    },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.restoreAllMocks(); });

const call = () => judgeOnce({ slug: "test/judge", system: "S", user: "U", opts: OPTS });

describe("judgeOnce", () => {
  it("returns the parsed label and the billed usage", async () => {
    globalThis.fetch = vi.fn(async () => reply(completion("present"))) as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBe("present");
    expect(out.failure).toBeNull();
    expect(out.promptTokens).toBe(900);
    expect(out.costUsd).toBeCloseTo(0.0001);
  });

  it("sends temperature 0 and reasoning disabled", async () => {
    const spy = vi.fn(async () => reply(completion("absent")));
    globalThis.fetch = spy as unknown as typeof fetch;
    await call();
    const [, init] = spy.mock.calls[0] as unknown as [string, { body: string }];
    const sent = JSON.parse(init.body) as Record<string, unknown>;
    expect(sent["temperature"]).toBe(0);
    expect(sent["max_tokens"]).toBe(16);
    expect(sent["reasoning"]).toEqual({ enabled: false });
  });

  it("lets the audit path raise the output cap without touching the metric default", async () => {
    // The metric's reply is one word, so 16 is right and it also bounds the damage if a
    // provider ignores reasoning-off. The audit asks for JSON carrying a verbatim span, which
    // does not fit in 16 -- every audit call would have come back truncated and unparseable.
    const spy = vi.fn(async () => reply(completion("absent")));
    globalThis.fetch = spy as unknown as typeof fetch;
    await judgeRawOnce({ slug: "test/judge", system: "S", user: "U", opts: OPTS, maxTokens: 300 });
    const [, init] = spy.mock.calls[0] as unknown as [string, { body: string }];
    expect((JSON.parse(init.body) as Record<string, unknown>)["max_tokens"]).toBe(300);
  });

  it("fails the call when the provider billed reasoning tokens", async () => {
    globalThis.fetch = vi.fn(async () =>
      reply(completion("present", { completion_tokens_details: { reasoning_tokens: 140 } })),
    ) as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBeNull();
    expect(out.failure).toMatch(/reasoning/i);
    expect(out.reasoningTokens).toBe(140);
  });

  it("fails the call when the responding model is not the requested slug", async () => {
    globalThis.fetch = vi.fn(async () =>
      reply({ ...completion("present"), model: "test/some-other-model" }),
    ) as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBeNull();
    expect(out.failure).toMatch(/model mismatch/i);
  });

  it("retries a 429 and succeeds", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(reply({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(reply(completion("partially_stated")));
    globalThis.fetch = spy as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBe("partially_stated");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("re-asks once on an unparseable reply, then gives up without inventing a label", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(reply(completion("I cannot determine this")))
      .mockResolvedValueOnce(reply(completion("still not a label")));
    globalThis.fetch = spy as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBeNull();
    expect(out.failure).toMatch(/unparseable/i);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reports a network failure as a failure and never as a label", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBeNull();
    expect(out.failure).toMatch(/socket hang up/);
  });

  it("returns the text unparsed via judgeRawOnce, with the assertions still applied", async () => {
    globalThis.fetch = vi.fn(async () =>
      reply(completion('{"label":"present","span":"only @nexus-corp.com"}')),
    ) as unknown as typeof fetch;
    const out = await judgeRawOnce({ slug: "test/judge", system: "S", user: "U", opts: OPTS });
    expect(out.content).toBe('{"label":"present","span":"only @nexus-corp.com"}');
    expect(out.failure).toBeNull();
  });

  it("judgeRawOnce still fails on billed reasoning tokens", async () => {
    globalThis.fetch = vi.fn(async () =>
      reply(completion("{}", { completion_tokens_details: { reasoning_tokens: 9 } })),
    ) as unknown as typeof fetch;
    const out = await judgeRawOnce({ slug: "test/judge", system: "S", user: "U", opts: OPTS });
    expect(out.content).toBe("");
    expect(out.failure).toMatch(/reasoning/i);
  });

  it("does not retry a 403", async () => {
    const spy = vi.fn(async () => reply({ error: { message: "provider ToS" } }, 403));
    globalThis.fetch = spy as unknown as typeof fetch;
    const out = await call();
    expect(out.label).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
