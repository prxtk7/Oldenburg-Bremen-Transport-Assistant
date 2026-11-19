const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");

// --- Hermetic test environment -------------------------------------------
// These values are set before server.js is loaded. loadEnvFile() never
// overrides variables that already exist, so a developer's local .env (with
// real keys) cannot make the tests call live services. All outbound HTTP to
// the VBN OTP API and the geocoder is answered by the fakes below; any other
// non-local request fails the test.
const TEST_OTP_BASE = "https://otp.test/api";
const TEST_GEOCODER_URL = "https://geocoder.test/search";
Object.assign(process.env, {
  VBN_OTP_API_KEY: "test-vbn-key",
  VBN_OTP_API_BASE: TEST_OTP_BASE,
  VBN_OTP_ROUTER_ID: "connect",
  VBN_OTP_AUTH_SCHEME: "",
  GEOCODER_BASE_URL: TEST_GEOCODER_URL,
  GEOCODER_MIN_INTERVAL_MS: "0",
  OLLAMA_BASE_URL: "",
  OLLAMA_MODEL: "",
  OPENAI_API_KEY: "",
  DEBUG_MODE: "false"
});

// Public stops, mirroring the server's built-in stop list.
const FAKE_STOPS = [
  { id: "1:000009090219", name: "Oldenburg(Oldb) Postenweg", lat: 53.140881, lon: 8.171573 },
  { id: "1:000009000881", name: "Oldenburg(Oldb) Pferdemarkt", lat: 53.146771, lon: 8.214682 },
  { id: "1:000009000995", name: "Oldenburg(Oldb) Lappan", lat: 53.14332, lon: 8.214339 },
  { id: "test:julius-mosen-platz", name: "Oldenburg(Oldb) Julius-Mosen-Platz", lat: 53.1381, lon: 8.2104 },
  { id: "test:oldenburg-hbf", name: "Oldenburg Hauptbahnhof", lat: 53.14345, lon: 8.2221 },
  { id: "test:oldenburg-zob", name: "Oldenburg ZOB", lat: 53.1431, lon: 8.2247 },
  { id: "test:bremen-hbf", name: "Bremen Hauptbahnhof", lat: 53.0831, lon: 8.8137 }
];

// Public building used by the numbered-address tests
// (Landesmuseum Natur und Mensch, Damm 38-44, Oldenburg).
const FAKE_GEOCODER_PLACES = [
  {
    match: /damm\s*38/i,
    result: {
      lat: "53.1338360",
      lon: "8.2190010",
      class: "building",
      type: "museum",
      importance: 0.3,
      name: "Landesmuseum Natur und Mensch",
      display_name: "Landesmuseum Natur und Mensch, 38, Damm, Gerichtsviertel, Oldenburg, Niedersachsen, 26135, Deutschland",
      address: { building: "Landesmuseum Natur und Mensch", house_number: "38", road: "Damm", city: "Oldenburg", state: "Niedersachsen", postcode: "26135", country_code: "de" }
    }
  }
];

const realFetch = global.fetch;
const externalRequests = [];

function fakeJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeDistanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function nearestFakeStop(point) {
  return [...FAKE_STOPS].sort((a, b) => fakeDistanceMeters(point, a) - fakeDistanceMeters(point, b))[0];
}

// Converts an OTP "MM-DD-YYYY" + "HH:MM:SS" Europe/Berlin wall-clock time to epoch ms.
function berlinWallClockToMs(dateText, timeText) {
  const [month, day, year] = String(dateText).split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = String(timeText).split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(guess)).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - guess;
  return guess - offset;
}

function fakeItinerary(from, to, departAtMs) {
  const minute = 60 * 1000;
  const boardStop = nearestFakeStop(from);
  let alightStop = nearestFakeStop(to);
  if (alightStop.id === boardStop.id) alightStop = FAKE_STOPS.find(stop => stop.id !== boardStop.id);
  const walkIn = { start: departAtMs, end: departAtMs + 4 * minute };
  const ride = { start: walkIn.end + 2 * minute, end: walkIn.end + 17 * minute };
  const walkOut = { start: ride.end, end: ride.end + 3 * minute };
  const place = (stop) => ({ name: stop.name, lat: stop.lat, lon: stop.lon, stopId: stop.id });
  return {
    duration: (walkOut.end - walkIn.start) / 1000,
    startTime: walkIn.start,
    endTime: walkOut.end,
    walkTime: 7 * 60,
    transfers: 0,
    legs: [
      {
        mode: "WALK", distance: 300,
        from: { name: "Origin", lat: from.lat, lon: from.lon },
        to: place(boardStop),
        startTime: walkIn.start, endTime: walkIn.end
      },
      {
        mode: "BUS", transitLeg: true, routeShortName: "309", headsign: alightStop.name,
        realTime: false, departureDelay: 0, arrivalDelay: 0,
        from: { ...place(boardStop), departure: ride.start },
        to: { ...place(alightStop), arrival: ride.end },
        startTime: ride.start, endTime: ride.end
      },
      {
        mode: "WALK", distance: 200,
        from: place(alightStop),
        to: { name: "Destination", lat: to.lat, lon: to.lon },
        startTime: walkOut.start, endTime: walkOut.end
      }
    ]
  };
}

function fakeOtpResponse(url) {
  const route = url.pathname.replace(/^\/api\/routers\/[^/]+/, "");
  if (route === "/plan") {
    const [fromLat, fromLon] = url.searchParams.get("fromPlace").split(",").map(Number);
    const [toLat, toLon] = url.searchParams.get("toPlace").split(",").map(Number);
    const requestedMs = berlinWallClockToMs(url.searchParams.get("date"), url.searchParams.get("time"));
    const arriveBy = url.searchParams.get("arriveBy") === "true";
    const from = { lat: fromLat, lon: fromLon };
    const to = { lat: toLat, lon: toLon };
    const tripMs = 26 * 60 * 1000;
    const itineraries = [0, 1, 2].map(index => {
      const departAtMs = arriveBy
        ? requestedMs - 5 * 60 * 1000 - tripMs - index * 15 * 60 * 1000
        : requestedMs + 2 * 60 * 1000 + index * 15 * 60 * 1000;
      return fakeItinerary(from, to, departAtMs);
    });
    return fakeJsonResponse({ plan: { from: { ...from, name: "Origin" }, to: { ...to, name: "Destination" }, itineraries } });
  }
  if (route === "/index/stops") {
    if (!url.searchParams.has("lat")) return fakeJsonResponse([]);
    const point = { lat: Number(url.searchParams.get("lat")), lon: Number(url.searchParams.get("lon")) };
    const radius = Number(url.searchParams.get("radius") || 650);
    return fakeJsonResponse(FAKE_STOPS.filter(stop => fakeDistanceMeters(point, stop) <= radius));
  }
  if (/^\/index\/stops\/[^/]+\/(stoptimes|departures)$/.test(route)) {
    const now = Date.now();
    return fakeJsonResponse([
      { routeShortName: "309", headsign: "Oldenburg ZOB", scheduledDeparture: now + 5 * 60 * 1000, departureDelay: 0 },
      { routeShortName: "310", headsign: "Oldenburg ZOB", scheduledDeparture: now + 20 * 60 * 1000, departureDelay: 0 }
    ]);
  }
  return fakeJsonResponse({ error: { msg: "not found" } }, 404);
}

function fakeGeocoderResponse(url) {
  const query = url.searchParams.get("q") || "";
  const matches = FAKE_GEOCODER_PLACES.filter(place => place.match.test(query)).map(place => place.result);
  return fakeJsonResponse(matches.slice(0, Number(url.searchParams.get("limit") || 1)));
}

global.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  externalRequests.push(url.origin + url.pathname);
  if (url.origin + "/api" === TEST_OTP_BASE) return fakeOtpResponse(url);
  if (url.origin + url.pathname === TEST_GEOCODER_URL) return fakeGeocoderResponse(url);
  throw new Error(`Unexpected external request in tests: ${url.origin}${url.pathname}`);
};

const {
  TIME_MODE,
  extractTripDetails,
  parseTicketDetailsReply,
  parsePartialTicketDetails,
  mergeTicketDetails,
  buildTicketRecommendation,
  validateRequestedTime,
  aliasQueriesForPlace,
  resolveKnownPlace,
  resolveSupportedLocation,
  hasHouseNumber,
  looksLikeStreetAddress,
  isStrongAddressMatch,
  normalizeItinerary,
  shouldSuppressFinalWalk,
  haversineMeters,
  logRouteCoordinateDebug,
  correctPlaceTypos,
  detectPlaceCorrection,
  searchStopsByName,
  findNearbyStops,
  getStopDepartures,
  planRoute,
  buildWalkingRecommendationRoute,
  shouldPreferTransit,
  detectTransitIntent,
  decideRecommendedMode,
  ts,
  handleChatRequest,
  itinerarySatisfiesTimeMode,
  getSession,
  checkApiRateLimit,
  fetchGeocoderJson,
  handleRouteRequest,
  server: appServer
} = require("./server");

const fixedBerlinNow = new Date("2026-06-22T16:14:00.000Z"); // 18:14 Europe/Berlin

test("ticket detail parser handles compact comma and to answer", () => {
  const parsed = parseTicketDetailsReply("hauptbahnhof, to theaterwall 28, 1 person, 10 trips", "en");

  assert.equal(parsed.originText, "hauptbahnhof");
  assert.equal(parsed.destinationText, "theaterwall 28");
  assert.equal(parsed.passengerCount, 1);
  assert.equal(parsed.tripCount, 10);
  assert.equal(parsed.tripPattern, "multiple_trips");
  assert.ok(parsed.confidence >= 0.7);
  assert.deepEqual(parsed.missingFields, []);
});

test("ticket detail parser handles short examples without full sentences", () => {
  const cases = [
    ["hauptbahnhof to theaterwall 28, 1 person, 10 trips", "hauptbahnhof", "theaterwall 28", 1, 10, "multiple_trips"],
    ["from hauptbahnhof to theaterwall 28, 1 person, 10 trips", "hauptbahnhof", "theaterwall 28", 1, 10, "multiple_trips"],
    ["hauptbahnhof, theaterwall 28, 1 person, 10 trips", "hauptbahnhof", "theaterwall 28", 1, 10, "multiple_trips"],
    ["hbf to lappan, 2 people, return trip", "hbf", "lappan", 2, null, "return_trip"],
    ["damm 38 to uni wechloy, 1 person, one trip", "damm 38", "uni wechloy", 1, 1, "single_trip"],
    ["bremen hbf to oldenburg hbf, 3 people, day trip", "bremen hbf", "oldenburg hbf", 3, null, "day_trip"]
  ];

  for (const [input, origin, destination, passengers, trips, pattern] of cases) {
    const parsed = parseTicketDetailsReply(input, "en");
    assert.equal(parsed.originText, origin, input);
    assert.equal(parsed.destinationText, destination, input);
    assert.equal(parsed.passengerCount, passengers, input);
    assert.equal(parsed.tripCount, trips, input);
    assert.equal(parsed.tripPattern, pattern, input);
    assert.ok(parsed.confidence >= 0.7, input);
  }
});

test("ticket support context continues from compact details answer", async () => {
  const sessionId = "ticket-details-compact-answer";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I need ticket information"
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.memory.ticketFlowStatus, "awaiting_ticket_trip_details");

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "hauptbahnhof, to lappan, 1 person, 10 trips",
    ticketFlowStatus: first.body.memory.ticketFlowStatus,
    selectedTicket: first.body.memory.selectedTicket
  });

  assert.equal(second.status, 200);
  assert.match(second.body.reply, /Ticket suggestion/i);
  assert.match(second.body.reply, /Since you plan several trips/i);
  assert.doesNotMatch(second.body.reply, /^Ticket support\s+I can help/i);
  assert.equal(second.body.memory.pendingTicketDetails.originText, "hauptbahnhof");
  assert.equal(second.body.memory.pendingTicketDetails.destinationText, "lappan");
  assert.equal(second.body.memory.pendingTicketDetails.passengerCount, 1);
  assert.equal(second.body.memory.pendingTicketDetails.tripCount, 10);
  assert.ok(second.body.quickButtons.some(button => /^Single ticket$/i.test(button.label)));
  assert.ok(second.body.quickButtons.some(button => /^Day ticket$/i.test(button.label)));
  assert.ok(second.body.quickButtons.some(button => /^Student ticket$/i.test(button.label)));
  assert.ok(second.body.quickButtons.some(button => /Open VBN ticket info/i.test(button.label)));
});

test("ticket recommendation suggests repeated-trip options for one person and ten trips", () => {
  const recommendation = buildTicketRecommendation({
    passengerCount: 1,
    tripCount: 10,
    tripPattern: "multiple_trips",
    selectedTicketOption: "unsure",
    userIsUnsure: true
  }, {}, "en");

  assert.equal(recommendation.title, "Ticket suggestion");
  assert.match(recommendation.text, /Since you plan several trips/i);
  assert.match(recommendation.text, /don't only check single tickets/i);
  assert.ok(recommendation.recommendedOptions.includes("multi_trip"));
  assert.ok(recommendation.recommendedOptions.includes("day"));
  assert.ok(recommendation.recommendedOptions.includes("time_based"));
  assert.ok(recommendation.recommendedOptions.includes("student"));
  assert.ok(recommendation.quickReplies.some(button => /Weekly\/monthly ticket info/i.test(button.label)));
  assert.ok(recommendation.quickReplies.some(button => /Open VBN ticket info/i.test(button.label)));
});

test("ticket partial parser detects origin and destination only", () => {
  const parsed = parsePartialTicketDetails("postenweg to pferdemarkt", {}, "en");

  assert.equal(parsed.originText, "postenweg");
  assert.equal(parsed.destinationText, "pferdemarkt");
  assert.deepEqual(parsed.detectedFields, ["originText", "destinationText"]);
});

test("ticket details merge preserves origin destination and accepts passenger trip follow-up", () => {
  const first = mergeTicketDetails({}, parsePartialTicketDetails("postenweg to pferdemarkt", {}, "en"));
  const second = mergeTicketDetails(first, parsePartialTicketDetails("1 person, 10 trips", first, "en"));

  assert.equal(second.originText, "postenweg");
  assert.equal(second.destinationText, "pferdemarkt");
  assert.equal(second.passengerCount, 1);
  assert.equal(second.tripCount, 10);
  assert.equal(second.tripPattern, "multiple_trips");
  assert.deepEqual(second.missingFields, []);
});

test("ticket detail parser handles bare numeric comma details", () => {
  const parsed = parseTicketDetailsReply("postenweg, lappan, 1, 10 trip", "en");

  assert.equal(parsed.originText, "postenweg");
  assert.equal(parsed.destinationText, "lappan");
  assert.equal(parsed.passengerCount, 1);
  assert.equal(parsed.tripCount, 10);
  assert.equal(parsed.tripPattern, "multiple_trips");
  assert.deepEqual(parsed.missingFields, []);
});

test("ticket support asks only missing passenger and trip after origin destination", async () => {
  const sessionId = "ticket-partial-origin-destination";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I need ticket information"
  });

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "postenweg to pferdemarkt",
    ticketFlowStatus: first.body.memory.ticketFlowStatus,
    selectedTicket: first.body.memory.selectedTicket
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.memory.pendingTicketDetails.originText, "postenweg");
  assert.equal(second.body.memory.pendingTicketDetails.destinationText, "pferdemarkt");
  assert.deepEqual(second.body.memory.pendingTicketDetails.missingFields, ["passengerCount", "tripPattern"]);
  assert.equal(second.body.reply, "Got it - Postenweg to Pferdemarkt. How many people are travelling, and is it one trip or several trips?");
  assert.doesNotMatch(second.body.reply, /Please tell me your origin, destination/);
});

