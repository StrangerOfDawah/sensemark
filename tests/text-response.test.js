const test = require("node:test");
const assert = require("node:assert/strict");
const { createSseParser } = require("../background/sse-parser.js");

test("SSE parser survives arbitrary chunk boundaries and CRLF", () => {
  const events = [];
  const parser = createSseParser({ onEvent: (event) => events.push(event) });
  parser.feed("event: response\r\ni");
  parser.feed("d: 7\r\ndata: first\r\ndata: second\r\n\r\n");
  assert.deepEqual(events, [{ event: "response", id: "7", data: "first\nsecond" }]);
});

test("SSE parser ignores comments, accepts LF/CR and resets partial input", () => {
  const events = [];
  const parser = createSseParser({ onEvent: (event) => events.push(event) });
  parser.feed(":keepalive\n\ndata: one\n\n");
  parser.feed("data: two\r\r");
  parser.feed("data: discarded");
  parser.reset();
  parser.feed("data: three\n\n");
  assert.deepEqual(events.map((event) => event.data), ["one", "two", "three"]);
});

test("SSE parser enforces a bounded buffer and validates its callback", () => {
  assert.throws(() => createSseParser(), /onEvent/);
  const parser = createSseParser({ onEvent() {}, maxBufferBytes: 4 });
  assert.throws(() => parser.feed("12345"), /buffer limit/);
});
