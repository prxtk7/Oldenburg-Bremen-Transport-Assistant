# Oldenburg Bremen Transport Assistant

A multilingual chat assistant that helps newcomers plan public transport journeys in Oldenburg and Bremen, Germany. Users describe a trip in everyday language; the assistant extracts the origin, destination and time, plans the journey with the VBN OpenTripPlanner API and replies with short, step-by-step travel instructions.

Three-member group project, M.Sc. Engineering of Socio-Technical Systems, University of Oldenburg. Academic prototype — not deployed or tested in production.

> **Role of AI:** journey extraction, route processing and replies are rule-based and deterministic. A large language model (Ollama or OpenAI) is only called as a fallback when the rule-based parser cannot identify the journey details. Route planning itself is done by the VBN OpenTripPlanner service, not by the LLM.

## Project overview

Newcomers to a city — international students, exchange students, new residents and tourists — often do not know local stop names, the ticket system or German-language journey planners. This prototype explores whether a conversational interface can lower that barrier: users can write "I just arrived at Oldenburg station and want to go to my student dorm" instead of filling in a form.

The project combined software development with HCI work: usability-testing scenarios, evaluation of the conversational prototype and iterative refinement based on user feedback.

## Key features

- **Natural-language trip requests** — origin, destination, time and "arrive by" / "depart at" intent are extracted by a rule-based parser that recognises sentence patterns in all six UI languages. Missing details trigger one short follow-up question.
- **Route planning for Oldenburg and Bremen** via the VBN OpenTripPlanner (OTP) API: step-by-step walk/ride/transfer instructions, up to two alternatives, and delay or cancellation notes when OTP provides them. Very short trips are recommended as a walk unless the user asks for transit.
- **Place resolution** — built-in aliases for common places, VBN stop search, and OpenStreetMap Nominatim geocoding for streets and landmarks, limited to the Oldenburg and Bremen areas. Ambiguous places produce a short list of choices.
- **Current location** — optional browser geolocation to start a trip from the nearest suitable stop.
- **Next departures** from a named stop (e.g. "next bus from Postenweg").
- **Six UI languages** — English, German, Arabic (right-to-left layout), Turkish, Ukrainian and Hindi.
- **Voice input** through the browser's Web Speech API, where supported.
- **Ticket guidance** — rule-based questions (how often, how many people) leading to a suggested ticket type and a link to official VBN ticket information. No prices are calculated.
- **Mock payment flow** for HCI evaluation. **No real payment is processed** and no payment data leaves the browser.
- **Accessibility information** — wheelchair-boarding data is shown where OTP provides it; a "less walking" preference reduces the maximum walking distance.
- **Walking directions** — walking legs link to Google Maps walking directions.
- **Installable web app** (PWA manifest and service worker).

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | Single `index.html` with inline HTML, CSS and JavaScript (no framework, no build step) |
| Backend | Node.js built-in `http` module, single file `server.js` |
| Runtime dependencies | None (`package.json` declares no dependencies) |
| Route planning | VBN OpenTripPlanner REST API (API key required) |
| Geocoding | OpenStreetMap Nominatim (public instance by default) |
| LLM fallback | Ollama (local, e.g. `llama3.1:8b`) or OpenAI Responses API |
| Tests | Node.js built-in test runner (`node:test`) |

## Architecture overview

```
Browser (index.html)  ──POST /api/chat──▶  Node server (server.js)
                                             ├─ rule-based parser (origin / destination / time)
                                             ├─ LLM fallback (Ollama or OpenAI), only if parsing fails
                                             ├─ place resolution: built-in aliases, VBN stops, Nominatim
                                             ├─ VBN OTP /plan → ranked itineraries → templated reply
                                             └─ in-memory session per browser
```

The browser talks only to the local server; API keys never reach the frontend. Details, endpoints and the full request flow are in [docs/architecture.md](docs/architecture.md).

## Getting started

### Prerequisites

