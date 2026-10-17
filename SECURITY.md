# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/StrangerOfDawah/sensemark/security/advisories/new),
not in a public issue. You will get an answer within a few days.

Useful details: the affected version, the browser and its version, and steps to
reproduce. Never include a real API key.

## Scope

Sensemark runs entirely in the browser. It stores the user's OpenAI key and settings
in `chrome.storage.local`, talks only to `https://api.openai.com` (OpenAI mode) and
loads no remote code. What leaves the device and when is described in
[PRIVACY.md](PRIVACY.md).

## Supported versions

Only the latest release receives fixes.
