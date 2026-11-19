# Limitations and known constraints

This is an academic prototype. It has not been deployed, load-tested or security-reviewed for production use.

## Route planning and data

- **VBN API key required.** Without `VBN_OTP_API_KEY` the assistant can only suggest walking for very short trips; route planning and departures are unavailable. VBN's terms for its free student/hobby access include a request quota, require that each request is triggered by an end user, and require the origin or destination to be in Lower Saxony or Bremen.
- **HTTPS endpoint.** VBN's documentation lists `http://gtfsr.vbn.de/api/`. The app defaults to `https://gtfsr.vbn.de/api`, which responds identically without a key; it has not yet been re-checked with a valid key.
- **Coverage** is limited to rectangular areas around Oldenburg and Bremen. Places outside them are rejected.
- **Live information** (delays, cancellations) is shown only if the OTP response contains it.
- **Maps:** only walking legs link to Google Maps (walking directions). There is no map view and no map link for the whole public-transport journey.

## Language understanding

- **The rule-based parser covers specific phrasings.** Typical sentence patterns are recognised in all six languages, but unusual wording is not. Example: the German contraction "vom Theaterwall aus" is not recognised, while "von dem Theaterwall aus" is.
- **The LLM fallback is not guaranteed to be correct.** Its output is constrained to a JSON schema but otherwise not verified; quality depends on the model. Route replies themselves never come from the LLM.
- **No automatic switch between LLM providers.** If Ollama is configured but not running, the fallback fails instead of trying OpenAI.
- **Place matching** relies on a built-in list of common places, VBN stop names and OpenStreetMap data; misspelled or informal place names may need a follow-up choice.

## Geocoding (Nominatim)

- The public Nominatim service allows at most one request per second and is not intended for heavy use. The server enforces a minimum gap of one second and caches results for 24 hours, so an unknown place can take several seconds to resolve.
- Public deployments should set `GEOCODER_USER_AGENT` to identify the operator, or use a self-hosted geocoder.
- Results depend on OpenStreetMap data quality.

## Languages

- Six UI languages: English, German, Arabic (right-to-left), Turkish, Ukrainian, Hindi.
- 8 of the 240 server reply strings have no Arabic, Turkish, Ukrainian or Hindi translation and fall back to English.
- The mock payment page (`mock-payment.html`) is English-only.
- LLM replies are instructed to use the selected language, but compliance depends on the model.

## Browser features

- **Geolocation** requires a secure context (HTTPS or `localhost`) and user permission. Over plain HTTP on a local network IP it is unavailable; the assistant then asks for a typed location.
- **Voice input** uses the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`): available in Chromium-based browsers and Safari, not in Firefox. Some browsers send the audio to the vendor's online speech service.
- **Offline use:** the service worker caches the app shell only. Chat and route planning need a network connection. Service workers also require HTTPS or `localhost`.

## Accessibility

- Wheelchair-boarding information is shown where OTP provides it; otherwise users are asked to confirm accessibility with the operator.
- Routing is **not** wheelchair-aware: OTP's wheelchair option is not used. The "less walking" preference lowers the maximum walking distance (900 m → 300 m); the wheelchair and "avoid stairs" preferences only add warnings to the reply.
- The interface has not been audited against WCAG. Known gaps: new chat messages are not announced to screen readers (no live region), and the message input has no label apart from its placeholder.

## Tickets and payment

- Ticket guidance is rule-based and does not calculate prices; users are referred to official VBN ticket information.
- **The payment flow is a mock for usability evaluation. No real payment is processed**, no ticket is issued, and the form data is not sent anywhere.

## Sessions, privacy and operation

- Sessions live in server memory, expire after 6 hours of inactivity, are limited to 1000 (least recently used evicted) and are lost on restart. There are no user accounts.
- The session ID stored in the browser is the only key to a session.
- When the LLM fallback runs with OpenAI, the message, recent chat history and remembered route are sent to OpenAI. Place searches are sent to Nominatim, and coordinates to VBN.
- `DEBUG_MODE=true` writes chat text and coordinates to the server log.
- The server speaks plain HTTP; HTTPS would require a reverse proxy. The rate limit is per client address and in memory; behind a proxy all users would share one limit.
- There is no authentication on the API; a public deployment would expose the configured API keys' quotas (mitigated only by the rate limit).

## Code and project

- Almost all logic is in two large files (`server.js`, about 11,000 lines; `index.html`, about 4,700 lines), which makes changes harder to review.
- Some internal identifiers keep the original prototype naming: the service-worker cache key (`oldenburg-transport-ai-v14`) and the default geocoder User-Agent (`oldenburg-transport-chatbot/1.0`). They are not shown to users.
- `package.json` does not declare a minimum Node.js version (Node.js 18 or later is required).
- Usability-study materials and results are not part of this repository.
