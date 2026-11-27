// The AI prompt writer, with a stand-in for the network: what it asks Claude
// for, and how it copes with a refusal, bad prompts and a bad key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPrompts, generatePrompts, PromptError } from "../ai.ts";

interface Call {
  url: string;
  headers: Headers;
  body: any;
}

/** A fetch that answers every request with `reply` and remembers what was asked. */
function stub(reply: () => Response) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return reply();
  };
  return { calls, fetch };
}

/** A Messages API response whose text is `payload` as JSON. */
function message(payload: unknown, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...overrides,
  });
}

const request = { theme: "camping trip", level: 3, count: 3, avoid: ["A tent's worst secret"] };
const options = (fetch: ReturnType<typeof stub>["fetch"]) => ({ fetch, apiKey: "sk-ant-test" });

test("asks Sonnet for structured prompts with the theme, level and avoid list, and returns exactly enough", async () => {
  const { calls, fetch } = stub(() =>
    message({ prompts: ["  The worst thing to find  in your sleeping bag ", "One", "Two", "Three", "Four", "Five"] }),
  );
  const prompts = await generatePrompts(request, options(fetch));
  assert.deepEqual(prompts, ["The worst thing to find in your sleeping bag", "One", "Two"]);

  assert.equal(calls.length, 1);
  const { url, headers, body } = calls[0];
  assert.match(url, /\/v1\/messages/);
  assert.match(`${headers.get("x-api-key")} ${headers.get("authorization")}`, /sk-ant-test/);
  assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.equal(body.model, "claude-sonnet-5-5");
  // A decline is retried on a fallback model by the API itself.
  assert.equal(body.fallbacks, "default");
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.deepEqual(body.output_config.format.schema.required, ["prompts"]);
  assert.match(body.system, /Punchline/);

  // The host's text travels as data in the user turn, never in the system prompt.
  const user = body.messages[0].content;
  assert.equal(body.messages.length, 1);
  assert.match(user, /<theme>\ncamping trip\n<\/theme>/);
  assert.match(user, /Spice level: Spicy\./);
  assert.match(user, /- A tent's worst secret/);
  assert.equal(body.system.includes("camping"), false);
  // A few spares are asked for, so a dud can be dropped.
  assert.match(user, /^Write 6 prompts\./);
});

test("each level has its own rubric, and no theme means a general party", async () => {
  const seen: string[] = [];
  for (const [level, name] of ["Unc", "Clean", "Cheeky", "Spicy", "NSFW"].entries()) {
    const { calls, fetch } = stub(() => message({ prompts: ["a", "b", "c", "d"] }));
    await generatePrompts({ theme: "  ", level, count: 2, avoid: [] }, options(fetch));
    const user: string = calls[0].body.messages[0].content;
    assert.match(user, new RegExp(`Spice level: ${name}\\.`));
    assert.match(user, /No theme: write for a general party crowd\./);
    assert.equal(user.includes("already_played"), false);
    seen.push(user);
  }
  assert.equal(new Set(seen).size, 5);
});

test("a refusal becomes a message the host can act on", async () => {
  const { fetch } = stub(() =>
    message("", { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }),
  );
  await assert.rejects(generatePrompts(request, options(fetch)), (error: Error) => {
    assert.ok(error instanceof PromptError);
    assert.match(error.message, /passed on that one/);
    return true;
  });
});

test("too few prompts is an error rather than a short show", async () => {
  const { fetch } = stub(() => message({ prompts: ["Only one", "only  ONE!", ""] }));
  await assert.rejects(generatePrompts(request, options(fetch)), /only came up with 1 usable prompts for 3 rounds/);
});

test("over-long, repeated and already-played prompts are dropped", async () => {
  const long = "x".repeat(201);
  const { fetch } = stub(() => message({ prompts: [long, "Fits", "A TENT'S worst secret!", "fits.", "Second", 7, "Third"] }));
  assert.deepEqual(await generatePrompts(request, options(fetch)), ["Fits", "Second", "Third"]);

  assert.deepEqual(cleanPrompts({ prompts: ["x".repeat(200)] }), ["x".repeat(200)]);
  assert.deepEqual(cleanPrompts({ prompts: "not a list" }), []);
  assert.deepEqual(cleanPrompts(null), []);
});

test("unreadable output and a cut-off answer are reported plainly", async () => {
  const garbled = stub(() => message("{ not json"));
  await assert.rejects(generatePrompts(request, options(garbled.fetch)), /unreadable/);
  const cut = stub(() => message('{"prompts": ["a"', { stop_reason: "max_tokens" }));
  await assert.rejects(generatePrompts(request, options(cut.fetch)), /ran out of room/);
});

test("a bad key is named as the problem, without retrying", async () => {
  const { calls, fetch } = stub(() =>
    Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }),
  );
  await assert.rejects(generatePrompts(request, options(fetch)), (error: Error) => {
    assert.ok(error instanceof PromptError);
    assert.match(error.message, /API key was refused/);
    return true;
  });
  assert.equal(calls.length, 1);
});