test("ticket support asks whether a single place is start or destination", async () => {
  const sessionId = "ticket-single-place-ambiguous";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I need ticket information"
  });

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "postenweg",
    ticketFlowStatus: first.body.memory.ticketFlowStatus,
    selectedTicket: first.body.memory.selectedTicket
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.reply, "Is Postenweg your starting point or your destination?");
  assert.ok(second.body.quickButtons.some(button => button.label === "Starting point" && button.role === "origin"));
  assert.ok(second.body.quickButtons.some(button => button.label === "Destination" && button.role === "destination"));
  assert.equal(second.body.memory.ticketFlowStatus, "awaiting_ticket_trip_details");
  assert.equal(second.body.memory.pendingAmbiguousPlace.source, "ticket_single_place_ambiguous");

  const third = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Destination",
    ticketFlowStatus: second.body.memory.ticketFlowStatus,
    selectedTicket: second.body.memory.selectedTicket
  });

  assert.equal(third.status, 200);
  assert.equal(third.body.memory.pendingTicketDetails.destinationText, "Postenweg");
  assert.equal(third.body.memory.pendingAmbiguousPlace, null);
});

test("ticket support merges passenger-only then trip-only follow-ups", async () => {
  const sessionId = "ticket-partial-passenger-then-trip";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I need ticket information"
  });

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "postenweg to pferdemarkt",
    ticketFlowStatus: first.body.memory.ticketFlowStatus,
    selectedTicket: first.body.memory.selectedTicket
  });

  const third = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "1 people",
    ticketFlowStatus: second.body.memory.ticketFlowStatus,
    selectedTicket: second.body.memory.selectedTicket
  });

  assert.equal(third.body.memory.pendingTicketDetails.passengerCount, 1);
  assert.deepEqual(third.body.memory.pendingTicketDetails.missingFields, ["tripPattern"]);
  assert.equal(third.body.reply, "Thanks. Is it one trip, a return trip, or several trips?");

  const fourth = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "10 trips",
    ticketFlowStatus: third.body.memory.ticketFlowStatus,
    selectedTicket: third.body.memory.selectedTicket
  });

  assert.equal(fourth.status, 200);
  assert.equal(fourth.body.memory.pendingTicketDetails.originText, "postenweg");
  assert.equal(fourth.body.memory.pendingTicketDetails.destinationText, "pferdemarkt");
  assert.equal(fourth.body.memory.pendingTicketDetails.passengerCount, 1);
  assert.equal(fourth.body.memory.pendingTicketDetails.tripCount, 10);
  assert.equal(fourth.body.memory.pendingTicketDetails.tripPattern, "multiple_trips");
  assert.match(fourth.body.reply, /Thanks\. Since that's several trips/i);
  assert.match(fourth.body.reply, /Ticket suggestion/i);
});

test("ticket support completes numeric comma details without asking passenger again", async () => {
  const sessionId = "ticket-numeric-comma-full-details";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I need ticket information"
  });

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "postenweg, lappan, 1, 10 trip",
    ticketFlowStatus: first.body.memory.ticketFlowStatus,
    selectedTicket: first.body.memory.selectedTicket
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.memory.pendingTicketDetails.originText, "postenweg");
  assert.equal(second.body.memory.pendingTicketDetails.destinationText, "lappan");
  assert.equal(second.body.memory.pendingTicketDetails.passengerCount, 1);
  assert.equal(second.body.memory.pendingTicketDetails.tripCount, 10);
  assert.equal(second.body.memory.pendingTicketDetails.tripPattern, "multiple_trips");
  assert.doesNotMatch(second.body.reply, /How many people are travelling\?/);
  assert.match(second.body.reply, /Ticket suggestion/i);
});

async function sendChatMessage(payload) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = "POST";
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = chunk => {
    if (chunk) chunks.push(Buffer.from(chunk));
    res.emit("finish");
  };

  await new Promise(resolve => {
    res.on("finish", resolve);
    handleChatRequest(req, res);
  });

  return {
    status: res.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
  };
}

function deadlineMsFromRouteResult(routeResult) {
  const dateText = String(routeResult.query.deadlineDate || routeResult.query.otpDate || "");
  const time = String(routeResult.query.deadlineTime || routeResult.query.otpTime || "00:00:00");
  // Use the real Europe/Berlin offset (CET in winter, CEST in summer) rather than a fixed +02:00.
  return berlinWallClockToMs(dateText, time);
}

test("explicit tomorrow arrival request keeps its date and arrival deadline", () => {
  const parsed = extractTripDetails("tomorrow i have to be there in lappan at 8 am from damm 38", "en");

  assert.equal(parsed.originText, "damm 38");
  assert.match(parsed.destinationText, /Lappan/i);
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
  assert.equal(validateRequestedTime({
    requestedDateTime: parsed.requestedDateTime,
    explicitDate: parsed.explicitDate,
    timeMode: parsed.timeMode,
    selectedLanguage: "en",
    now: new Date("2026-06-22T17:24:00.000Z")
  }).status, "ok");
});

