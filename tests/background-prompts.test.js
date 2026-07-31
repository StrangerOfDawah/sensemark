const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const contracts = require("../shared/contracts.js");
const errors = require("../shared/errors.js");
const openai = require("../background/providers/openai-provider.js");

function request(mode, overrides = {}) {
  return contracts.createTranslationRequest({
    text: "bank",
    context: "We sat on the bank of the river.",
    mode,
    sourceScripts: ["Latin"],
    ...overrides
  });
}

test("plain-text mode requests true streaming without marker protocols", () => {
  const body = openai.requestBody(request(config.TRANSLATION_MODE.TEXT), "gpt-4o-mini");
  assert.equal(body.stream, true);
  assert.equal(body.response_format, undefined);
  assert.equal(body.model, "gpt-4o-mini");
  assert.match(body.messages[0].content, /only the translation as plain text/i);
  assert.doesNotMatch(JSON.stringify(body), /\[\[|repair|hostname|page title/i);
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    text: "bank",
    context: "We sat on the bank of the river.",
    sourceScripts: ["Latin"],
    targetLanguage: "ru"
  });
});

test("contextual and multilingual modes use strict mode-specific JSON schemas", () => {
  for (const mode of [
    config.TRANSLATION_MODE.CONTEXTUAL,
    config.TRANSLATION_MODE.MULTILINGUAL
  ]) {
    const body = openai.requestBody(request(mode), "model");
    assert.equal(body.stream, undefined);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.deepEqual(
      body.response_format.json_schema.schema.required,
      mode === config.TRANSLATION_MODE.CONTEXTUAL
        ? ["kind", "translation", "alternatives", "category", "explanation"]
        : ["kind", "text", "sections"]
    );
  }
  assert.match(openai.systemPrompt(request(config.TRANSLATION_MODE.CONTEXTUAL)), /disambiguate/i);
  assert.match(openai.systemPrompt(request(config.TRANSLATION_MODE.MULTILINGUAL)), /writing systems/i);
});

test("OpenAI stream emits exact deltas and returns a normalized result", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"вет"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  const provider = openai.createOpenAiProvider({
    requestClient: { request: async () => ({ response, attempts: 1 }) }
  });
  const deltas = [];
  const result = await provider.translate(request(config.TRANSLATION_MODE.TEXT), {
    providerSettings: { apiKey: "secret", model: "gpt-4o-mini" },
    onDelta: (delta) => deltas.push(delta)
  });
  assert.deepEqual(deltas, ["При", "вет"]);
  assert.equal(result.text, "Привет");
});

test("a stream failure after the first delta is typed and never retried", async () => {
  let calls = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (!this.sent) {
          this.sent = true;
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"При"}}]}\n\n'
            )
          );
        } else {
          controller.error(new Error("connection reset"));
        }
      }
    }),
    { status: 200 }
  );
  const provider = openai.createOpenAiProvider({
    requestClient: {
      async request() {
        calls += 1;
        return { response };
      }
    }
  });
  const deltas = [];
  await assert.rejects(
    provider.translate(request(config.TRANSLATION_MODE.TEXT), {
      providerSettings: { apiKey: "test-only", model: "model" },
      onDelta: (delta) => deltas.push(delta)
    }),
    (error) => error.code === errors.ERROR_CODE.STREAM_INTERRUPTED
  );
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ["При"]);
});

test("structured response is parsed once and never repaired", async () => {
  const payload = {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            kind: "translation",
            translation: "берег",
            alternatives: ["банк"],
            category: "",
            explanation: "Контекст реки.",
          })
        }
      }
    ]
  };
  let calls = 0;
  const provider = openai.createOpenAiProvider({
    requestClient: {
      async request() {
        calls += 1;
        return { response: new Response(JSON.stringify(payload), { status: 200 }) };
      }
    }
  });
  const result = await provider.translate(request(config.TRANSLATION_MODE.CONTEXTUAL), {
    providerSettings: { apiKey: "secret", model: "model" }
  });
  assert.equal(calls, 1);
  assert.equal(result.text, "берег");
  assert.deepEqual(result.alternatives, ["банк"]);
});

