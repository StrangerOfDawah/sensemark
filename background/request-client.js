(function exposeRequestClient(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../shared/errors.js")
      : root.SensemarkErrors;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkRequestClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (errors) => {
  function retryAfterMilliseconds(response) {
    const value = response?.headers?.get?.("retry-after");
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  function linkAbortSignal(source, controller) {
    if (!source) return () => {};
    if (source.aborted) controller.abort(source.reason);
    const listener = () => controller.abort(source.reason);
    source.addEventListener("abort", listener, { once: true });
    return () => source.removeEventListener("abort", listener);
  }

  function createRequestClient({
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable.");

    async function request(url, init = {}, options = {}) {
      const maximumRetries = options.maximumRetries ?? 1;
      const headerTimeoutMs = options.headerTimeoutMs ?? 12000;
      let attempt = 0;

      while (true) {
        const controller = new AbortController();
        const unlink = linkAbortSignal(options.signal, controller);
        const timeout = setTimeout(
          () => controller.abort(new DOMException("Header timeout", "TimeoutError")),
          headerTimeoutMs
        );
        let response;
        try {
          response = await fetchImpl(url, { ...init, signal: controller.signal });
        } catch (error) {
          clearTimeout(timeout);
          unlink();
          if (options.signal?.aborted) {
            throw new errors.SensemarkError(errors.ERROR_CODE.CANCELLED, "Перевод отменён.");
          }
          if (attempt < maximumRetries) {
            attempt += 1;
            await sleep(250 * attempt);
            continue;
          }
          if (error?.name === "TimeoutError" || controller.signal.reason?.name === "TimeoutError") {
            throw new errors.SensemarkError(
              errors.ERROR_CODE.FIRST_BYTE_TIMEOUT,
              "Сервис слишком долго не отвечал.",
              { retryable: true, phase: "headers", cause: error }
            );
          }
          throw new errors.SensemarkError(
            errors.ERROR_CODE.NETWORK_ERROR,
            "Не удалось подключиться к сервису перевода.",
            { retryable: true, phase: "transport", cause: error }
          );
        }
        clearTimeout(timeout);
        if (response.ok || attempt >= maximumRetries || !isRetryableStatus(response.status)) {
          return { response, attempts: attempt + 1, cleanup: unlink };
        }

        const retryAfterMs = retryAfterMilliseconds(response);
        if (response.status === 429) {
          let detail = "";
          try {
            detail = await response.clone().text();
          } catch {}
          if (/(quota|billing|insufficient_quota)/i.test(detail)) {
            return { response, attempts: attempt + 1, cleanup: unlink };
          }
        }
        if (response.status === 429 && (!retryAfterMs || retryAfterMs > 5000)) {
          return { response, attempts: attempt + 1, cleanup: unlink };
        }
        unlink();
        try {
          await response.body?.cancel?.();
        } catch {}
        attempt += 1;
        await sleep(retryAfterMs || 250 * attempt);
      }
    }

    return { request };
  }

  return { createRequestClient, isRetryableStatus, retryAfterMilliseconds };
});