test("destination-only 'be there' request is parsed as ARRIVE_BY", () => {
  const parsed = extractTripDetails("i want to be there in lappan at 8:30 am tomorrow", "en");

  assert.equal(parsed.originText, null);
  assert.match(parsed.destinationText, /Lappan/i);
  assert.equal(parsed.requestedDateTime, "tomorrow 8:30 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("explicit today arrival request warns when its clock time has passed", () => {
  const parsed = extractTripDetails("today i have to be there in lappan at 8 am from damm 38", "en");

  assert.equal(parsed.explicitDate, "today");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
  assert.equal(validateRequestedTime({
    requestedDateTime: parsed.requestedDateTime,
    explicitDate: parsed.explicitDate,
    timeMode: parsed.timeMode,
    selectedLanguage: "en",
    now: new Date("2026-06-22T17:24:00.000Z") // 19:24 Europe/Berlin
  }).status, "past_time");
});

test("explicit tomorrow departure request remains DEPART_AT", () => {
  const parsed = extractTripDetails("tomorrow i want to go to lappan at 8 am from damm 38", "en");

  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("destination and tomorrow time without origin asks for origin before time validation", async () => {
  const response = await sendChatMessage({
    sessionId: "missing-origin-before-time-validation",
    selectedLanguage: "en",
    message: "I want to go to Stadt Oldenburg tomorrow at 8 am"
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reply, "Where are you starting from?");
  assert.doesNotMatch(response.body.reply, /already passed/i);
  assert.equal(response.body.memory.route.destination, "Stadt Oldenburg");
  assert.equal(response.body.memory.route.time, "8:00 AM");
  assert.equal(response.body.memory.route.explicitDate, "tomorrow");
  assert.equal(response.body.memory.pendingRoute.mode, "awaiting_origin");
});

test("pending destination route merges a from-origin follow-up without losing tomorrow time", async () => {
  const sessionId = "pending-origin-follow-up";
  await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I want to go to Stadt Oldenburg tomorrow at 8 am"
  });

  const response = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "from Schützenweg"
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body.reply, /Where are you starting from\?/);
  assert.doesNotMatch(response.body.reply, /already passed/i);
  assert.equal(response.body.memory.route.start, "Schützenweg");
  assert.equal(response.body.memory.route.destination, "Stadt Oldenburg");
  assert.equal(response.body.memory.route.time, "8:00 AM");
  assert.equal(response.body.memory.route.explicitDate, "tomorrow");
});

test("complete Stadt Oldenburg tomorrow request keeps origin, destination, and tomorrow time", () => {
  const parsed = extractTripDetails("I want to go to Stadt Oldenburg tomorrow at 8 am from Schützenweg", "en");

  assert.equal(parsed.originText, "Schützenweg");
  assert.equal(parsed.destinationText, "Stadt Oldenburg");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("common tomorrow typo is normalized in complete route requests", () => {
  const parsed = extractTripDetails("I want to go to Stadt Oldenburg tomorow at 8 am from Schützenweg", "en");

  assert.equal(parsed.originText, "Schützenweg");
  assert.equal(parsed.destinationText, "Stadt Oldenburg");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(validateRequestedTime({
    requestedDateTime: parsed.requestedDateTime,
    explicitDate: parsed.explicitDate,
    timeMode: parsed.timeMode,
    selectedLanguage: "en",
    now: new Date("2026-06-22T17:24:00.000Z")
  }).status, "ok");
});

test("12pm and 12am preserve noon, midnight, destination-only state, and ARRIVE_BY", () => {
  const noon = extractTripDetails("i want to be in stadt oldenburg at 12pm tomorrow", "en");
  assert.equal(noon.originText, null);
  assert.equal(noon.destinationText, "stadt oldenburg");
  assert.equal(noon.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(noon.explicitDate, "tomorrow");
  assert.equal(noon.timeMode, TIME_MODE.ARRIVE_BY);

  const midnight = extractTripDetails("i want to be in stadt oldenburg at 12am tomorrow", "en");
  assert.equal(midnight.originText, null);
  assert.equal(midnight.requestedDateTime, "tomorrow 12:00 AM");
  assert.equal(midnight.timeMode, TIME_MODE.ARRIVE_BY);

  const departure = extractTripDetails("i want to go to stadt oldenburg at 12pm tomorrow", "en");
  assert.equal(departure.originText, null);
  assert.equal(departure.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(departure.timeMode, TIME_MODE.DEPART_AT);
});

test("destination arrival with an explicit origin keeps noon and ARRIVE_BY", () => {
  const parsed = extractTripDetails("i want to be in stadt oldenburg at 12pm tomorrow from damm 38", "en");
  assert.equal(parsed.originText, "damm 38");
  assert.equal(parsed.destinationText, "stadt oldenburg");
  assert.equal(parsed.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("need to arrive by is parsed as an explicit tomorrow arrival deadline", () => {
  const parsed = extractTripDetails("tomorrow i need to arrive at lappan by 8 am from damm 38", "en");

  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("supported languages preserve tomorrow and ARRIVE_BY", () => {
  const cases = [
    ["de", "Ich muss morgen um 8 Uhr am Lappan sein von Damm 38"],
    ["hi", "मुझे कल सुबह 8 बजे लप्पन पहुँचना है, Damm 38 से"],
    ["ar", "يجب أن أكون في لابان غدًا الساعة 8 صباحًا من Damm 38"],
    ["uk", "Завтра я маю бути в Лаппані о 8 ранку з Damm 38"],
    ["tr", "Yarın saat 8'de Lappan'da olmam gerekiyor, Damm 38'den"]
  ];

  for (const [lang, input] of cases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(parsed.originText, "Damm 38", lang);
    assert.equal(parsed.destinationText, "Lappan", lang);
    assert.equal(parsed.requestedDateTime, "tomorrow 8:00", lang);
    assert.equal(parsed.explicitDate, "tomorrow", lang);
    assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY, lang);
  }
});

test("ARRIVE_BY itinerary guard rejects arrivals after the requested deadline", () => {
  const deadline = Date.parse("2026-06-23T06:00:00.000Z");
  assert.equal(itinerarySatisfiesTimeMode({ endTime: deadline - 2 * 60000 }, deadline, TIME_MODE.ARRIVE_BY), true);
  assert.equal(itinerarySatisfiesTimeMode({ endTime: deadline + 17 * 60000 }, deadline, TIME_MODE.ARRIVE_BY), false);
  assert.equal(itinerarySatisfiesTimeMode({ endTime: deadline + 17 * 60000 }, deadline, TIME_MODE.DEPART_AT), true);
});

const multilingualPastTimeCases = [
  ["en", "I want to go to Lappan at 6pm today", "Lappan", 18],
  ["de", "Ich möchte heute um 18 Uhr zum Lappan fahren", "Lappan", 18],
  ["ar", "أريد الذهاب إلى لابان اليوم الساعة 6 مساءً", "Lappan", 18],
  ["hi", "मैं आज शाम 6 बजे लप्पन जाना चाहता हूँ", "Lappan", 18],
  ["uk", "Я хочу поїхати до Лаппан сьогодні о 18:00", "Lappan", 18],
  ["tr", "Bugün saat 18:00'de Lappan'a gitmek istiyorum", "Lappan", 18]
];

test("shared multilingual parser emits one language-neutral route shape", () => {
  for (const [lang, input, destination, hour] of multilingualPastTimeCases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(parsed.originText, null, lang);
    assert.match(parsed.destinationText, new RegExp(destination, "i"), lang);
    assert.match(parsed.requestedDateTime, new RegExp(`(?:${hour}:00|6:00 PM)`, "i"), lang);
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT, lang);
    assert.equal(parsed.selectedLanguage, lang, lang);
  }
});

test("one shared validator rejects past times for every supported language", () => {
  for (const [lang, input] of multilingualPastTimeCases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(validateRequestedTime({
      requestedDateTime: parsed.requestedDateTime,
      timeMode: parsed.timeMode,
      selectedLanguage: parsed.selectedLanguage,
      now: fixedBerlinNow
    }).status, "past_time", lang);
  }
});

test("shared validator accepts multilingual future times", () => {
  const cases = [
    ["en", "I want to go to Lappan at 8pm today"],
    ["de", "Ich möchte heute um 20 Uhr zum Lappan fahren"],
    ["ar", "أريد الذهاب إلى لابان اليوم الساعة 8 مساءً"],
    ["hi", "मैं आज रात 8 बजे लप्पन जाना चाहता हूँ"],
    ["uk", "Я хочу поїхати до Лаппан сьогодні о 20:00"]
  ];
  for (const [lang, input] of cases) {
    const parsed = extractTripDetails(input, lang);
    assert.equal(validateRequestedTime({ requestedDateTime: parsed.requestedDateTime, timeMode: parsed.timeMode, selectedLanguage: lang, now: fixedBerlinNow }).status, "ok", lang);
  }
});

function assertParsedRoute(input, expected, selectedLanguage = "en") {
  const parsed = extractTripDetails(input, selectedLanguage);

  assert.deepEqual({
    originText: parsed.start,
    destinationText: parsed.destination,
    requestedDateTime: parsed.time,
    timeMode: parsed.timeMode
  }, expected);
}

test("multilingual German arrival route", () => {
  assertParsedRoute("Ich möchte um 12 Uhr von dem Theaterwall aus am Lappan sein – gib mir die Route.", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "de");
});

test("multilingual Arabic arrival route with bracketed Latin place names", () => {
  assertParsedRoute("أريد الوصول إلى لابان (Lappan) عند الساعة 12 ظهرًا انطلاقًا من شارع تياترفال (Theaterwall)؛ زوّدني بالمسار.", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "ar");
});

test("multilingual Hindi arrival route with bracketed Latin place names", () => {
  assertParsedRoute("मुझे दोपहर 12 बजे थियेटरवाल (Theaterwall) से लैपन (Lappan) पहुँचना है, कृपया मुझे रास्ता बताएं।", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "hi");
});

test("multilingual Arabic arrival route with inline Latin place names", () => {
  assertParsedRoute("أريد الوصول إلى Lappan عند الساعة 12 من Theaterwall", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "ar");
});

test("multilingual Arabic departure route with inline Latin place names", () => {
  assertParsedRoute("أريد الانطلاق الساعة 12 من Theaterwall إلى Lappan", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.DEPART_AT
  }, "ar");
});

test("multilingual Hindi arrival route with inline Latin place names", () => {
  assertParsedRoute("मुझे 12 बजे Theaterwall से Lappan पहुँचना है", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "hi");
});

test("multilingual Hindi departure route with inline Latin place names", () => {
  assertParsedRoute("मैं 12 बजे Theaterwall से Lappan जाना चाहता हूँ", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.DEPART_AT
  }, "hi");
});

test("multilingual Ukrainian arrival route", () => {
  assertParsedRoute("Я хочу бути в Lappan о 12:00 із Theaterwall", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "uk");
});

test("multilingual Ukrainian departure route", () => {
  assertParsedRoute("Я хочу вирушити о 12:00 із Theaterwall до Lappan", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00",
    timeMode: TIME_MODE.DEPART_AT
  }, "uk");
});

test("English arrival route from request", () => {
  assertParsedRoute("I want to be at Lappan at 12pm from Theaterwall.", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  }, "en");
});

test("English departure route from request", () => {
  assertParsedRoute("I want to start at 12pm from Theaterwall to reach Lappan.", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  }, "en");
});

test("arrival intent: want to be on Lappan at 12pm from Theaterwall", () => {
  assertParsedRoute("I want to be on Lappan at 12pm from Theaterwall. Give me the route.", {
    originText: "Theaterwall",
    destinationText: "Lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  });
});

test("departure intent: want to go to Lappan at 12pm from Theaterwall", () => {
  const parsed = extractTripDetails("I want to go to Lappan at 12pm from Theaterwall.");

  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("arrival intent: need to be at university by 9am from Lappan", () => {
  const parsed = extractTripDetails("I need to be at university by 9am from Lappan.");

  assert.equal(parsed.start, "Lappan");
  assert.equal(parsed.destination, "university");
  assert.equal(parsed.time, "9:00 AM");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("departure intent: start at time from origin to reach destination", () => {
  assertParsedRoute("i want to start at 12pm from theaterwall to reach lappan", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: start from origin at time to reach destination", () => {
  assertParsedRoute("start from theaterwall at 12pm to reach lappan", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: leave origin at time and reach destination", () => {
  assertParsedRoute("leave theaterwall at 12pm and reach lappan", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: depart at time from origin to destination", () => {
  assertParsedRoute("depart at 12pm from theaterwall to lappan", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("departure intent: from origin to destination at time", () => {
  assertParsedRoute("from theaterwall to lappan at 12pm", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("arrival intent still works with at", () => {
  assertParsedRoute("i want to be on lappan at 12pm from theaterwall", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  });
});

test("arrival intent still works with by", () => {
  assertParsedRoute("i need to be at lappan by 12pm from theaterwall", {
    originText: "theaterwall",
    destinationText: "lappan",
    requestedDateTime: "12:00 PM",
    timeMode: TIME_MODE.ARRIVE_BY
  });
});

test("departure intent keeps house number out of time and destination fields", () => {
  assertParsedRoute("i want to go to lappan at 2pm from theaterwall 28", {
    originText: "theaterwall 28",
    destinationText: "lappan",
    requestedDateTime: "2:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("street-to-street go-to form treats the first address as origin", () => {
  const parsed = extractTripDetails("i want to go to theaterwall 28 to damm 38 now", "en");
  assert.equal(parsed.originText, "theaterwall 28");
  assert.equal(parsed.destinationText, "damm 38");
  assert.equal(parsed.requestedDateTime, "now");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("go-to place pairs parse both campuses, including Haarentor typo", () => {
  for (const origin of ["uni campus harentor", "uni campus haarentor"]) {
    const parsed = extractTripDetails(`i want to go to ${origin} to uni campus wechloy now`, "en");
    assert.equal(parsed.originText, origin);
    assert.equal(parsed.destinationText, "uni campus wechloy");
    assert.equal(parsed.requestedDateTime, "now");
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
  }
});

test("go-to place pairs parse known stop aliases", () => {
  const parsed = extractTripDetails("i want to go to lappan to pferdemarkt now", "en");
  assert.equal(parsed.originText, "lappan");
  assert.equal(parsed.destinationText, "pferdemarkt");
  assert.equal(parsed.requestedDateTime, "now");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("short origin-to-destination route parses known stop aliases", () => {
  for (const input of [
    "postenweg to pferdemarkt",
    "hauptbahnhof to lappan",
    "hbf to uni wechloy",
    "uni campus haarentor to uni campus wechloy",
    "bremen hbf to oldenburg hbf"
  ]) {
    const parsed = extractTripDetails(input, "en");
    assert.ok(parsed.originText, input);
    assert.ok(parsed.destinationText, input);
    assert.equal(parsed.requestedDateTime, "now", input);
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT, input);
  }

  const postenweg = extractTripDetails("postenweg to pferdemarkt", "en");
  assert.equal(postenweg.originText, "postenweg");
  assert.equal(postenweg.destinationText, "pferdemarkt");
});

test("short origin-to-destination route preserves time and arrival mode", () => {
  const now = extractTripDetails("postenweg to pferdemarkt now", "en");
  assert.equal(now.originText, "postenweg");
  assert.equal(now.destinationText, "pferdemarkt");
  assert.equal(now.requestedDateTime, "now");
  assert.equal(now.timeMode, TIME_MODE.DEPART_AT);

  const atTen = extractTripDetails("postenweg to pferdemarkt at 10am", "en");
  assert.equal(atTen.originText, "postenweg");
  assert.equal(atTen.destinationText, "pferdemarkt");
  assert.equal(atTen.requestedDateTime, "10:00 AM");
  assert.equal(atTen.timeMode, TIME_MODE.DEPART_AT);

  const tomorrowNoon = extractTripDetails("postenweg to pferdemarkt at 12pm tomorrow", "en");
  assert.equal(tomorrowNoon.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(tomorrowNoon.explicitDate, "tomorrow");
  assert.equal(tomorrowNoon.timeMode, TIME_MODE.DEPART_AT);

  const arriveBy = extractTripDetails("postenweg to pferdemarkt arrive by 10am", "en");
  assert.equal(arriveBy.originText, "postenweg");
  assert.equal(arriveBy.destinationText, "pferdemarkt");
  assert.equal(arriveBy.requestedDateTime, "10:00 AM");
  assert.equal(arriveBy.timeMode, TIME_MODE.ARRIVE_BY);
});

test("short origin-to-be-in destination route is parsed as ARRIVE_BY", () => {
  const parsed = extractTripDetails("postenweg to be in pferdemarkt tomorrow at 8 am", "en");

  assert.equal(parsed.originText, "postenweg");
  assert.equal(parsed.destinationText, "pferdemarkt");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("from-origin need-to-be-in destination route is parsed as ARRIVE_BY", () => {
  const parsed = extractTripDetails("from postenweg I need to be in pferdemarkt tomorrow at 8 am", "en");

  assert.equal(parsed.originText, "postenweg");
  assert.equal(parsed.destinationText, "pferdemarkt");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.explicitDate, "tomorrow");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("short origin-to-destination departure wording remains DEPART_AT", () => {
  const parsed = extractTripDetails("postenweg to pferdemarkt tomorrow at 8 am", "en");

  assert.equal(parsed.originText, "postenweg");
  assert.equal(parsed.destinationText, "pferdemarkt");
  assert.equal(parsed.requestedDateTime, "tomorrow 8:00 AM");
  assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT);
});

test("be-at noon with trailing origin preserves noon and ARRIVE_BY", () => {
  const parsed = extractTripDetails("i want to be at lappan at 12pm tomorrow from postenweg", "en");

  assert.equal(parsed.originText, "postenweg");
  assert.match(parsed.destinationText, /lappan/i);
  assert.equal(parsed.requestedDateTime, "tomorrow 12:00 PM");
  assert.equal(parsed.timeMode, TIME_MODE.ARRIVE_BY);
});

test("street-to-street parser supports from and bare address forms", () => {
  for (const input of [
    "i want to go from theaterwall 28 to damm 38 now",
    "from theaterwall 28 to damm 38",
    "theaterwall 28 to damm 38"
  ]) {
    const parsed = extractTripDetails(input, "en");
    assert.equal(parsed.originText, "theaterwall 28", input);
    assert.equal(parsed.destinationText, "damm 38", input);
    assert.equal(parsed.timeMode, TIME_MODE.DEPART_AT, input);
  }
});

test("destination-only go-to forms remain destination-only", () => {
  for (const [input, destination] of [
    ["lappan", /Oldenburg\(Oldb\) Lappan|lappan/i],
    ["i want to go to lappan now", /lappan/i],
    ["i want to go to uni campus haarentor now", /uni campus haarentor/i]
  ]) {
    const parsed = extractTripDetails(input, "en");
    assert.equal(parsed.originText, null, input);
    assert.match(parsed.destinationText, destination, input);
  }
});

test("numbered street addresses require an exact address match, never a stop fallback", () => {
  const exact = {
    name: "Damm 38, Oldenburg",
    lat: 53.133836,
    lon: 8.219001,
    area: "Oldenburg",
    type: "address",
    address: { road: "Damm", house_number: "38", city: "Oldenburg" }
  };
  const stop = {
    name: "Oldenburg(Oldb) Pferdemarkt",
    lat: 53.146771,
    lon: 8.214682,
    area: "Oldenburg",
    type: "stop",
    address: {}
  };

  assert.equal(hasHouseNumber("damm 38"), true);
  assert.equal(looksLikeStreetAddress("damm 38"), true);
  assert.equal(looksLikeStreetAddress("damm"), false);
  assert.equal(isStrongAddressMatch(exact, "damm 38"), true);
  assert.equal(isStrongAddressMatch({ ...exact, address: { ...exact.address, house_number: "21" } }, "damm 38"), false);
  assert.equal(isStrongAddressMatch(stop, "damm 38"), false);
});

test("alias regression resolves lappan and theaterwall 28 variants", () => {
  const lappanAlias = aliasQueriesForPlace("lappan")[0];
  const theaterwallAlias = aliasQueriesForPlace("theaterwall 28")[0];
  const theaterwallTypoAlias = aliasQueriesForPlace("theaterwal 28")[0];

  assert.equal(resolveKnownPlace(lappanAlias, { exactOnly: true }).name, "Oldenburg(Oldb) Lappan");
  assert.equal(resolveKnownPlace(theaterwallAlias, { exactOnly: true }).name, "Theaterwall 28, Oldenburg");
  assert.equal(resolveKnownPlace(theaterwallTypoAlias, { exactOnly: true }).name, "Theaterwall 28, Oldenburg");
});

test("resolvePlace regression keeps theaterwall 28 off Hamelmannstraße", async () => {
  const resolution = await resolveSupportedLocation("theaterwall 28");

  assert.equal(resolution.ok, true);
  assert.match(resolution.place.name, /Theaterwall 28/);
  assert.doesNotMatch(resolution.place.name, /Hamelmannstraße/);
});

function mapsOriginCoords(mapsUrl) {
  const url = new URL(mapsUrl);
  const [lat, lon] = url.searchParams.get("origin").split(",").map(Number);
  return { lat, lon };
}

test("walking map regression starts first WALK leg at resolved origin coordinates", () => {
  const theaterwall28 = { name: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 };
  const lappan = { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 };
  const hamelmannstrasseLikeCoords = { lat: 53.1483, lon: 8.1841 };
  const stopCoords = { lat: 53.1472, lon: 8.1901 };
  const itinerary = normalizeItinerary({
    duration: 600,
    startTime: 1000,
    endTime: 2000,
    legs: [
      {
        mode: "WALK",
        distance: 120,
        from: { name: "Hamelmannstraße", ...hamelmannstrasseLikeCoords },
        to: { name: "Nearest stop", ...stopCoords },
        startTime: 1000,
        endTime: 1100
      },
      {
        mode: "BUS",
        transitLeg: true,
        from: { name: "Nearest stop", ...stopCoords },
        to: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        startTime: 1100,
        endTime: 2000
      }
    ]
  }, {
    requestedOrigin: theaterwall28,
    requestedDestination: lappan
  });

  const firstWalk = itinerary.legs[0];
  assert.deepEqual(firstWalk.fromCoords, { lat: 53.1391, lon: 8.2098 });
  assert.equal(firstWalk.from.name, "Theaterwall 28, Oldenburg");
  assert.match(firstWalk.mapsUrl, /origin=53\.1391,8\.2098/);
  assert.doesNotMatch(firstWalk.mapsUrl, /origin=53\.1483,8\.1841/);
});

test("walking URL regression for theaterwall 28 to lappan proves first origin", () => {
  const input = "i want to go to lappan at 2pm from theaterwall 28";
  const details = extractTripDetails(input);
  const theaterwall28 = { name: "Theaterwall 28, Oldenburg", label: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 };
  const lappan = { name: "Oldenburg(Oldb) Lappan", label: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 };
  const hamelmannstrasseCoords = { lat: 53.1483, lon: 8.1841 };
  const firstStop = { name: "Oldenburg(Oldb) Kath. Friedhof/BBS Haarentor", lat: 53.1472, lon: 8.1901 };
  const itinerary = normalizeItinerary({
    duration: 1800,
    startTime: 1000,
    endTime: 2800,
    legs: [
      {
        mode: "WALK",
        distance: 391,
        from: { name: "Hamelmannstraße", ...hamelmannstrasseCoords },
        to: firstStop,
        startTime: 1000,
        endTime: 1360
      },
      {
        mode: "BUS",
        transitLeg: true,
        routeShortName: "S35",
        from: firstStop,
        to: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        startTime: 1400,
        endTime: 2500
      },
      {
        mode: "WALK",
        distance: 318,
        from: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        to: { name: "Wrong snapped destination", lat: 53.1419, lon: 8.2168 },
        startTime: 2500,
        endTime: 2800
      }
    ]
  }, {
    requestedOrigin: theaterwall28,
    requestedDestination: lappan
  });

  const firstWalkLeg = itinerary.legs.find(leg => leg.mode === "WALK");
  const originCoords = mapsOriginCoords(firstWalkLeg.mapsUrl);
  const originDistance = haversineMeters(theaterwall28.lat, theaterwall28.lon, originCoords.lat, originCoords.lon);
  const hamelmannDistance = haversineMeters(hamelmannstrasseCoords.lat, hamelmannstrasseCoords.lon, originCoords.lat, originCoords.lon);

  assert.equal(details.start, "theaterwall 28");
  assert.equal(details.destination, "lappan");
  assert.equal(details.time, "2:00 PM");
  assert.equal(firstWalkLeg.from.name, "Theaterwall 28, Oldenburg");
  assert.ok(originDistance <= 80);
  assert.ok(hamelmannDistance > 80);
  assert.doesNotMatch(firstWalkLeg.mapsUrl, /53\.1483,8\.1841/);
});

test("final walk regression suppresses Lappan stop to Lappan destination", () => {
  const landesbibliothek = { name: "Landesbibliothek Oldenburg", label: "Landesbibliothek Oldenburg", lat: 53.1471, lon: 8.2147 };
  const lappan = {
    rawText: "lappan",
    name: "Oldenburg(Oldb) Lappan",
    label: "Oldenburg(Oldb) Lappan",
    stopId: "1:000009000995",
    lat: 53.14332,
    lon: 8.214339
  };
  const pferdemarktStop = { name: "Oldenburg(Oldb) Pferdemarkt", stopId: "1:000009000881", lat: 53.146771, lon: 8.214682 };
  const lappanStop = { name: "Oldenburg(Oldb) Lappan", stopId: "1:000009000995", lat: 53.14332, lon: 8.214339 };
  const itinerary = normalizeItinerary({
    duration: 1200,
    startTime: 1000,
    endTime: 2200,
    legs: [
      {
        mode: "WALK",
        distance: 80,
        from: landesbibliothek,
        to: pferdemarktStop,
        startTime: 1000,
        endTime: 1060
      },
      {
        mode: "BUS",
        transitLeg: true,
        routeShortName: "309",
        from: pferdemarktStop,
        to: lappanStop,
        startTime: 1100,
        endTime: 1900
      },
      {
        mode: "WALK",
        distance: 318,
        from: lappanStop,
        to: { name: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 },
        startTime: 1900,
        endTime: 2200
      }
    ]
  }, {
    requestedOrigin: landesbibliothek,
    requestedDestination: lappan
  });

  assert.equal(itinerary.suppressedFinalWalk.shouldSuppressFinalWalk, true);
  assert.equal(itinerary.suppressedFinalWalk.stopIdsMatch, true);
  assert.equal(itinerary.suppressedFinalWalk.namesMatch, true);
  assert.equal(itinerary.suppressedFinalWalk.finalWalkDistance, 318);
  assert.equal(itinerary.legs.filter(leg => leg.mode === "WALK").length, 1);
  assert.equal(itinerary.legs.at(-1).mode, "BUS");
  assert.doesNotMatch(JSON.stringify(itinerary), /origin=53\.14332,8\.214339&destination=53\.1409,8\.2138/);
});

test("final walk regression keeps real POI walk near Lappan", () => {
  const lappanStop = { name: "Oldenburg(Oldb) Lappan", stopId: "1:000009000995", lat: 53.14332, lon: 8.214339 };
  const pferdemarktPoi = {
    rawText: "pferdemarkt",
    name: "Oldenburg(Oldb) Pferdemarkt",
    label: "Oldenburg(Oldb) Pferdemarkt",
    stopId: "1:000009000881",
    lat: 53.146771,
    lon: 8.214682
  };

  assert.equal(shouldSuppressFinalWalk(lappanStop, pferdemarktPoi, {
    distanceMeters: 385,
    from: lappanStop,
    to: pferdemarktPoi
  }), false);
});

test("final walk label translation key exists for required languages", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /walkFromStopToDestination:\s*"from \{from\} to \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"von \{from\} nach \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"من \{from\} إلى \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"від \{from\} до \{to\}"/);
  assert.match(html, /walkFromStopToDestination:\s*"\{from\} से \{to\} तक"/);
});

test("route coordinate debug emits required numbered-address values when DEBUG_MODE is on", () => {
  const input = "i want to go to lappan at 2pm from theaterwall 28";
  const details = extractTripDetails(input);
  const resolvedOrigin = { name: "Theaterwall 28, Oldenburg", label: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 };
  const resolvedDestination = { name: "Oldenburg(Oldb) Lappan", label: "Oldenburg(Oldb) Lappan", lat: 53.1409, lon: 8.2138 };
  const route = {
    legs: [
      {
        mode: "WALK",
        from: { name: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 },
        to: { name: "Oldenburg(Oldb) Kath. Friedhof/BBS Haarentor", lat: 53.1472, lon: 8.1901 },
        fromCoords: { lat: 53.1391, lon: 8.2098 },
        toCoords: { lat: 53.1472, lon: 8.1901 },
        mapsUrl: "https://www.google.com/maps/dir/?api=1&origin=53.1391,8.2098&destination=53.1472,8.1901&travelmode=walking"
      }
    ]
  };
  const captureLogs = debugMode => {
    const captured = [];
    const originalLog = console.log;
    const originalDebugMode = process.env.DEBUG_MODE;
    process.env.DEBUG_MODE = debugMode;
    console.log = (label, payload) => captured.push({ label, payload });
    try {
      logRouteCoordinateDebug({ rawText: input, details, resolvedOrigin, resolvedDestination, route });
    } finally {
      console.log = originalLog;
      process.env.DEBUG_MODE = originalDebugMode;
    }
    return captured;
  };

  // Default (DEBUG_MODE off): no raw text or coordinates are logged.
  assert.deepEqual(captureLogs("false"), []);

  const logs = captureLogs("true");
  const routeRequest = logs.find(log => log.label === "[ROUTE REQUEST DEBUG]").payload;
  const resolvedPlaces = logs.find(log => log.label === "[RESOLVED PLACES DEBUG]").payload;
  const firstWalk = logs.find(log => log.label === "[FIRST WALK LEG DEBUG]").payload;

  assert.deepEqual(routeRequest, {
    rawText: input,
    originText: "theaterwall 28",
    destinationText: "lappan",
    requestedDateTime: "2:00 PM",
    timeMode: TIME_MODE.DEPART_AT
  });
  assert.equal(resolvedPlaces.originLabel, "Theaterwall 28, Oldenburg");
  assert.equal(resolvedPlaces.destinationLabel, "Oldenburg(Oldb) Lappan");
  assert.equal(firstWalk.fromLat, 53.1391);
  assert.equal(firstWalk.fromLon, 8.2098);
  assert.match(firstWalk.mapsUrl, /origin=53\.1391,8\.2098/);
  assert.doesNotMatch(JSON.stringify(logs), /Hamelmannstraße/);
});

test("raw-message UI code adds the user message only once", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const userBubbleAdds = [...html.matchAll(/addMessage\(text,\s*"user"/g)];

  assert.equal(userBubbleAdds.length, 1);
  assert.doesNotMatch(html, /addMessage\([^)]*(?:normalized|translated|corrected)[^)]*,\s*"user"/i);
});

test("Arabic UI has RTL support", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /dir:\s*"rtl"/);
  assert.match(html, /\[dir="rtl"\]/);
});

// --- Typo-tolerant place search ----------------------------------------

test("Test1 parsing: 'i want to travel from posternweg to Pfedermarkt now'", () => {
  assertParsedRoute("i want to travel from posternweg to Pfedermarkt now", {
    originText: "posternweg",
    destinationText: "Pfedermarkt",
    requestedDateTime: "now",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("Test2 parsing: 'from lapan to hauptbanhof'", () => {
  assertParsedRoute("from lapan to hauptbanhof", {
    originText: "lapan",
    destinationText: "hauptbanhof",
    requestedDateTime: "now",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("Test3 parsing: 'from theaterwal 28 to lappan'", () => {
  assertParsedRoute("from theaterwal 28 to lappan", {
    originText: "theaterwal 28",
    destinationText: "lappan",
    requestedDateTime: "now",
    timeMode: TIME_MODE.DEPART_AT
  });
});

test("correctPlaceTypos fixes all known misspellings", () => {
  assert.deepEqual(correctPlaceTypos("posternweg"), { corrected: true, text: "postenweg" });
  assert.deepEqual(correctPlaceTypos("Pfedermarkt"), { corrected: true, text: "pferdemarkt" });
  assert.deepEqual(correctPlaceTypos("theaterwal"), { corrected: true, text: "theaterwall" });
  assert.deepEqual(correctPlaceTypos("teaterwall"), { corrected: true, text: "theaterwall" });
  assert.deepEqual(correctPlaceTypos("lapan"), { corrected: true, text: "lappan" });
  assert.deepEqual(correctPlaceTypos("hauptbanhof"), { corrected: true, text: "hauptbahnhof" });
});

test("detectPlaceCorrection resolves misspelled places to known stops", () => {
  assert.equal(detectPlaceCorrection("posternweg").place.name, "Oldenburg(Oldb) Postenweg");
  assert.equal(detectPlaceCorrection("Pfedermarkt").place.name, "Oldenburg(Oldb) Pferdemarkt");
  assert.equal(detectPlaceCorrection("lapan").place.name, "Oldenburg(Oldb) Lappan");
  assert.equal(detectPlaceCorrection("hauptbanhof").place.name, "Oldenburg Hauptbahnhof");
  assert.equal(detectPlaceCorrection("posternweg").confidence, "high");
});

test("detectPlaceCorrection leaves correctly spelled places alone", () => {
  assert.equal(detectPlaceCorrection("lappan"), null);
  assert.equal(detectPlaceCorrection("theaterwall 28"), null);
  assert.equal(detectPlaceCorrection("theaterwal 28"), null);
  assert.equal(detectPlaceCorrection("postenweg"), null);
  assert.equal(detectPlaceCorrection("pferdemarkt"), null);
  assert.equal(detectPlaceCorrection("hauptbahnhof"), null);
});

test("planRoute Test1: both sides typo'd suggests Postenweg -> Pferdemarkt", async () => {
  const details = extractTripDetails("i want to travel from posternweg to Pfedermarkt now", "en");
  const result = await planRoute(details);

  assert.equal(result.ok, false);
  assert.equal(result.error, "place_correction_suggestions");
  assert.equal(result.correction.origin.place.name, "Oldenburg(Oldb) Postenweg");
  assert.equal(result.correction.destination.place.name, "Oldenburg(Oldb) Pferdemarkt");
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].label, "Oldenburg(Oldb) Postenweg → Oldenburg(Oldb) Pferdemarkt");
  assert.equal(result.suggestions[0].origin.stopId, "1:000009090219");
  assert.ok(Number.isFinite(result.suggestions[0].origin.lat));
  assert.ok(Number.isFinite(result.suggestions[0].destination.lat));
  assert.equal(result.pendingRoute.originText, "posternweg");
  assert.equal(result.pendingRoute.destinationText, "Pfedermarkt");
});

test("planRoute Test2: 'from lapan to hauptbanhof' suggests Lappan -> Hauptbahnhof", async () => {
  const details = extractTripDetails("from lapan to hauptbanhof", "en");
  const result = await planRoute(details);

  assert.equal(result.ok, false);
  assert.equal(result.error, "place_correction_suggestions");
  assert.equal(result.correction.origin.place.name, "Oldenburg(Oldb) Lappan");
  assert.equal(result.correction.destination.place.name, "Oldenburg Hauptbahnhof");
  assert.equal(result.suggestions[0].label, "Oldenburg(Oldb) Lappan → Oldenburg Hauptbahnhof");
});

test("translations: didYouMeanPlace and usingCorrectedPlaces substitute params in all languages", () => {
  for (const lang of ["en", "de", "ar", "tr", "uk", "hi"]) {
    const didYouMean = ts("didYouMeanPlace", lang, { original: "Pfedermarkt", place: "Pferdemarkt" });
    assert.match(didYouMean, /Pfedermarkt/);
    assert.match(didYouMean, /Pferdemarkt/);
    assert.doesNotMatch(didYouMean, /\{original\}|\{place\}/);

    const usingPlaces = ts("usingCorrectedPlaces", lang, { origin: "Postenweg", destination: "Pferdemarkt" });
    assert.match(usingPlaces, /Postenweg/);
    assert.match(usingPlaces, /Pferdemarkt/);
    assert.doesNotMatch(usingPlaces, /\{origin\}|\{destination\}/);

    assert.ok(ts("didYouMeanThesePlaces", lang));
    assert.ok(ts("useThesePlaces", lang));
    assert.ok(ts("enterDifferentPlaces", lang));
    assert.ok(ts("enterAnotherOrigin", lang));
    assert.ok(ts("enterAnotherDestination", lang));
  }
});

test("index.html chip handling supports routeSelection payloads", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /item\.routeSelection/);
  assert.match(html, /storedItem\.routeSelection/);
  assert.match(html, /routeSelection:\s*storedItem\.routeSelection/);
});

test("index.html chip handling sends ambiguous place action payloads before generic actions", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const ambiguousActionIndex = html.indexOf('storedItem.action === "set_ambiguous_place_role"');
  const demoTicketActionIndex = html.indexOf("handleDemoTicketAction(storedItem)");

  assert.notEqual(ambiguousActionIndex, -1);
  assert.notEqual(demoTicketActionIndex, -1);
  assert.ok(ambiguousActionIndex < demoTicketActionIndex);
  assert.match(html, /action:\s*storedItem\.action/);
  assert.match(html, /role:\s*storedItem\.role/);
  assert.match(html, /placeText:\s*storedItem\.placeText/);
});

test("index.html chip handling sends route ticket status payloads before generic actions", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const ticketStatusActionIndex = html.indexOf('storedItem.action === "ticket_status_response"');
  const demoTicketActionIndex = html.indexOf("handleDemoTicketAction(storedItem)");

  assert.notEqual(ticketStatusActionIndex, -1);
  assert.notEqual(demoTicketActionIndex, -1);
  assert.ok(ticketStatusActionIndex < demoTicketActionIndex);
  assert.match(html, /routeContextId:\s*storedItem\.routeContextId/);
});

test("index.html plan trip action sets awaiting origin state and sends memory", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

  assert.match(html, /function setPlanTripAwaitingOrigin\(\)/);
  assert.match(html, /conversationState:\s*"awaiting_origin"/);
  assert.match(html, /sourceFlow:\s*"plan_trip_button"/);
  assert.match(html, /memory:\s*currentServerMemory/);
  assert.match(html, /storedItem\.welcomeAction === "plan_trip"/);
  assert.match(html, /startPlanTripFlow\(storedItem\.label/);
  assert.match(html, /label:\s*ct\("useCurrentLoc"\), value:\s*"__current_location__", action:\s*"use_current_location"/);
  assert.match(html, /label:\s*ct\("typeManually"\), value:\s*"__type_location_manually__", action:\s*"enter_origin"/);
  assert.match(html, /whereStart:\s*\{\s*en:\s*"Where are you starting from\?"/);
});

// --- End-to-end chat flow -----------------------------------------------

function startTestServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => handleChatRequest(req, res));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function postChat(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

test("end-to-end: both-side typo route offers a single-click suggestion that plans the route", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "i want to travel from posternweg to Pfedermarkt now",
      selectedLanguage: "en"
    });

    // Must not show a dead-end "could not find this place" message.
    assert.doesNotMatch(first.reply, /could not find this place/i);
    assert.equal(first.reply, ts("didYouMeanThesePlaces", "en"));

    const suggestion = first.quickButtons.find(button => button.routeSelection);
    assert.ok(suggestion, "expected a routeSelection suggestion button");
    assert.equal(suggestion.label, "Oldenburg(Oldb) Postenweg → Oldenburg(Oldb) Pferdemarkt");

    const second = await postChat(baseUrl, {
      message: suggestion.value,
      selectedLanguage: "en",
      sessionId: first.sessionId,
      routeSelection: suggestion.routeSelection
    });

    assert.match(second.reply, /Postenweg/);
    assert.match(second.reply, /Pferdemarkt/);
    assert.ok(second.routeSummary, "expected a computed route summary");
  } finally {
    server.close();
  }
});

test("end-to-end: 'Enter different places' clears the pending correction", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "i want to travel from posternweg to Pfedermarkt now",
      selectedLanguage: "en"
    });

    const enterDifferent = ts("enterDifferentPlaces", "en");
    const second = await postChat(baseUrl, {
      message: enterDifferent,
      selectedLanguage: "en",
      sessionId: first.sessionId
    });

    assert.equal(second.reply, ts("askRouteOrigin", "en"));
  } finally {
    server.close();
  }
});

test("end-to-end: single-side typo asks about only that place, in the selected language", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "from posternweg to lappan",
      selectedLanguage: "ar"
    });

    assert.equal(response.reply, ts("didYouMeanPlace", "ar", {
      original: "posternweg",
      place: "Oldenburg(Oldb) Postenweg"
    }));

    const suggestion = response.quickButtons.find(button => button.locationSelection);
    assert.ok(suggestion, "expected a locationSelection suggestion button");
    assert.equal(suggestion.locationSelection.name, "Oldenburg(Oldb) Postenweg");
  } finally {
    server.close();
  }
});

test("end-to-end: destination-only query asks for starting point and shows location choice buttons", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "I want to go to Lappan",
      selectedLanguage: "en"
    });

    assert.equal(response.reply, "I can help with that. Where are you starting from?");

    const locationBtn = response.quickButtons.find(b => b.value === "__current_location__");
    assert.ok(locationBtn, "expected a 'Use my current location' button");
    assert.equal(locationBtn.label, ts("useCurrentLoc", "en"));

    const manualBtn = response.quickButtons.find(b => b.value === "__type_location_manually__");
    assert.ok(manualBtn, "expected a 'Type starting point' button");
    assert.equal(manualBtn.label, ts("typeLocManually", "en"));
  } finally {
    server.close();
  }
});

test("end-to-end: bare single place asks whether origin or destination", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "postenweg",
      selectedLanguage: "en"
    });

    assert.equal(response.reply, "Do you want to start from Postenweg or go to Postenweg?");
    assert.ok(response.quickButtons.some(button => button.label === "Start from Postenweg" && button.action === "set_ambiguous_place_role" && button.role === "origin" && button.placeText === "Postenweg"));
    assert.ok(response.quickButtons.some(button => button.label === "Go to Postenweg" && button.action === "set_ambiguous_place_role" && button.role === "destination" && button.placeText === "Postenweg"));
    assert.equal(response.memory.pendingAmbiguousPlace.placeText, "Postenweg");
    assert.equal(response.memory.pendingAmbiguousPlace.conversationStateBefore, "single_place_ambiguous");
    assert.ok(response.memory.pendingAmbiguousPlace.createdAt);
  } finally {
    server.close();
  }
});

test("end-to-end: ambiguous place start action asks for destination", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg",
      selectedLanguage: "en"
    });
    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "Start from Postenweg",
      action: "set_ambiguous_place_role",
      role: "origin",
      placeText: "Postenweg"
    });

    assert.equal(response.reply, "Got it - you're starting from Postenweg. Where do you want to go?");
    assert.equal(response.memory.pendingRoute.mode, "awaiting_destination");
    assert.equal(response.memory.pendingRoute.originText, "Postenweg");
    assert.equal(response.memory.pendingAmbiguousPlace, null);

    const routeResponse = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "pferdemarkt"
    });
    assert.match(routeResponse.reply, /Got it - from Postenweg to Pferdemarkt\. I'll check the next route from now\./i);
  } finally {
    server.close();
  }
});

