(function exposeSseParser(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSseParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function createSseParser({ onEvent, maxBufferBytes = 1024 * 1024 } = {}) {
    if (typeof onEvent !== "function") throw new TypeError("onEvent is required.");
    let buffer = "";

    function parseBlock(block) {
      let event = "message";
      let id = "";
      const data = [];
      for (const line of block.split(/\r\n|\n|\r/)) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value || "message";
        else if (field === "id" && !value.includes("\0")) id = value;
      }
      if (data.length) onEvent({ event, id, data: data.join("\n") });
    }

    function nextBoundary() {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      return match ? { index: match.index, length: match[0].length } : null;
    }

    function feed(chunk) {
      buffer += String(chunk || "");
      if (new TextEncoder().encode(buffer).byteLength > maxBufferBytes) {
        buffer = "";
        throw new RangeError("SSE buffer limit exceeded.");
      }
      let boundary = nextBoundary();
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        parseBlock(block);
        boundary = nextBoundary();
      }
    }

    function finish() {
      if (!buffer) return;
      const trailing = buffer;
      buffer = "";
      parseBlock(trailing);
    }

    function reset() {
      buffer = "";
    }

    return { feed, finish, reset };
  }

  return { createSseParser };
});
