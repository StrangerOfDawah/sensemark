(function exposeErrors(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkErrors = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const ERROR_CODE = Object.freeze({
    INVALID_API_KEY: "INVALID_API_KEY",
    PERMISSION_DENIED: "PERMISSION_DENIED",
    MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
    RATE_LIMITED: "RATE_LIMITED",
    QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
    NETWORK_ERROR: "NETWORK_ERROR",
    FIRST_BYTE_TIMEOUT: "FIRST_BYTE_TIMEOUT",
    STREAM_TIMEOUT: "STREAM_TIMEOUT",
    OVERALL_TIMEOUT: "OVERALL_TIMEOUT",
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    INVALID_RESPONSE: "INVALID_RESPONSE",
    STREAM_INTERRUPTED: "STREAM_INTERRUPTED",
    OUTPUT_TRUNCATED: "OUTPUT_TRUNCATED",
    CONTENT_FILTERED: "CONTENT_FILTERED",
    CONSENT_REQUIRED: "CONSENT_REQUIRED",
    CONFIGURATION_REQUIRED: "CONFIGURATION_REQUIRED",
    INVALID_REQUEST: "INVALID_REQUEST",
    UNSUPPORTED_SELECTION: "UNSUPPORTED_SELECTION",
    CANCELLED: "CANCELLED",
    UNKNOWN: "UNKNOWN",

    // Compatibility aliases used internally by the v1.4 modules.
    ABORTED: "CANCELLED",
    AUTH: "INVALID_API_KEY",
    CONSENT: "CONSENT_REQUIRED",
    EMPTY: "INVALID_REQUEST",
    NETWORK: "NETWORK_ERROR",
    PROVIDER: "SERVICE_UNAVAILABLE",
    QUOTA: "QUOTA_EXHAUSTED",
    RATE_LIMIT: "RATE_LIMITED",
    RESPONSE_FORMAT: "INVALID_RESPONSE",
    TIMEOUT: "OVERALL_TIMEOUT",
    UNSUPPORTED_PAGE: "UNSUPPORTED_SELECTION"
  });

  const SETTINGS_CODES = new Set([
    ERROR_CODE.INVALID_API_KEY,
    ERROR_CODE.PERMISSION_DENIED,
    ERROR_CODE.MODEL_NOT_FOUND,
    ERROR_CODE.QUOTA_EXHAUSTED,
    ERROR_CODE.CONSENT_REQUIRED,
    ERROR_CODE.CONFIGURATION_REQUIRED
  ]);

  const RETRY_CODES = new Set([
    ERROR_CODE.RATE_LIMITED,
    ERROR_CODE.NETWORK_ERROR,
    ERROR_CODE.FIRST_BYTE_TIMEOUT,
    ERROR_CODE.STREAM_TIMEOUT,
    ERROR_CODE.OVERALL_TIMEOUT,
    ERROR_CODE.SERVICE_UNAVAILABLE,
    ERROR_CODE.STREAM_INTERRUPTED,
    ERROR_CODE.OUTPUT_TRUNCATED
  ]);

  function defaultAction(code, retryable) {
    if (SETTINGS_CODES.has(code)) return "open-settings";
    if (retryable && RETRY_CODES.has(code)) return "retry";
    if (code === ERROR_CODE.UNSUPPORTED_SELECTION) return "close";
    return null;
  }

  class SensemarkError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.name = "SensemarkError";
      this.code = Object.values(ERROR_CODE).includes(code) ? code : ERROR_CODE.UNKNOWN;
      this.providerId = String(options.providerId || options.provider || "");
      this.providerErrorCode = String(options.providerErrorCode || "");
      this.httpStatus = Number(options.httpStatus ?? options.status) || 0;
      this.retryable = Boolean(options.retryable);
      this.retryAfterMs = Number(options.retryAfterMs) || 0;
      this.settingsRelevant =
        typeof options.settingsRelevant === "boolean"
          ? options.settingsRelevant
          : SETTINGS_CODES.has(this.code);
      this.action =
        options.action === undefined
          ? defaultAction(this.code, this.retryable)
          : options.action || null;
      this.phase = String(options.phase || "");
      this.details =
        options.details && typeof options.details === "object" ? { ...options.details } : null;

      // Read-only compatibility fields for older callers.
      this.status = this.httpStatus;
      this.provider = this.providerId;
      if (options.cause) this.cause = options.cause;
    }

    toJSON() {
      return {
        code: this.code,
        message: this.message,
        providerId: this.providerId,
        providerErrorCode: this.providerErrorCode,
        httpStatus: this.httpStatus,
        retryable: this.retryable,
        retryAfterMs: this.retryAfterMs,
        settingsRelevant: this.settingsRelevant,
        action: this.action
      };
    }
  }

  function normalizeUnknownError(error, options = {}) {
    if (error instanceof SensemarkError) return error;
    if (error?.name === "AbortError") {
      return new SensemarkError(ERROR_CODE.CANCELLED, "Перевод отменён.", {
        ...options,
        cause: error
      });
    }
    return new SensemarkError(
      ERROR_CODE.NETWORK_ERROR,
      "Не удалось связаться с сервисом перевода.",
      { ...options, cause: error, retryable: true }
    );
  }

  function userActionForError(error) {
    if (!error) return null;
    if (error.action !== undefined) return error.action;
    return defaultAction(error.code, Boolean(error.retryable));
  }

  return {
    ERROR_CODE,
    SensemarkError,
    normalizeUnknownError,
    userActionForError
  };
});