test("end-to-end: ambiguous place destination role asks for origin", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg",
      selectedLanguage: "en"
    });
    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "Go to Postenweg",
      action: "set_ambiguous_place_role",
      role: "destination",
      placeText: "Postenweg"
    });

    assert.equal(response.reply, "Got it - you want to go to Postenweg. Where are you starting from?");
    assert.equal(response.memory.pendingRoute.mode, "awaiting_origin");
    assert.equal(response.memory.pendingRoute.destinationText, "Postenweg");
    assert.ok(response.quickButtons.some(button => button.value === "__current_location__"));
    assert.ok(response.quickButtons.some(button => button.value === "__type_location_manually__"));
  } finally {
    server.close();
  }
});

test("end-to-end: ambiguous place action without pending state asks to type again", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "Start from Postenweg",
      selectedLanguage: "en",
      action: "set_ambiguous_place_role",
      role: "origin",
      placeText: "Postenweg"
    });

    assert.equal(response.reply, "I lost that place. Please type it again.");
    assert.deepEqual(response.quickButtons, []);
  } finally {
    server.close();
  }
});

test("end-to-end: clear origin-only phrase asks for destination without ambiguity", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "from postenweg",
      selectedLanguage: "en"
    });

    assert.equal(response.reply, "Got it - you're starting from Postenweg. Where do you want to go?");
    assert.equal(response.memory.pendingAmbiguousPlace, null);
    assert.equal(response.memory.pendingRoute.mode, "awaiting_destination");
  } finally {
    server.close();
  }
});

