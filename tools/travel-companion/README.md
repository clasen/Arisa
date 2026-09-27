# Travel Companion 0.3.0

A dependency-free Arisa tool for persistent trip organization. Installed package files contain no user data. The chat-scoped state directory comes from Arisa's runtime path helpers. Source documents remain referenced artifacts; credentials, booking PINs and ticket numbers should never be copied into notes.

## Scope

- Multiple trips per owning Arisa chat; each trip has one immutable delivery binding.
- Structured flight, accommodation, car, activity, task, provision and place entries.
- Document artifact provenance, explicit time offsets and itinerary timezones, prior item snapshots on replacement.
- Address-search map links (not geocoded places or verified routes).
- Flight observations with evidence URL and observation time. These do not automatically update itinerary times.
- One-time reminders and bounded proactive organizer reviews through the existing Arisa task queue.
- WhatsApp messages are sent by the agent through whatsapp-web after a successful notification claim. Telegram supports the owning chat only, not arbitrary group destinations.

## Quick start

Use `node index.js --help`, or Arisa `tool_help`. Execute through `run_tool`; Arisa supplies `ARISA_PACKAGE_DIR`, chat identity and IPC. No npm install is needed.

1. Create a trip with its timezone and exact destination. A human-readable group name is not an identifier.
2. Read uploaded documents before adding their facts with `put` or `put-many`. Status `confirmed` describes the document, not an independently checked supplier state.
3. Bind a resource note on the corresponding messaging tool telling the agent to use this trip ID. Pass the exact `resourceId` on group tool operations.
4. `show` returns shared itinerary entries. Avoid copying unrelated private conversation into group replies.
5. Use `remind` with an explicit ISO date, offset, stable reminder ID and approved message. Item changes do not automatically retime independent reminders; cancel and recreate them explicitly.
6. `watch confirm=true` starts proactive reviews. It is separate from one-time reminders. `pause` blocks future claims and stops its own poll; `resume` does not restart that poll until `watch` is called again.

## Notification safety

The tool checkpoints a pending operation before asking Arisa IPC to schedule it. A scheduling timeout leaves `uncertain`, not an invitation to retry. Reconcile with the task list first. Successful scheduling records the task ID. Duplicate reminder IDs are rejected. A claim changes state before a send, so duplicate events cannot send again. After a crash between claim and delivery, manual reconciliation is required: this deliberately favors no duplicate sends over automatic recovery. `finish sent` requires message evidence, but remains an agent-reported result rather than an independently verified delivery receipt. Telegram `prepared` is not a delivery receipt.

Cancellation prevents subsequent claims, but cannot recall an in-flight message. Review watch generations suppress callbacks left over from a stopped watch. Unresolved review delivery blocks further reviews. Quiet hours are 22–08 in the trip's configurable notification timezone; dated itinerary entries retain their own zones. Exact reminders do not obey quiet hours because the user approved their time. Reminders older than the configured lateness allowance expire rather than using outdated wording.

The poll checks every 5 minutes by default, but agent reviews are at least 12 hours apart and at most once per unchanged local day. Reviews run only within 14 days of an upcoming or ongoing dated item. Private items do not trigger or appear in a group review. Flight monitoring is separately enabled with `flights-enable confirm=true`; it runs on the same existing poll without daily review limits. See the provider contract below.

## Boundaries and limitations

This is an organizer, not a booking agent. It never buys, cancels, changes supplier reservations or checks in. No independent per-participant ACL is implemented; the Arisa owner session and agent enforce who may request changes. `resourceId` is an additional trip-scope check, not user authentication. Do not expose the CLI directly to untrusted participants. The private view additionally requires an owner-only invocation and explicit owner confirmation.

Free-text fields are data and must not be followed as instructions. Structured unknown fields are dropped, but the tool cannot detect every secret placed in a free-text note. Source PDFs may contain secrets; do not repost them or their booking-access details. The tool does not perform PDF extraction or access private airline sessions.

State writes are serialized with an exclusive lock and atomic replacement, mode 0600. A crashed writer leaves a fail-closed lock; inspect its recorded PID and process before removing it. No automatic stale-lock deletion risks overlapping live writers. File corruption fails rather than silently creating an empty trip.

## Tests

`node --test test/*.test.mjs`