test("format failures and refusals are explicit and do not cause another request", async () => {
  for (const message of [{ content: "not-json" }, { refusal: "no" }]) {
    let calls = 0;
    const provider = openai.createOpenAiProvider({
      requestClient: {
        async request() {
          calls += 1;
          return {
            response: new Response(
              JSON.stringify({ choices: [{ finish_reason: "stop", message }] }),
              { status: 200 }
            )
          };
        }
      }
    });
    await assert.rejects(
      provider.translate(request(config.TRANSLATION_MODE.CONTEXTUAL), {
        providerSettings: { apiKey: "secret", model: "model" }
      }),
      (error) =>
        [
          errors.ERROR_CODE.INVALID_RESPONSE,
          errors.ERROR_CODE.CONTENT_FILTERED
        ].includes(error.code)
    );
    assert.equal(calls, 1);
  }
});

test("structured result mode mismatch is rejected without repair", async () => {
  const provider = openai.createOpenAiProvider({
    requestClient: {
      request: async () => ({
        response: new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    kind: "multilingual",
                    text: "не тот режим",
                    alternatives: [],
                    explanation: "",
                    sections: []
                  })
                }
              }
            ]
          }),
          { status: 200 }
        )
      })
    }
  });
  await assert.rejects(
    provider.translate(request(config.TRANSLATION_MODE.CONTEXTUAL), {
      providerSettings: { apiKey: "secret", model: "model" }
    }),
    (error) => error.code === errors.ERROR_CODE.RESPONSE_FORMAT
  );
});

test("provider enforces an overall timeout across the whole request", async () => {
  const provider = openai.createOpenAiProvider({
    requestClient: {
      request(_url, _init, options) {
        return new Promise((_, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new errors.SensemarkError(errors.ERROR_CODE.ABORTED, "cancel")),
            { once: true }
          );
        });
      }
    }
  });
  await assert.rejects(
    provider.translate(request(config.TRANSLATION_MODE.TEXT), {
      providerSettings: { apiKey: "secret", model: "model" },
      overallTimeoutMs: 5
    }),
    (error) => error.code === errors.ERROR_CODE.TIMEOUT
  );
});

test("provider error normalization distinguishes key, permission, model, quota, rate and server errors", async () => {
  const auth = await openai.errorFromResponse(
    new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })
  );
  assert.equal(auth.code, errors.ERROR_CODE.AUTH);
  assert.equal(auth.providerId, "openai");
  assert.equal(auth.httpStatus, 401);
  const permission = await openai.errorFromResponse(
    new Response(JSON.stringify({ error: { message: "forbidden", code: "permission" } }), {
      status: 403
    })
  );
  assert.equal(permission.code, errors.ERROR_CODE.PERMISSION_DENIED);
  const model = await openai.errorFromResponse(
    new Response(JSON.stringify({ error: { message: "model not found", code: "model_not_found" } }), {
      status: 404
    })
  );
  assert.equal(model.code, errors.ERROR_CODE.MODEL_NOT_FOUND);
  const quota = await openai.errorFromResponse(
    new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 429 })
  );
  assert.equal(quota.code, errors.ERROR_CODE.QUOTA);
  const rate = await openai.errorFromResponse(
    new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
  );
  assert.equal(rate.code, errors.ERROR_CODE.RATE_LIMIT);
  assert.equal(rate.retryAfterMs, 2000);
  const server = await openai.errorFromResponse(new Response("", { status: 503 }));
  assert.equal(server.code, errors.ERROR_CODE.PROVIDER);
  assert.equal(server.retryable, true);
});

test("delta content accepts string and typed arrays", () => {
  assert.equal(openai.deltaText({ choices: [{ delta: { content: "x" } }] }), "x");
  assert.equal(
    openai.deltaText({ choices: [{ delta: { content: [{ text: "a" }, "b"] } }] }),
    "ab"
  );
  assert.equal(openai.deltaText({}), "");
});
