# Testing

## Running the tests

```bash
npm test
```

This runs `node --test route-parser.test.js` with the built-in Node.js test runner (Node.js 18 or later). No packages need to be installed, and no API keys or network access are required. The current suite has **146 tests** and completes in about one second.

## How the tests are isolated

Before `server.js` is loaded, the test file sets its own environment variables (a dummy VBN key, fake service URLs, LLM settings left empty, `DEBUG_MODE=false`). A local `.env` file therefore cannot make the tests call real services.

The global `fetch` is replaced by fakes:

- **VBN OTP** — `/plan` returns three generated itineraries that respect the requested date, time and arrive-by mode; stop and departure endpoints return a small fixed list of public stops.
- **Geocoder** — returns a fixed result for one public test address and nothing otherwise.
- Requests to the local test server pass through unchanged; **any other outgoing request fails the test**.

All addresses and coordinates in the tests are public places (for example the Oldenburgisches Staatstheater at Theaterwall 28).

## What is covered

- **Rule-based parsing** — origin, destination, time, date and arrive-by/depart-at extraction, including multilingual sentences in German, Arabic, Hindi, Ukrainian, Turkish and English, typo correction and street-address detection.
- **Time handling** — Europe/Berlin dates, "tomorrow", past-time detection and arrive-by deadlines.
- **Place resolution** — aliases, known places, exact address matching and nearby-stop lookup against the fake services.
- **Itinerary processing** — normalisation of OTP legs, first/last walking legs, Google Maps walking links and the walk-first recommendation.
- **Ticket guidance** — parsing of ticket details and the resulting recommendation.
- **Chat flows** — multi-turn conversations through the real `handleChatRequest` handler (37 tests named "end-to-end", plus others using the same handler): pending origin/destination questions, place choices, current location, time changes and ticket follow-ups.
- **Frontend source checks** — some tests read `index.html` and assert that required translation keys and handler code are present. They inspect the source text; they do not run the page.
- **Security and operations** — random session IDs, session eviction, the API rate limit (HTTP 429), hidden internal errors, geocoder caching, static-file routing (`GET /`, whitelist and path-traversal attempts) and the OpenStreetMap attribution.

## What is not covered

- **Real external services** — the VBN API contract, real Nominatim results and response times are not tested; a change in VBN's response format would not be detected.
- **LLM fallback** — no test calls Ollama or OpenAI or checks the quality of their output.
- **Browser behaviour** — the UI is not run in a browser: rendering, buttons, geolocation, voice input, right-to-left layout, the service worker, the mock payment pages and responsive layout are untested.
- **Accessibility** — no automated accessibility (WCAG) checks or screen-reader tests.
- **Usability** — the automated tests say nothing about usability; the user study was a separate, manual activity.
- **Load and security testing** — no performance, load or penetration tests.

## Notes

- Tests that depend on "today" or "tomorrow" use the real clock with Europe/Berlin time-zone conversion, including the change between winter and summer time.
- The test file forces `DEBUG_MODE=false`, so the output stays short and contains no chat text or coordinates.
