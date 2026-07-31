(function exposeTranslationCache(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("../shared/config.js"),
          contracts: require("../shared/contracts.js")
        }
      : {
          config: root.SensemarkConfig,
          contracts: root.SensemarkContracts
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkTranslationCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this, ({ config }) => {
  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function createCacheKey(request, providerId, model, options = {}) {
    return JSON.stringify({
      providerId,
      model,
      promptVersion: config.PROMPT_VERSION,
      responseProtocolVersion: config.RESPONSE_PROTOCOL_VERSION,
      translationMode: request.mode,
      source: {
        text: request.text,
        scripts: request.sourceScripts,
        language: String(options.sourceLanguage || "")
      },
      context: request.context,
      targetLanguage: request.targetLanguage,
      semantic: {
        hint: request.semanticHint || "",
        responseKind:
          request.mode === config.TRANSLATION_MODE.CONTEXTUAL
            ? "translation-or-reference"
            : request.mode,
        alternativesLimit: 4
      }
    });
  }

  function createTranslationCache(storageArea, options = {}) {
    const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    const maximumEntries = options.maximumEntries ?? 200;
    const maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024;
    const now = options.now || Date.now;
    const recentAccess = new Map();
    let lock = Promise.resolve();

    function serialize(task) {
      const result = lock.then(task, task);
      lock = result.catch(() => {});
      return result;
    }

    async function readState() {
      const stored = await storageArea.get(config.CACHE_KEY);
      const state = stored?.[config.CACHE_KEY];
      return state?.version === 1 && Array.isArray(state.entries)
        ? state
        : { version: 1, entries: [] };
    }

    async function writeState(state) {
      await storageArea.set({ [config.CACHE_KEY]: state });
    }

    function compact(entries) {
      const fresh = entries
        .filter((entry) => now() - entry.createdAt <= ttlMs)
        .map((entry) => ({
          ...entry,
          lastAccessedAt: Math.max(
            Number(entry.lastAccessedAt) || 0,
            recentAccess.get(entry.key) || 0
          )
        }))
        .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
        .slice(0, maximumEntries);
      const output = [];
      let bytes = 0;
      for (const entry of fresh) {
        const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
        if (bytes + entryBytes > maximumBytes) continue;
        output.push(entry);
        bytes += entryBytes;
      }
      return output;
    }

    async function get(rawKey) {
      const key = await sha256(rawKey);
      return serialize(async () => {
        const state = await readState();
        const entries = compact(state.entries);
        const found = entries.find((entry) => entry.key === key);
        if (found) recentAccess.set(key, now());
        if (entries.length !== state.entries.length) {
          await writeState({ version: 1, entries });
        }
        return found?.result || null;
      });
    }

    async function set(rawKey, result) {
      const key = await sha256(rawKey);
      return serialize(async () => {
        const state = await readState();
        const entries = state.entries.filter((entry) => entry.key !== key);
        entries.push({
          key,
          result,
          createdAt: now(),
          lastAccessedAt: now()
        });
        await writeState({ version: 1, entries: compact(entries) });
        recentAccess.delete(key);
        return result;
      });
    }

    async function clear() {
      await storageArea.remove(config.CACHE_KEY);
    }

    return { clear, get, set };
  }

  return { createCacheKey, createTranslationCache, sha256 };
});
