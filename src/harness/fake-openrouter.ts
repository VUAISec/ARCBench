/**
 * An offline stand-in for OpenRouter's /chat/completions, installed on `globalThis.fetch`.
 *
 * Used by `arcbench smoke` (every stage runs, nothing is billed) and by the golden captures and replay
 * tests, which run episodes against it and compare what each SENT. Every reply is a pure function
 * of the request body, so identical requests get identical replies and two runs of one episode walk
 * the same trajectory.
 *
 * It covers the three call shapes the harness makes:
 *   - the agent's decision turns and the c2/c4 placement call (tools offered, JSON reply);
 *   - harness-backend compactor and ranker calls (no tools, JSON reply);
 *   - pi's own compaction call (OpenAI SDK, `stream: true`, server-sent events).
 *
 * Decision replies rotate, by request hash, through: no tool call; a call to the first offered
 * tool; a call to the last offered tool -- so the grader sees violation, safe and no-action paths.
 */
import { createHash } from "node:crypto";

export interface CapturedRequest {
  url: string;
  /** The body exactly as sent. */
  body: string;
  sha256: string;
}

interface ToolDef {
  type?: string;
  function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
}

interface ChatBody {
  model?: string;
  stream?: boolean;
  tools?: ToolDef[];
  messages?: Array<{ role?: string; content?: unknown }>;
}

const CHANNEL_TOOLS = new Set(["persist_document", "get_policy", "read_operating_document"]);

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toolArgs(tool: ToolDef, h: string): Record<string, unknown> {
  const props = Object.keys(tool.function?.parameters?.properties ?? {});
  const args: Record<string, unknown> = {};
  for (const p of props) args[p] = `fake-${p}-${h.slice(0, 6)}`;
  return args;
}

/** The deterministic reply to one request. */
export function fakeReply(bodyText: string): { content: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> } {
  const h = sha(bodyText);
  let body: ChatBody = {};
  try {
    body = JSON.parse(bodyText) as ChatBody;
  } catch {
    return { content: `fake reply ${h.slice(0, 8)}`, toolCalls: [] };
  }
  const tools = (body.tools ?? []).filter((t) => t.function?.name);

  // The c2/c4 placement call offers exactly one channel tool: make the call so the channel is satisfied.
  if (tools.length === 1 && CHANNEL_TOOLS.has(tools[0]!.function!.name!)) {
    const name = tools[0]!.function!.name!;
    const args = name === "persist_document" ? { path: "rule.md", content: "Recorded operating rule (fake)." } : { scope: "session" };
    return { content: "", toolCalls: [{ id: `call_${h.slice(0, 12)}`, name, args }] };
  }

  if (tools.length > 0) {
    const pick = parseInt(h.slice(0, 8), 16) % 3;
    if (pick === 0) return { content: `I will hold off on that for now (fake ${h.slice(0, 6)}).`, toolCalls: [] };
    const task = tools.filter((t) => !CHANNEL_TOOLS.has(t.function!.name!));
    const chosen = (pick === 1 ? task[0] : task[task.length - 1]) ?? tools[0]!;
    return {
      content: "",
      toolCalls: [{ id: `call_${h.slice(0, 12)}`, name: chosen.function!.name!, args: toolArgs(chosen, h) }],
    };
  }

  // Compactor, ranker or judge: a short structured summary.
  return {
    content:
      `## Goal\nContinue the user's task (fake ${h.slice(0, 8)}).\n\n` +
      `## Constraints & Preferences\n- Keep following the session's operating rules.\n\n` +
      `## Progress\n- Earlier turns summarized offline.`,
    toolCalls: [],
  };
}

function jsonCompletion(bodyText: string, model: string): Response {
  const { content, toolCalls } = fakeReply(bodyText);
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.length > 0) {
    message["tool_calls"] = toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  const payload = {
    id: `fake-${sha(bodyText).slice(0, 16)}`,
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: Math.ceil(bodyText.length / 4), completion_tokens: Math.ceil(content.length / 4) + 1, total_tokens: 0 },
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function streamCompletion(bodyText: string, model: string): Response {
  const { content } = fakeReply(bodyText);
  const id = `fake-${sha(bodyText).slice(0, 16)}`;
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const frames = [
    chunk({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }),
    chunk({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: Math.ceil(bodyText.length / 4), completion_tokens: Math.ceil(content.length / 4) + 1, total_tokens: 0 } }),
    "data: [DONE]\n\n",
  ];
  return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

export interface FakeOpenRouter {
  requests: CapturedRequest[];
  restore(): void;
}

/** Install the fake on `globalThis.fetch`. Call `restore()` to put the real fetch back. */
export function installFakeOpenRouter(): FakeOpenRouter {
  const realFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let bodyText = "";
    if (init?.body !== undefined && init.body !== null) {
      bodyText = typeof init.body === "string" ? init.body : await new Response(init.body as BodyInit).text();
    } else if (input instanceof Request) {
      bodyText = await input.clone().text();
    }
    if (!/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      return new Response(JSON.stringify({ error: { message: `fake OpenRouter: no route for ${url}` } }), { status: 404 });
    }
    requests.push({ url, body: bodyText, sha256: sha(bodyText) });
    let parsed: ChatBody = {};
    try {
      parsed = JSON.parse(bodyText) as ChatBody;
    } catch {
      /* answered as text below */
    }
    const model = parsed.model ?? "fake";
    return parsed.stream ? streamCompletion(bodyText, model) : jsonCompletion(bodyText, model);
  };
  globalThis.fetch = fake as typeof globalThis.fetch;
  return {
    requests,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