test("end-to-end: ambiguous single place preserves time after destination role", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg at 10am tomorrow",
      selectedLanguage: "en"
    });
    assert.equal(first.reply, "Do you want to start from Postenweg or go to Postenweg?");
    assert.equal(first.memory.pendingAmbiguousPlace.requestedDateTime, "tomorrow 10:00 AM");

    const second = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "destination"
    });
    assert.equal(second.memory.pendingRoute.mode, "awaiting_origin");
    assert.equal(second.memory.pendingRoute.requestedDateTime, "tomorrow 10:00 AM");
    assert.equal(second.memory.pendingRoute.explicitDate, "tomorrow");
  } finally {
    server.close();
  }
});

test("end-to-end: yes after ambiguous place repeats role choices", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "lappan",
      selectedLanguage: "en"
    });
    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "yes"
    });

    assert.equal(response.reply, "Please choose one: start from Lappan or go to Lappan.");
    assert.ok(response.quickButtons.some(button => button.label === "Start from Lappan"));
    assert.ok(response.quickButtons.some(button => button.label === "Go to Lappan"));
  } finally {
    server.close();
  }
});

test("end-to-end: complete short route acknowledges origin and destination", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "postenweg to pferdemarkt",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /Got it - from Postenweg to Pferdemarkt\. I'll check the next route from now\./i);
    assert.doesNotMatch(response.reply, /Where are you starting from/i);
  } finally {
    server.close();
  }
});

test("end-to-end: fresh Tickets action explains ticket options and excludes Tickets button", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "Tickets",
      action: "tickets",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /I can help you understand which ticket may fit your trip\. What do you need\?/);
    assert.deepEqual(response.quickButtons.map(button => button.label), [
      "One trip",
      "More than one trip today",
      "Several days",
      "Monthly / subscription",
      "Student or young person",
      "Group travel",
      "I am not sure",
      "Open VBN ticket info",
      "Plan a trip",
      "Accessibility",
      "Delay help"
    ]);
    assert.ok(!response.quickButtons.some(button => button.label === "Tell trip details"));
    assert.ok(!response.quickButtons.some(button => button.action === "tickets"));
  } finally {
    server.close();
  }
});

test("end-to-end: Tickets action with route context keeps general ticket menu", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg to pferdemarkt",
      selectedLanguage: "en"
    });

    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      message: "Tickets",
      action: "tickets",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /I can help you understand which ticket may fit your trip\. What do you need\?/);
    assert.deepEqual(response.quickButtons.map(button => button.label), [
      "One trip",
      "More than one trip today",
      "Several days",
      "Monthly / subscription",
      "Student or young person",
      "Group travel",
      "I am not sure",
      "Open VBN ticket info",
      "Plan a trip",
      "Accessibility",
      "Delay help"
    ]);
    assert.ok(!response.quickButtons.some(button => button.action === "tickets"));
  } finally {
    server.close();
  }
});

test("end-to-end: ticket option click explains selected ticket and keeps ticket flow buttons", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "Single ticket",
      action: "ticket_option",
      value: "single",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /For one person and one journey, start by checking a Single ticket\./);
    assert.match(response.reply, /Oldenburg and Bremerhaven, it is usually valid for 90 minutes/);
    assert.match(response.reply, /KurzstreckenTicket may be possible/);
    assert.doesNotMatch(response.reply, /Welcome back\. Did you manage to get the ticket/);
    assert.deepEqual(response.quickButtons.map(button => button.label), [
      "Ticket types",
      "I am not sure",
      "Open VBN ticket info",
      "Plan a trip",
      "Accessibility",
      "Delay help"
    ]);
    assert.ok(!response.quickButtons.some(button => button.action === "tickets"));
  } finally {
    server.close();
  }
});

