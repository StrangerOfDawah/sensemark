const errors = require("../../shared/errors.js");

function result(value) {
  return {
    kind: value.kind || "translation",
    translation: value.translation || "",
    text: value.translation || "",
    alternatives: value.alternatives || [],
    category: value.category || "",
    explanation: value.explanation || "",
    sections: value.sections || []
  };
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const rejectCancelled = () =>
      reject(
        new errors.SensemarkError(errors.ERROR_CODE.CANCELLED, "Mock cancelled.")
      );
    if (signal?.aborted) rejectCancelled();
    else signal?.addEventListener("abort", rejectCancelled, { once: true });
  });
}

function createMockProvider({ scenario = "plain-text", delay = async () => {} } = {}) {
  const counters = { translate: 0, validate: 0 };
  return {
    id: "mock",
    displayName: "Deterministic mock",
    capabilities: {
      streamingText: true,
      structuredOutput: true,
      structuredStreaming: false
    },
    settingsDescriptor: {
      apiKey: { type: "secret", required: true }
    },
    counters,
    normalizeError: errors.normalizeUnknownError,
    async validateConfiguration() {
      counters.validate += 1;
      return { ok: true };
    },
    async translate(_request, options = {}) {
      counters.translate += 1;
      if (scenario === "cancellation") return waitForAbort(options.signal);
      if (scenario === "rate-limit") {
        throw new errors.SensemarkError(
          errors.ERROR_CODE.RATE_LIMITED,
          "Mock rate limit.",
          { retryable: true, retryAfterMs: 500 }
        );
      }
      if (scenario === "quota") {
        throw new errors.SensemarkError(
          errors.ERROR_CODE.QUOTA_EXHAUSTED,
          "Mock quota."
        );
      }
      if (scenario === "malformed-stream") {
        throw new errors.SensemarkError(
          errors.ERROR_CODE.INVALID_RESPONSE,
          "Mock malformed stream."
        );
      }
      if (scenario === "truncated-output") {
        throw new errors.SensemarkError(
          errors.ERROR_CODE.OUTPUT_TRUNCATED,
          "Mock truncated output.",
          { retryable: true }
        );
      }
      if (scenario === "structured-contextual") {
        return result({
          kind: "reference",
          translation: "Sensemark",
          category: "brand",
          explanation: "Mock reference."
        });
      }
      if (scenario === "multilingual") {
        return result({
          kind: "multilingual",
          translation: "Привет — мир",
          sections: [
            { script: "Latin", source: "Hello", translation: "Привет" },
            { script: "Arabic", source: "العالم", translation: "мир" }
          ]
        });
      }
      for (const delta of ["При", "вет"]) {
        if (options.signal?.aborted) return waitForAbort(options.signal);
        if (scenario === "delayed-stream") await delay();
        options.onDelta?.(delta);
      }
      return result({ translation: "Привет" });
    }
  };
}

module.exports = { createMockProvider };
