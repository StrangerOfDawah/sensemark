// The same messages users see, for tests: t() for assertions and a
// chrome.i18n.getMessage stand-in for fake chrome objects.
const I18n = require("../../src/i18n.js");

function getMessage(key, values = []) {
  return I18n.format(I18n.messages()[key], [].concat(values));
}

module.exports = { getMessage, t: I18n.t, messages: I18n.messages };