test("end-to-end: day student and group ticket options use explanatory non-price copy and navigation replies", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const cases = [
      ["day", "Day ticket", /valid until 03:00 the next morning/, [
        "Ticket types",
        "I am not sure",
        "Open VBN ticket info",
        "Plan a trip",
        "Accessibility",
        "Delay help"
      ]],
      ["seven_day", "7-day ticket", /valid for seven consecutive days/, [
        "Ticket types",
        "I am not sure",
        "Open VBN ticket info",
        "Plan a trip",
        "Accessibility",
        "Delay help"
      ]],
      ["monthly_subscription", "Monthly / subscription", /Monthly ticket, MIA, MIAplus, or Deutschland-ticket/, [
        "Deutschland-ticket info",
        "MIA info",
        "Ticket types",
        "I am not sure",
        "Open VBN ticket info",
        "Plan a trip",
        "Accessibility",
        "Delay help"
      ]],
      ["student", "Student ticket", /Semester ticket \/ Deutschlandsemesterticket/, [
        "I am not sure",
        "Ticket types",
        "Open VBN ticket info",
        "Plan a trip",
        "Accessibility",
        "Delay help"
      ]]
    ];

    for (const [value, message, expected, expectedButtons] of cases) {
      const response = await postChat(baseUrl, {
        message,
        action: "ticket_option",
        value,
        selectedLanguage: "en"
      });
      assert.match(response.reply, expected);
      assert.match(response.reply, /official VBN page/);
      assert.doesNotMatch(response.reply, /Where are you travelling from and to\?/);
      assert.doesNotMatch(response.reply, /Welcome back\. Did you manage to get the ticket/);
      assert.deepEqual(response.quickButtons.map(button => button.label), expectedButtons);
      assert.ok(!response.quickButtons.some(button => button.action === "tickets"));
    }

    const monthlyByCategoryAction = await postChat(baseUrl, {
      message: "Monthly / subscription",
      action: "ticket_monthly_subscription",
      value: "monthly_subscription",
      selectedLanguage: "en"
    });
    assert.match(monthlyByCategoryAction.reply, /Monthly ticket/);
    assert.match(monthlyByCategoryAction.reply, /MIAplus/);
    assert.match(monthlyByCategoryAction.reply, /Deutschland-ticket/);
    assert.doesNotMatch(monthlyByCategoryAction.reply, /Where are you travelling from and to\?/);
    assert.equal(monthlyByCategoryAction.memory.conversationState, "neutral");

    const studentByCategoryAction = await postChat(baseUrl, {
      message: "Student or young person",
      action: "ticket_student_youth",
      value: "student",
      selectedLanguage: "en"
    });
    assert.match(studentByCategoryAction.reply, /Semester ticket \/ Deutschlandsemesterticket/);
    assert.match(studentByCategoryAction.reply, /Schüler tickets/);
    assert.match(studentByCategoryAction.reply, /TIM/);
    assert.match(studentByCategoryAction.reply, /Jugend-FreizeitTicket/);
    assert.match(studentByCategoryAction.reply, /Children under 6/);
    assert.match(studentByCategoryAction.reply, /customer card or proof/);
    assert.doesNotMatch(studentByCategoryAction.reply, /Welcome back\. Did you manage to get the ticket/);
    assert.doesNotMatch(studentByCategoryAction.reply, /Where are you travelling from and to\?/);

    const continueResponse = await postChat(baseUrl, {
      message: "Continue to ticket page",
      action: "ticket_continue",
      value: "student",
      selectedLanguage: "en"
    });
    assert.match(continueResponse.reply, /Ticket page opened\. If you come back without buying, you can continue here\./);
    assert.doesNotMatch(continueResponse.reply, /Welcome back\. Did you manage to get the ticket/);
    assert.equal(continueResponse.memory.userOpenedTicketPage, true);
    assert.equal(continueResponse.memory.awaitingTicketReturn, true);

    const group = await postChat(baseUrl, {
      message: "Group travel",
      action: "ticket_option",
      value: "group",
      selectedLanguage: "en"
    });
    assert.match(group.reply, /Niedersachsen-Ticket can be useful/);
    assert.match(group.reply, /How many people are travelling\?/);
    assert.doesNotMatch(group.reply, /Welcome back\. Did you manage to get the ticket/);
    assert.deepEqual(group.quickButtons.map(button => button.label), [
      "2 people",
      "3-5 people",
      "6-9 people",
      "10 or more people",
      "Ticket types",
      "I am not sure",
      "Open VBN ticket info",
      "Plan a trip",
      "Accessibility",
      "Delay help"
    ]);
  } finally {
    server.close();
  }
});

test("end-to-end: Ticket types after ticket explanation reopens general ticket categories", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "Ticket types",
      action: "ticket_types",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /Here are common ticket types you can check\./);
    assert.deepEqual(response.quickButtons.map(button => button.label), [
      "One trip",
      "More than one trip today",
      "Several days",
      "Monthly / subscription",
      "Student or young person",
      "Group travel",
      "I am not sure",
      "Open VBN ticket info",
      "Plan a trip",
      "Accessibility",
      "Delay help"
    ]);
    assert.ok(!response.quickButtons.some(button => button.label === "Tell trip details"));
  } finally {
    server.close();
  }
});

test("end-to-end: I am not sure starts trip-based guidance without route context", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "I am not sure",
      action: "ticket_need",
      value: "not_sure",
      selectedLanguage: "en"
    });

    assert.equal(response.reply, "No problem. I'll ask a few simple questions.\n\nHow often will you travel?");
    assert.equal(response.memory.conversationState, "awaiting_ticket_frequency");
    assert.deepEqual(response.quickButtons.map(button => button.label), [
      "Only one trip",
      "More than once today",
      "Several days",
      "Regularly",
      "I am a student",
      "Group travel",
      "Plan a trip",
      "Accessibility",
      "Delay help"
    ]);
    assert.deepEqual(response.memory.pendingTicketDetails, {
      sourceFlow: "ticket_support",
      originText: null,
      destinationText: null,
      passengerCount: null,
      tripCount: null,
      tripPattern: null,
      selectedTicketOption: null,
      userIsUnsure: true,
      missingFields: ["originText", "destinationText", "passengerCount", "tripPattern"]
    });
  } finally {
    server.close();
  }
});

test("end-to-end: I am not sure after a route uses current route for ticket advice", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg to pferdemarkt",
      selectedLanguage: "en"
    });
    await postChat(baseUrl, {
      sessionId: first.sessionId,
      message: "Tickets",
      action: "tickets",
      selectedLanguage: "en"
    });

    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      message: "I am not sure",
      action: "ticket_need",
      value: "not_sure",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /No problem\. I'll help with the ticket for your current route from Postenweg to Pferdemarkt\./);
    assert.doesNotMatch(response.reply, /Where are you travelling from and to/i);
    assert.ok(response.quickButtons.some(button => button.action === "ticket_option" && button.value === "single"));
    assert.ok(response.quickButtons.some(button => button.action === "ticket_continue"));
  } finally {
    server.close();
  }
});

test("end-to-end: main actions remain usable after a ticket explanation", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const day = await postChat(baseUrl, {
      message: "Day ticket",
      action: "ticket_option",
      value: "day",
      selectedLanguage: "en"
    });

    const plan = await postChat(baseUrl, {
      sessionId: day.sessionId,
      message: "Plan a trip",
      action: "plan_trip",
      selectedLanguage: "en"
    });
    assert.equal(plan.reply, "Where are you starting from?");
    assert.deepEqual(plan.quickButtons.map(button => button.label), [
      "Use my current location",
      "Type starting point",
      "Tickets",
      "Accessibility",
      "Delay help"
    ]);

    const accessibility = await postChat(baseUrl, {
      sessionId: day.sessionId,
      message: "Accessibility",
      action: "accessibility",
      selectedLanguage: "en"
    });
    assert.equal(accessibility.reply, "What kind of support do you need?");
    assert.deepEqual(accessibility.quickButtons.map(button => button.label), [
      "Wheelchair accessible route",
      "Less walking",
      "Step-free access",
      "Avoid stairs",
      "Plan a trip",
      "Tickets",
      "Delay help"
    ]);

    const delay = await postChat(baseUrl, {
      sessionId: day.sessionId,
      message: "Delay help",
      action: "delay_help",
      selectedLanguage: "en"
    });
    assert.equal(delay.reply, "I can help with delays. Which route, stop, or line should I check?");
    assert.deepEqual(delay.quickButtons.map(button => button.label), [
      "Plan a trip",
      "Tickets",
      "Accessibility"
    ]);
  } finally {
    server.close();
  }
});

test("end-to-end: ticket unsure after a route uses previous route context", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg to pferdemarkt",
      selectedLanguage: "en"
    });
    assert.ok(first.memory.lastRouteContext, "expected route context to be saved");

    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "I am not sure",
      action: "ticket_status_response",
      value: "not_sure",
      routeContextId: first.memory.lastRouteContext.routeContextId
    });

    assert.match(response.reply, /No problem\. I'll help with the ticket for this route\./);
    assert.match(response.reply, /from Postenweg to Pferdemarkt/i);
    assert.doesNotMatch(response.reply, /Where are you travelling from and to/i);
    assert.ok(response.quickButtons.some(button => button.action === "ticket_option" && button.value === "single"));
    assert.ok(response.quickButtons.some(button => button.action === "ticket_option" && button.value === "day"));
    assert.ok(response.quickButtons.some(button => button.action === "ticket_option" && button.value === "student"));
    assert.ok(response.quickButtons.some(button => button.action === "ticket_option" && button.value === "group"));
    assert.ok(response.quickButtons.some(button => button.action === "ticket_continue"));
  } finally {
    server.close();
  }
});

test("end-to-end: no-need-ticket after a route uses previous route context", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg to pferdemarkt",
      selectedLanguage: "en"
    });
    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "No, I need a ticket",
      action: "ticket_status_response",
      value: "needs_ticket",
      routeContextId: first.memory.lastRouteContext.routeContextId
    });

    assert.match(response.reply, /Okay\. For this route from Postenweg to Pferdemarkt/i);
    assert.doesNotMatch(response.reply, /Where are you travelling from and to/i);
  } finally {
    server.close();
  }
});

test("end-to-end: has-ticket after a route gives validity reminder", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg to pferdemarkt",
      selectedLanguage: "en"
    });
    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "Yes, I have a ticket",
      action: "ticket_status_response",
      value: "has_ticket",
      routeContextId: first.memory.lastRouteContext.routeContextId
    });

    assert.match(response.reply, /Please make sure your ticket is valid for this route and time/i);
    assert.doesNotMatch(response.reply, /Where are you travelling from and to/i);
  } finally {
    server.close();
  }
});

test("end-to-end: ticket unsure without route context starts normal ticket flow", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postChat(baseUrl, {
      message: "I am not sure",
      selectedLanguage: "en"
    });

    assert.match(response.reply, /Where are you travelling from and to/i);
    assert.equal(response.memory.lastRouteContext, null);
  } finally {
    server.close();
  }
});

test("end-to-end: ticket unsure after second route uses newest route context", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "postenweg to lappan",
      selectedLanguage: "en"
    });
    const second = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "postenweg to pferdemarkt"
    });
    const response = await postChat(baseUrl, {
      sessionId: first.sessionId,
      selectedLanguage: "en",
      message: "I am not sure",
      action: "ticket_status_response",
      value: "not_sure",
      routeContextId: second.memory.lastRouteContext.routeContextId
    });

    assert.match(response.reply, /Pferdemarkt/i);
    assert.doesNotMatch(response.reply, /from Postenweg to Lappan/i);
    assert.notEqual(first.memory.lastRouteContext.routeContextId, second.memory.lastRouteContext.routeContextId);
  } finally {
    server.close();
  }
});

test("end-to-end: ambiguous noon destination selection preserves ARRIVE_BY and still asks for origin", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const previous = await postChat(baseUrl, {
      message: "from postenweg to lappan now",
      selectedLanguage: "en"
    });
    assert.match(previous.memory.route.start, /postenweg/i);

    const first = await postChat(baseUrl, {
      message: "i want to be in stadt oldenburg at 12pm tomorrow",
      selectedLanguage: "en",
      sessionId: previous.sessionId
    });

    const buergerbuero = first.quickButtons.find(button => /Bürgerbüro Oldenburg/i.test(button.label || ""));
    assert.ok(buergerbuero?.locationSelection, "expected Bürgerbüro destination choice");
    assert.equal(first.memory.route.start, "");
    assert.equal(first.memory.route.time, "tomorrow 12:00 PM");
    assert.equal(first.memory.route.timeMode, TIME_MODE.ARRIVE_BY);

    const second = await postChat(baseUrl, {
      message: buergerbuero.value,
      selectedLanguage: "en",
      sessionId: first.sessionId,
      selectedLocation: buergerbuero.locationSelection,
      locationRole: "destination"
    });

    assert.equal(second.reply, "I can help with that. Where are you starting from?");
    assert.equal(second.lastRouteResult, null);
    assert.equal(second.routeSummary, "");
    assert.equal(second.memory.route.start, "");
    assert.equal(second.memory.route.destination, "Bürgerbüro Oldenburg");
    assert.equal(second.memory.route.time, "tomorrow 12:00 PM");
    assert.equal(second.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
    assert.ok(second.quickButtons.some(button => button.value === "__current_location__"));
    assert.ok(second.quickButtons.some(button => button.value === "__type_location_manually__"));

    const third = await postChat(baseUrl, {
      message: "damm 38",
      selectedLanguage: "en",
      sessionId: first.sessionId
    });
    assert.equal(third.memory.route.start, "damm 38");
    assert.equal(third.memory.route.time, "tomorrow 12:00 PM");
    assert.equal(third.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
    if (third.lastRouteResult) {
      assert.equal(third.lastRouteResult.query.arriveBy, true);
      assert.ok(third.lastRouteResult.route.endTime <= deadlineMsFromRouteResult(third.lastRouteResult));
      assert.doesNotMatch(third.routeSummary, /12:09 AM|12:29 AM/i);
    }
  } finally {
    server.close();
  }
});

test("end-to-end: pending origin preserves tomorrow ARRIVE_BY deadline", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "i want to be there in lappan at 8:30 am tomorrow",
      selectedLanguage: "en"
    });

    assert.equal(first.reply, "I can help with that. Where are you starting from?");
    assert.equal(first.memory.pendingRoute.mode, "awaiting_origin");
    assert.equal(first.memory.pendingRoute.requestedDateTime.toLowerCase(), "tomorrow 8:30 am");
    assert.equal(first.memory.pendingRoute.explicitDate, "tomorrow");
    assert.equal(first.memory.pendingRoute.timeMode, TIME_MODE.ARRIVE_BY);

    const second = await postChat(baseUrl, {
      message: "damm 38",
      selectedLanguage: "en",
      sessionId: first.sessionId
    });

    assert.equal(second.memory.route.time.toLowerCase(), "tomorrow 8:30 am");
    assert.equal(second.memory.route.explicitDate, "tomorrow");
    assert.equal(second.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
    if (second.lastRouteResult) {
      assert.equal(second.lastRouteResult.query.arriveBy, true);
      assert.ok(second.lastRouteResult.route.endTime <= deadlineMsFromRouteResult(second.lastRouteResult));
      assert.doesNotMatch(second.reply, /Leave 8:30 AM\s*·\s*Arrive after 8:30 AM/i);
    }
  } finally {
    server.close();
  }
});