- **Node.js 18 or later** (the code relies on built-in `fetch` and `node:test`). Verified on Node.js 24.22.1; older versions have not been tested.
- **A VBN OTP API key** for route planning. VBN issues free keys on request — see the [VBN Open Data and Open Service page](https://www.vbn.de/service/entwicklerinfos/open-data-und-open-service).
- *Optional:* [Ollama](https://ollama.com) with a local model, or an OpenAI API key, for the LLM fallback.

### Installation and startup

```bash
git clone https://github.com/<your-username>/oldenburg-bremen-transport-assistant.git
cd oldenburg-bremen-transport-assistant
npm ci                      # no packages are installed; verifies the lockfile
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# edit .env: set VBN_OTP_API_KEY, and configure or blank out the LLM settings
npm start                   # or: npm run dev (same command: node server.js)
```

Open <http://localhost:3000>. The server does not hot-reload; restart it after changing `server.js` or `.env`.

Optional local LLM:

```bash
ollama pull llama3.1:8b     # Ollama must be running while the app is used
```

Run the tests (146 tests, no network access or API keys needed):

```bash
npm test
```

### Testing on a phone

Set `HOST=0.0.0.0` to make the server reachable on your local network. Browsers only allow geolocation and service workers on HTTPS or `localhost`, so those features will not work over a plain `http://<LAN-IP>:3000` address.

## Configuration

The server reads `.env` on startup; variables already set in the shell take precedence. All variables are listed in [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `VBN_OTP_API_KEY` | — | **Required for route planning.** Without it, only short walking suggestions work. |
| `VBN_OTP_API_BASE` | `https://gtfsr.vbn.de/api` | VBN OTP server |
| `VBN_OTP_ROUTER_ID` | `connect` | OTP router |
| `VBN_OTP_AUTH_SCHEME` | *(empty)* | Empty sends the raw key in `Authorization`; set `Bearer` if required |
| `VBN_OTP_TIMEOUT_MS` | `5000` | Request timeout (capped at 5000) |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | *(see `.env.example`)* | If both are set, Ollama is used for the LLM fallback |
| `OLLAMA_TIMEOUT_MS` | `60000` | Ollama timeout |
| `OPENAI_API_KEY` | — | Used only when the Ollama variables are empty; must start with `sk-` |
| `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS` | `gpt-4.1-mini`, `20000` | OpenAI model and timeout |
| `GEOCODER_BASE_URL` | public Nominatim | Nominatim-compatible search endpoint (an empty value falls back to the default) |
| `GEOCODER_USER_AGENT` | `oldenburg-transport-chatbot/1.0` | Identify your deployment (Nominatim policy); adding your own contact is recommended |
| `GEOCODER_MIN_INTERVAL_MS` | `1100` | Gap between geocoder requests; never below 1000 ms for public Nominatim |
| `GEOCODER_TIMEOUT_MS` | `2500` | Request timeout (capped at 2500) |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Bind address and port |
| `API_RATE_LIMIT_PER_MINUTE` | `60` | Per-client limit for `POST /api/*` (0 disables) |
| `MAX_SESSIONS` | `1000` | In-memory session limit (least recently used evicted) |
| `DEBUG_MODE` | `false` | When `true`, logs chat text and coordinates — never enable on shared systems |

**Which integrations need credentials:** VBN OTP needs an API key. OpenAI needs an API key. Ollama and Nominatim need none, but public Nominatim has a strict usage policy (see [limitations](docs/limitations.md)).

**LLM fallback behaviour:** if `OLLAMA_BASE_URL` and `OLLAMA_MODEL` are set, Ollama is always used — there is no automatic switch to OpenAI if Ollama is unavailable. `.env.example` enables Ollama by default; blank both variables to use OpenAI, or leave all three empty to run without an LLM. Without an LLM, trip requests the parser understands still work; messages that would need the LLM receive an "AI backend is not configured" reply.


## Limitations and known constraints

- Academic prototype: not deployed, not load-tested, no user accounts or persistent storage.
- Route planning depends on a VBN API key and the availability of the VBN OTP service.
- The rule-based parser recognises specific phrasings; unusual sentences need the LLM fallback or a follow-up question.
- Coverage is limited to the Oldenburg and Bremen areas.
- Wheelchair information is displayed, but routing is not wheelchair-aware.
- Voice input does not work in Firefox; geolocation requires HTTPS or `localhost`.
- The chat does not work offline, and the mock payment page is English-only.
- Sessions are kept in server memory, expire after 6 hours of inactivity and are lost on restart.

Full list: [docs/limitations.md](docs/limitations.md). Test coverage and its gaps: [docs/testing.md](docs/testing.md).