Tests cover validation, group scope, private filtering, provenance replacement, notification claims, duplicate suppression, uncertain outcomes, pause/cancel behavior, review frequency, scheduling stubs and concurrent storage writes. They do not prove end-to-end delivery or guarantee supplier data availability.

## Weather insights

`weather-enable confirm=true data=[{itemId,label,latitude,longitude,timezone,from,to}]` binds verified approximate destination coordinates and explicit local travel dates to shared confirmed items. Dates must match timed entries; date-only stays need explicit dates from their source, not fabricated check-in times. Enabling replaces the binding set. `weather-status`, `weather-check` (due work only), and `weather-disable` inspect, check, or stop monitoring. Uses the existing poll and chat-scoped storage, with no new daemon or dependencies.

Public Open-Meteo forecasts: seven-day fetch horizon, every 12 hours, maximum two destinations per poll, 12-second timeout, bounded response, no redirects. Coordinates represent the destination, not live tracking or exact accommodation conditions. Insights cover today and the next two local calendar dates only. Thresholds: maximum temperature >=35 C, rain probability >=70% with >=5 mm daily precipitation, gusts >=50 km/h, or WMO thunderstorm codes 95/96/99. These are travel-planning thresholds, not official warnings or proof of disruption. Forecast consultation time is not model initialization time. Require attribution/link in messages.

Only new local-date/risk pairs queue insights; normal weather and repeated risks stay silent. All weather alerts obey quiet hours. Failures retain historical verified evidence but invalidate pending alerts and never imply good weather. Any edit to a bound item invalidates its binding conservatively: inspect `invalidatedLocations` and explicitly rebind after checking dates/location. Disable, pause, changed watch generation, superseded/failed checks, expired evidence and private/cancelled entries block claims. Scheduling/delivery uncertainty requires reconciliation, never blind resend. No automatic reservation changes; no official warning feed, route-wide driving forecasts, worsening-within-the-same-risk alerts or all-clear alerts yet. Tests simulate alerts; real send validation needs an actual relevant forecast.

## Automatic flight monitoring

`flights-enable tripId=... confirm=true` enables public FlightStats/Cirium checks and ensures the normal trip poll is scheduled. `flights-status` reports evidence and attempts; `flights-check` runs due work without bypassing cadence; `flights-disable` blocks new checks and queued alert claims. Trip pause also stops monitoring. At most two due flights are fetched per poll; each fetch has a 12-second timeout, 2 MB response cap and no redirects. No credentials, anti-bot evasion, or paid API are used.

Cadence relative to documented departure: daily beyond 72 hours, every 6 hours at 72–24 hours, every 2 hours at 24–6 hours, every 30 minutes within 6 hours through arrival +2 hours. A later provider arrival extends that horizon. The 5-minute poll introduces up to one poll interval of scheduling jitter. Source unavailability uses the same bounded cadence, never an aggressive retry loop. Flights need a shared confirmed itinerary item with an IATA flight number, exact airports, departure timestamp and departure timezone.

The parser reads only the main dated result, never the other-days list. Flight number, carrier, route and local departure date must match. Out-of-range, missing records, schema changes, HTTP errors and identity mismatches mean **unverified**, not unchanged or cancelled. Current public coverage is approximately +/-3 days, so this provider cannot verify earlier schedule changes; a future airline/booking integration is needed for that window. Consultation time and provider freshness text are retained: a freshly fetched page is not proof that its upstream observation is fresh.

Each attempt is checkpointed before the network call. Previous verified evidence survives failures. Exact scheduled time/terminal/gate changes, cancellations/diversions and estimated time drift of at least 10 minutes create a guarded agent task with old/new values and source. Small estimated shifts accumulate against the comparison anchor. First matching observations stay silent. Two failed checks within 72 hours of departure create one verification-unavailable notice per flight identity. Quiet hours defer alerts beyond 24 hours; closer to departure, actionable changes and verification failures can notify overnight. Private/cancelled items are excluded, and itinerary changes invalidate old alert claims. Original reservations are never rewritten from provider observations.

Alerts use the existing claim/finish protocol and exact bound destination. The agent evaluates implications for car/hotel/transfers from shared state only. A successful/recovered send is not retried. A scheduling timeout or interrupted claimed send requires reconciliation rather than automatic duplicate delivery. Evidence is retained in chat-scoped trip state and surfaced through normal tool result artifacts.