test("end-to-end: destination-only then geolocation coords plans the route without re-asking for origin", async () => {
  const server = await startTestServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await postChat(baseUrl, {
      message: "I want to go to Lappan",
      selectedLanguage: "en"
    });

    assert.ok(first.sessionId, "expected a session ID");
    assert.equal(first.reply, "I can help with that. Where are you starting from?");

    const second = await postChat(baseUrl, {
      message: "Use my current location",
      selectedLanguage: "en",
      sessionId: first.sessionId,
      useCurrentLocation: true,
      fromCoords: { lat: 53.1391, lon: 8.2098 }
    });

    assert.doesNotMatch(second.reply, /starting point/i);
    assert.doesNotMatch(second.reply, /starting from/i);
  } finally {
    server.close();
  }
});

test("end-to-end: current location then single place treats it as destination", async () => {
  const sessionId = "current-location-then-pferdemarkt";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Use my current location",
    useCurrentLocation: true,
    fromCoords: { lat: 53.1391, lon: 8.2098 }
  });

  assert.equal(first.status, 200);
  assert.match(first.body.reply, /I found your location\./);
  assert.match(first.body.reply, /nearest suitable stop:/i);
  assert.match(first.body.reply, /Where do you want to go\?/);
  assert.equal(first.body.memory.pendingRoute.mode, "awaiting_destination");
  assert.equal(first.body.memory.pendingRoute.originText, "Current location");
  assert.equal(first.body.memory.pendingRoute.originStop.type, "stop");

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Pferdemarkt"
  });

  assert.equal(second.status, 200);
  assert.doesNotMatch(second.body.reply, /Do you want to start from Pferdemarkt or go to Pferdemarkt\?/);
  assert.equal(second.body.memory.route.start, "My current location");
  assert.equal(second.body.memory.route.destination, "Pferdemarkt");
  assert.equal(second.body.memory.pendingAmbiguousPlace, null);
});

test("stop lookup finds partial stop names and neutral chat asks origin or destination", async () => {
  const matches = await searchStopsByName("pferde");
  assert.ok(matches.some(stop => /Pferdemarkt/i.test(stop.name)));

  const response = await sendChatMessage({
    sessionId: "stop-lookup-postenweg-neutral",
    selectedLanguage: "en",
    message: "Postenweg"
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reply, "Do you want to start from Postenweg or go to Postenweg?");
});

test("stop departure query resolves stop and returns departure section", async () => {
  const response = await sendChatMessage({
    sessionId: "next-bus-from-postenweg",
    selectedLanguage: "en",
    message: "next bus from Postenweg"
  });

  assert.equal(response.status, 200);
  assert.match(response.body.reply, /Next departures from Oldenburg\(Oldb\) Postenweg:/);
  assert.doesNotMatch(response.body.reply, /Do you want to start from/i);
});

test("current location near Postenweg stores nearest stop for later routing", async () => {
  const response = await sendChatMessage({
    sessionId: "current-location-near-postenweg-stop",
    selectedLanguage: "en",
    message: "Use my current location",
    useCurrentLocation: true,
    fromCoords: { lat: 53.1409, lon: 8.1716 }
  });

  assert.equal(response.status, 200);
  assert.match(response.body.reply, /Postenweg/);
  assert.equal(response.body.memory.pendingRoute.origin.type, "current_location");
  assert.match(response.body.memory.pendingRoute.originStop.name, /Postenweg/);
  assert.equal(response.body.memory.selectedLocations.start.type, "stop");
});

test("hauptbahnhof stop lookup offers Oldenburg and Bremen clarification options", async () => {
  const response = await sendChatMessage({
    sessionId: "hauptbahnhof-stop-clarification",
    selectedLanguage: "en",
    message: "Hauptbahnhof"
  });

  assert.equal(response.status, 200);
  assert.match(response.body.reply, /Which one do you mean\?/);
  assert.ok(response.body.quickButtons.some(button => /Oldenburg.*Hauptbahnhof/i.test(button.label)));
  assert.ok(response.body.quickButtons.some(button => /Bremen Hauptbahnhof/i.test(button.label)));
});

test("nearby stop lookup expands radius and returns empty safely", async () => {
  const nearPostenweg = await findNearbyStops(53.1409, 8.1716, 300);
  assert.ok(nearPostenweg.some(stop => /Postenweg/i.test(stop.name)));

  const nowhere = await findNearbyStops(0, 0, 300);
  assert.deepEqual(nowhere, []);
});

test("end-to-end: awaiting origin then single place treats it as origin", async () => {
  const sessionId = "awaiting-origin-then-postenweg";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "I want to go to Pferdemarkt"
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.memory.pendingRoute.mode, "awaiting_origin");

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg"
  });

  assert.equal(second.status, 200);
  assert.doesNotMatch(second.body.reply, /Do you want to start from Postenweg or go to Postenweg\?/);
  assert.equal(second.body.memory.route.start, "Postenweg");
  assert.equal(second.body.memory.route.destination, "Pferdemarkt");
  assert.equal(second.body.memory.pendingAmbiguousPlace, null);
});

test("end-to-end: plan trip action collects origin then destination without ambiguity", async () => {
  const sessionId = "plan-trip-origin-destination";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Plan a trip",
    action: "plan_trip"
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.reply, "Where are you starting from?");
  assert.equal(first.body.memory.conversationState, "awaiting_origin");
  assert.equal(first.body.memory.pendingRoute.mode, "awaiting_origin");
  assert.ok(first.body.quickButtons.some(button => button.value === "__current_location__"));
  assert.ok(first.body.quickButtons.some(button => button.value === "__type_location_manually__"));

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg"
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.reply, "Got it - you're starting from Postenweg. Where do you want to go?");
  assert.doesNotMatch(second.body.reply, /Do you want to start from Postenweg or go to Postenweg\?/);
  assert.equal(second.body.memory.conversationState, "awaiting_destination");
  assert.equal(second.body.memory.pendingRoute.originText, "Postenweg");

  const third = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Pferdemarkt"
  });

  assert.equal(third.status, 200);
  assert.doesNotMatch(third.body.reply, /Do you want to start from Pferdemarkt or go to Pferdemarkt\?/);
  assert.equal(third.body.memory.route.start.toLowerCase(), "postenweg");
  assert.equal(third.body.memory.route.destination.toLowerCase(), "pferdemarkt");
  assert.equal(third.body.memory.pendingAmbiguousPlace, null);
});

test("end-to-end: client memory awaiting origin treats single place as origin", async () => {
  const sessionId = "client-memory-awaiting-origin";
  const response = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg",
    memory: {
      conversationState: "awaiting_origin",
      pendingRoute: {
        mode: "awaiting_origin",
        originText: null,
        origin: null,
        destinationText: null,
        destination: null,
        requestedDateTime: "now",
        timeMode: TIME_MODE.DEPART_AT,
        sourceFlow: "plan_trip_button"
      }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reply, "Got it - you're starting from Postenweg. Where do you want to go?");
  assert.doesNotMatch(response.body.reply, /Do you want to start from Postenweg or go to Postenweg\?/);
  assert.equal(response.body.memory.pendingRoute.mode, "awaiting_destination");
  assert.equal(response.body.memory.pendingRoute.originText, "Postenweg");
});

test("end-to-end: plan trip accepts a full route while awaiting origin", async () => {
  const sessionId = "plan-trip-full-route";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Plan a trip",
    action: "plan_trip"
  });

  assert.equal(first.body.memory.pendingRoute.mode, "awaiting_origin");

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg to Pferdemarkt"
  });

  assert.equal(second.status, 200);
  assert.doesNotMatch(second.body.reply, /Do you want to start from/i);
  assert.equal(second.body.memory.route.start, "Postenweg");
  assert.equal(second.body.memory.route.destination, "Pferdemarkt");
  assert.equal(second.body.memory.pendingAmbiguousPlace, null);
});

test("end-to-end: no-time route assumes now and offers change time", async () => {
  const sessionId = "route-time-assumption-now";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg"
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.reply, "Do you want to start from Postenweg or go to Postenweg?");

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Start from Postenweg"
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.reply, "Got it - you're starting from Postenweg. Where do you want to go?");

  const third = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Pferdemarkt"
  });

  assert.equal(third.status, 200);
  assert.match(third.body.reply, /I'll check the next route from now\./);
  assert.equal(third.body.memory.route.time, "now");
  assert.equal(third.body.memory.lastRouteContext.requestedDateTime, "now");
  assert.ok(third.body.quickButtons.some(button => button.label === "Change time" && button.action === "route_change_time"));
});

test("end-to-end: change time asks for time and recalculates same route", async () => {
  const sessionId = "route-change-time-recalculate";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg to Pferdemarkt"
  });

  assert.equal(first.status, 200);
  assert.ok(first.body.quickButtons.some(button => button.label === "Change time"));

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Change time",
    action: "route_change_time"
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.reply, "Sure. Should I change the departure time or the arrival time?");
  assert.equal(second.body.memory.conversationState, "awaiting_route_time_change");
  assert.ok(second.body.quickButtons.some(button => button.label === "Choose departure time"));

  const third = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "tomorrow at 8 am"
  });

  assert.equal(third.status, 200);
  assert.match(third.body.reply, /Postenweg to Pferdemarkt tomorrow at 08:00/i);
  assert.equal(third.body.memory.route.start.toLowerCase(), "postenweg");
  assert.equal(third.body.memory.route.destination.toLowerCase(), "pferdemarkt");
  assert.equal(third.body.memory.route.time, "tomorrow 8:00 AM");
  assert.equal(third.body.memory.route.timeMode, TIME_MODE.DEPART_AT);
});

test("end-to-end: change time supports arrive-by recalculation", async () => {
  const sessionId = "route-change-time-arrive-by";
  const first = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg to Pferdemarkt"
  });

  const second = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Change time",
    action: "route_change_time"
  });

  assert.equal(second.status, 200);

  const third = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "arrive by 8 am tomorrow"
  });

  assert.equal(third.status, 200);
  assert.equal(third.body.memory.route.start.toLowerCase(), "postenweg");
  assert.equal(third.body.memory.route.destination.toLowerCase(), "pferdemarkt");
  assert.equal(third.body.memory.route.time, "tomorrow 8:00 AM");
  assert.equal(third.body.memory.route.timeMode, TIME_MODE.ARRIVE_BY);
  assert.equal(third.body.lastRouteResult.query.arriveBy, true);
});

test("end-to-end: direct route with explicit time does not ask change-time first", async () => {
  const sessionId = "direct-route-explicit-time";
  const response = await sendChatMessage({
    sessionId,
    selectedLanguage: "en",
    message: "Postenweg to Pferdemarkt tomorrow at 8 am"
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body.reply, /^When do you want to travel\?/);
  assert.match(response.body.reply, /Postenweg to Pferdemarkt tomorrow at 08:00/i);
  assert.equal(response.body.memory.route.time, "tomorrow 8:00 AM");
  assert.ok(response.body.quickButtons.some(button => button.label === "Change time"));
});

// --- Walk-leg labeling correctness -----------------------------------------

test("normalizeItinerary: first WALK leg before BUS uses boarding stop as 'to', not the final destination", () => {
  const itinerary = {
    duration: 780,
    startTime: 1700000000000,
    endTime: 1700000780000,
    legs: [
      {
        mode: "WALK",
        distance: 331,
        startTime: 1700000000000,
        endTime: 1700000300000,
        from: { name: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 },
        to:   { name: "Oldenburg(Oldb) Postenweg",  lat: 53.1472, lon: 8.1901 }
      },
      {
        mode: "BUS",
        routeShortName: "309",
        startTime: 1700000300000,
        endTime: 1700001020000,
        from: { name: "Oldenburg(Oldb) Postenweg", lat: 53.1472, lon: 8.1901 },
        to:   { name: "Oldenburg(Oldb) Lappan",    lat: 53.1409, lon: 8.2138 }
      }
    ]
  };

  const routeCoords = {
    requestedOrigin:      { name: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 },
    requestedDestination: { name: "Oldenburg(Oldb) Lappan",     lat: 53.1409, lon: 8.2138 },
    originLabel:      "Theaterwall 28, Oldenburg",
    destinationLabel: "Oldenburg(Oldb) Lappan"
  };

  const result = normalizeItinerary(itinerary, routeCoords);
  const walkLeg = result.legs.find(l => l.mode === "WALK");

  assert.ok(walkLeg, "expected a WALK leg");
  // The walk ends at the BUS boarding stop, not the final destination
  assert.equal(walkLeg.to.name, "Oldenburg(Oldb) Postenweg",
    "first WALK leg must lead to the boarding stop, not the final destination");
  assert.notEqual(walkLeg.to.name, "Oldenburg(Oldb) Lappan",
    "first WALK leg must NOT use requestedDestination as its 'to'");
  // The Maps URL must go to Postenweg coords, not Lappan coords
  assert.match(walkLeg.mapsUrl, /destination=53\.1472,8\.1901/,
    "walk mapsUrl must target boarding stop coordinates");
});

test("normalizeItinerary: final WALK leg after BUS still uses requestedDestination as 'to'", () => {
  const itinerary = {
    duration: 1080,
    startTime: 1700000000000,
    endTime: 1700001080000,
    legs: [
      {
        mode: "BUS",
        routeShortName: "309",
        startTime: 1700000000000,
        endTime: 1700000780000,
        from: { name: "Oldenburg(Oldb) Postenweg", lat: 53.1472, lon: 8.1901 },
        to:   { name: "Oldenburg(Oldb) Lappan",    lat: 53.1409, lon: 8.2138 }
      },
      {
        mode: "WALK",
        distance: 150,
        startTime: 1700000780000,
        endTime: 1700001080000,
        from: { name: "Oldenburg(Oldb) Lappan",  lat: 53.1409, lon: 8.2138 },
        to:   { name: "Lappan Building Entrance", lat: 53.1405, lon: 8.2140 }
      }
    ]
  };

  const routeCoords = {
    requestedOrigin:      { name: "Oldenburg(Oldb) Postenweg", lat: 53.1472, lon: 8.1901 },
    requestedDestination: { name: "Lappan Building Entrance",  lat: 53.1405, lon: 8.2140 },
    originLabel:      "Oldenburg(Oldb) Postenweg",
    destinationLabel: "Lappan Building Entrance"
  };

  const result = normalizeItinerary(itinerary, routeCoords);
  const walkLeg = result.legs.find(l => l.mode === "WALK");

  assert.ok(walkLeg, "expected a WALK leg");
  // The final walk leads to the actual requested destination
  assert.equal(walkLeg.to.name, "Lappan Building Entrance",
    "final WALK leg (after transit) must use requestedDestination as its 'to'");
  assert.equal(walkLeg.from.name, "Oldenburg(Oldb) Lappan",
    "final WALK leg must start at the last transit alighting stop");
  assert.match(walkLeg.mapsUrl, /origin=53\.1409,8\.2138&destination=53\.1405,8\.214/);
});

test("normalizeItinerary fixes both outer walks from neighboring transit endpoints", () => {
  const requestedOrigin = { name: "Origin Address", lat: 53.1, lon: 8.1 };
  const requestedDestination = { name: "Bürgerbüro Oldenburg", lat: 53.15, lon: 8.25 };
  const result = normalizeItinerary({
    legs: [
      { mode: "WALK", distance: 300, from: requestedDestination, to: requestedDestination },
      { mode: "BUS", from: { name: "Boarding Stop", lat: 53.11, lon: 8.11 }, to: { name: "Lappan", lat: 53.14, lon: 8.21 } },
      { mode: "WALK", distance: 450, from: requestedOrigin, to: requestedOrigin }
    ]
  }, { requestedOrigin, requestedDestination });

  const walks = result.legs.filter(leg => leg.mode === "WALK");
  assert.equal(walks[0].from.name, "Origin Address");
  assert.equal(walks[0].to.name, "Boarding Stop");
  assert.match(walks[0].mapsUrl, /origin=53\.1,8\.1&destination=53\.11,8\.11/);
  assert.equal(walks[1].from.name, "Lappan");
  assert.equal(walks[1].to.name, "Bürgerbüro Oldenburg");
  assert.match(walks[1].mapsUrl, /origin=53\.14,8\.21&destination=53\.15,8\.25/);
});

test("normalizeItinerary fixes transfer walk to adjacent transit stops", () => {
  const result = normalizeItinerary({
    legs: [
      { mode: "BUS", from: { name: "A", lat: 53.1, lon: 8.1 }, to: { name: "Transfer Alight", lat: 53.2, lon: 8.2 } },
      { mode: "WALK", distance: 200, from: { name: "Wrong From", lat: 1, lon: 1 }, to: { name: "Wrong To", lat: 2, lon: 2 } },
      { mode: "TRAIN", from: { name: "Transfer Board", lat: 53.21, lon: 8.22 }, to: { name: "B", lat: 53.3, lon: 8.3 } }
    ]
  }, {
    requestedOrigin: { name: "Origin", lat: 53, lon: 8 },
    requestedDestination: { name: "Destination", lat: 54, lon: 9 }
  });

  const walk = result.legs.find(leg => leg.mode === "WALK");
  assert.equal(walk.from.name, "Transfer Alight");
  assert.equal(walk.to.name, "Transfer Board");
  assert.match(walk.mapsUrl, /origin=53\.2,8\.2&destination=53\.21,8\.22/);
});

test("normalizeItinerary fixes a pure walking route to requested endpoints", () => {
  const result = normalizeItinerary({
    legs: [{ mode: "WALK", distance: 500, from: { name: "Wrong", lat: 1, lon: 1 }, to: { name: "Wrong", lat: 2, lon: 2 } }]
  }, {
    requestedOrigin: { name: "Origin", lat: 53.1, lon: 8.1 },
    requestedDestination: { name: "Destination", lat: 53.2, lon: 8.2 }
  });

  const walk = result.legs[0];
  assert.equal(walk.from.name, "Origin");
  assert.equal(walk.to.name, "Destination");
  assert.match(walk.mapsUrl, /origin=53\.1,8\.1&destination=53\.2,8\.2/);
});

test("nearby route is represented as walk-first with transit retained as an alternative", () => {
  const origin = { name: "Theaterwall 28, Oldenburg", lat: 53.1391, lon: 8.2098 };
  const destination = { name: "Oldenburg(Oldb) Pferdemarkt", lat: 53.146771, lon: 8.214682 };
  const transit = { legs: [{ mode: "BUS", route: "309" }], transfers: 0 };
  const result = buildWalkingRecommendationRoute({
    start: origin.name,
    destination: destination.name,
    time: "tomorrow 10:00 AM",
    timeMode: TIME_MODE.DEPART_AT
  }, origin, destination, { date: "06-23-2026", time: "10:00:00" }, {
    transitAlternatives: [transit]
  });

  assert.equal(result.type, "walk-first-route");
  assert.equal(result.recommendedMode, "WALK");
  assert.equal(result.walk.estimatedWalkMinutes, 12);
  assert.ok(result.walk.distanceMeters <= 960);
  assert.match(result.walk.mapsUrl, /origin=53\.1391,8\.2098&destination=53\.146771,8\.214682&travelmode=walking/);
  assert.equal(result.transitAlternative, transit);
  assert.equal(result.alternatives[0], transit);
});

test("explicit transit and walking-avoidance intent override walk-first in supported languages", () => {
  [
    "I want to take a bus",
    "public transport route",
    "I cannot walk much",
    "wheelchair route",
    "mit dem Bus",
    "لا أستطيع المشي",
    "सार्वजनिक परिवहन",
    "не можу ходити",
    "toplu taşıma"
  ].forEach(message => assert.equal(shouldPreferTransit(message), true, message));
  assert.equal(shouldPreferTransit("from Theaterwall 28 to uni campus haarentor"), false);
});

test("walk-first labels exist in every supported UI language", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.equal((html.match(/recommendedWalk:/g) || []).length, 6);
  assert.equal((html.match(/easiestShortTrip:/g) || []).length, 6);
  assert.equal((html.match(/walkingIsEasiest:/g) || []).length, 6);
  assert.equal((html.match(/aboutMinutes:/g) || []).length, 6);
  assert.equal((html.match(/aroundMeters:/g) || []).length, 6);
  assert.equal((html.match(/publicTransportOption:/g) || []).length, 6);
  assert.equal((html.match(/youCanAlsoTakePublicTransport:/g) || []).length, 6);
});

test("shared walkability decision is language-neutral for all supported languages", () => {
  const ordinaryRequests = {
    en: "i want to go to uni campus haarentor tomorrow at 10 am from damm 38",
    de: "Ich möchte morgen um 10 Uhr von Damm 38 zum Uni Campus Haarentor",
    ar: "أريد الذهاب إلى Uni Campus Haarentor غدًا الساعة 10 من Damm 38",
    hi: "मैं कल सुबह 10 बजे Damm 38 से Uni Campus Haarentor जाना चाहता हूँ",
    uk: "Я хочу завтра о 10 поїхати з Damm 38 до Uni Campus Haarentor",
    tr: "Yarın saat 10'da Damm 38'den Uni Campus Haarentor'a gitmek istiyorum"
  };

  for (const [selectedLanguage, rawText] of Object.entries(ordinaryRequests)) {
    assert.equal(detectTransitIntent(rawText, selectedLanguage).requested, false, selectedLanguage);
    assert.deepEqual(decideRecommendedMode({
      rawText,
      selectedLanguage,
      distanceMeters: 560,
      estimatedWalkMinutes: 7
    }).recommendedMode, "WALK", selectedLanguage);
  }
});

test("shared walkability decision honors explicit transit intent in all supported languages", () => {
  const transitRequests = {
    en: "i want to take a bus to uni campus haarentor from damm 38",
    de: "Ich möchte mit dem Bus von Damm 38 zum Uni Campus Haarentor fahren",
    ar: "أريد الذهاب بالحافلة من Damm 38 إلى Uni Campus Haarentor",
    hi: "मैं Damm 38 से Uni Campus Haarentor बस से जाना चाहता हूँ",
    uk: "Я хочу поїхати автобусом з Damm 38 до Uni Campus Haarentor",
    tr: "Damm 38'den Uni Campus Haarentor'a otobüsle gitmek istiyorum"
  };

  for (const [selectedLanguage, rawText] of Object.entries(transitRequests)) {
    assert.equal(detectTransitIntent(rawText, selectedLanguage).requested, true, selectedLanguage);
    const decision = decideRecommendedMode({ rawText, selectedLanguage, distanceMeters: 560, estimatedWalkMinutes: 7 });
    assert.equal(decision.recommendedMode, "TRANSIT", selectedLanguage);
    assert.equal(decision.reason, "user_requested_transit", selectedLanguage);
  }
});

test("campus aliases resolve to places rather than transit stops", () => {
  for (const query of ["uni campus haarentor", "uni campus harrentor", "campus haarrentor", "campus haarentor", "uni campus wechloy", "campus wechloy"]) {
    const place = resolveKnownPlace(query, { exactOnly: true });
    assert.ok(place, query);
    assert.equal(Boolean(place.stopId), false, query);
    assert.match(place.name, /Campus (?:Haarentor|Wechloy)/i, query);
  }
});

test("exact harrentor runtime input parses the campus and applies the shared threshold decision", () => {
  const rawText = "i want to go to uni campus harrentor from postenweg now";
  const parsed = extractTripDetails(rawText, "en");
  const origin = resolveKnownPlace(parsed.start, { exactOnly: true });
  const destination = resolveKnownPlace(parsed.destination, { exactOnly: true });
  const distanceMeters = Math.round(haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon));
  const estimatedWalkMinutes = Math.ceil(distanceMeters / 80);
  const decision = decideRecommendedMode({ rawText, selectedLanguage: "en", distanceMeters, estimatedWalkMinutes });

  assert.equal(parsed.start, "postenweg");
  assert.match(parsed.destination, /campus Haarentor/i);
  assert.equal(detectTransitIntent(rawText, "en").requested, false);
  assert.equal(distanceMeters, 1124);
  assert.equal(estimatedWalkMinutes, 15);
  assert.equal(decision.isWalkable, distanceMeters <= 900 || estimatedWalkMinutes <= 12);
  if (decision.isWalkable) assert.equal(decision.recommendedMode, "WALK");
});

// --- Security and external-service controls --------------------------------

test("session IDs are random UUIDs and malformed client IDs are replaced", () => {
  const first = getSession("");
  const second = getSession(undefined);
  assert.match(first.id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);

  const malformed = getSession("bad id with spaces <script>");
  assert.notEqual(malformed.id, "bad id with spaces <script>");
  assert.match(malformed.id, /^session-/);

  const oversized = getSession("a".repeat(500));
  assert.notEqual(oversized.id, "a".repeat(500));

  const wellFormed = getSession("client-session-123");
  assert.equal(wellFormed.id, "client-session-123");
  assert.equal(getSession("client-session-123").session, wellFormed.session);
});

test("session store evicts the least recently used session when full", () => {
  const oldest = getSession("lru-oldest-session");
  oldest.session.route.start = "marker";
  for (let index = 0; index < 1000; index += 1) getSession(`lru-filler-${index}`);
  assert.equal(getSession("lru-oldest-session").session.route.start, "", "oldest session should have been evicted");
});

test("API rate limit allows 60 requests per minute per client, then asks to retry", () => {
  const now = 1_000_000;
  for (let index = 0; index < 60; index += 1) {
    assert.equal(checkApiRateLimit("rate-test-client", now).limited, false);
  }
  const limited = checkApiRateLimit("rate-test-client", now + 1000);
  assert.equal(limited.limited, true);
  assert.equal(limited.retryAfterSeconds, 59);
  assert.equal(checkApiRateLimit("other-client", now + 1000).limited, false);
  assert.equal(checkApiRateLimit("rate-test-client", now + 60 * 1000).limited, false);
});

test("HTTP server returns 429 with Retry-After once a client exceeds the API limit", async () => {
  await new Promise(resolve => appServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
  try {
    const statuses = [];
    let lastResponse;
    for (let index = 0; index < 61; index += 1) {
      lastResponse = await fetch(`${baseUrl}/api/clear-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "rate-limit-http-test" })
      });
      statuses.push(lastResponse.status);
    }
    assert.ok(statuses.slice(0, 60).every(status => status === 200));
    assert.equal(statuses[60], 429);
    assert.ok(Number(lastResponse.headers.get("retry-after")) >= 1);
    assert.deepEqual(await lastResponse.json(), { error: "rate_limited" });
  } finally {
    await new Promise(resolve => appServer.close(resolve));
  }
});

test("route endpoint does not leak internal error messages", async () => {
  const server = http.createServer((req, res) => handleRouteRequest(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json"
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "route_handler_error" });
  } finally {
    console.error = originalError;
    await new Promise(resolve => server.close(resolve));
  }
});

test("identical geocoder requests are served from cache", async () => {
  const url = new URL(TEST_GEOCODER_URL);
  url.search = new URLSearchParams({ format: "jsonv2", q: "Damm 38 cache check", limit: "1" }).toString();
  const before = externalRequests.length;
  const first = await fetchGeocoderJson(url);
  const second = await fetchGeocoderJson(new URL(url));
  assert.equal(first.response.ok, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(externalRequests.length - before, 1);
});

test("index.html shows OpenStreetMap attribution for place search", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.match(html, /href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>© OpenStreetMap contributors</);
});

test("static routing serves index.html for GET / and keeps whitelist and traversal protection", async () => {
  await new Promise(resolve => appServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
  const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  try {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /^text\/html/);
    assert.equal(await root.text(), indexHtml);

    const rootWithQuery = await fetch(`${baseUrl}/?debug=1`);
    assert.equal(rootWithQuery.status, 200);

    const rootHead = await fetch(`${baseUrl}/`, { method: "HEAD" });
    assert.equal(rootHead.status, 200);

    const index = await fetch(`${baseUrl}/index.html`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), indexHtml);

    // Non-whitelisted and traversal paths must never be served.
    for (const blockedPath of [
      "/server.js",
      "/.env",
      "/.env.example",
      "/package.json",
      "/route-parser.test.js",
      "/../server.js",
      "/%2e%2e/server.js",
      "/..%2fserver.js",
      "/..%5cserver.js",
      "/%5c..%5cserver.js",
      "//server.js"
    ]) {
      const response = await fetch(`${baseUrl}${blockedPath}`);
      assert.ok([403, 404].includes(response.status), `${blockedPath} returned ${response.status}`);
      await response.arrayBuffer();
    }
  } finally {
    await new Promise(resolve => appServer.close(resolve));
  }
});
