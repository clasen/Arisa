# Travel Companion 0.3.1

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

## Document coverage preflight

Before answering from a guide or asking for missing details:

1. Read the entire available text, including continuation pages. Preserve the extracted text as a chat artifact. If extraction is incomplete, record `partial`, not `complete`.
2. Inventory embedded resources with short non-sensitive labels (for example `entrance`). Finding a video URL means `detected`, not `reviewed`. Inspect only media relevant to the current question; failed access means `blocked`.
3. Use `document-review tripId=... itemId=... data={"textStatus":"complete","textEvidenceArtifactId":"<artifact UUID>","topics":["parking"],"resources":[{"id":"entrance","kind":"video","status":"detected"}]}`. The item's `sourceArtifactId` must exist. Partial/complete text requires an evidence artifact; reviewed resources require `evidenceArtifactId`. All referenced artifacts are checked in the owning chat. Full replacement, not a merge.
4. Run `document-check` with relevant `topics` and/or `resources`. Reuse facts already in the guide. An unread/partial text, missing topic, or unreviewed requested resource yields `ready=false` with explicit gaps. Only ask about details absent from fully read text. If relevant media cannot be reviewed, disclose that limitation rather than inventing details.

This is agent-reported coverage metadata, not independent verification of reading, media content, supplier status, or arbitrary outgoing replies. It does not read documents or play videos itself. Shared views and claimed reviews include the preflight instructions, including for older queued review prompts. Ordinary answers require the agent to invoke the preflight; transport does not enforce it.

Store labels and artifact references only: no raw guide text, personalized URLs, Wi-Fi passwords, door codes or booking credentials in review metadata. Existing state needs no migration and defaults to unread. Source replacement invalidates coverage; status changes with the same source retain it. Private reviews are excluded from shared views and group operations.

Acceptance experiment for the next five documents (no automatic schedule): count avoidable follow-up questions and user corrections about claimed reading/viewing; compare with the observed guide incident. Include partial extraction, a detected but unseen video, blocked media and replacement sources. Do not mark historical guides or videos reviewed without fresh evidence.

## Mandatory activity proposal gate

Activity proposals must use `recommendation-check` then `recommendation-send`, never a direct messaging call. Checks fetch fresh Open-Meteo data for the supplied place and explicit local date, even when automatic risk alerts are silent or disabled. They require shared itinerary items and existing chat-scoped logistical and coordinate evidence artifacts. Missing data, provider errors, stale coverage or incorrect units fail closed. Successful checks expire after two hours and become invalid if the item changes.

Outdoor planning is blocked at rain probability >=50%, precipitation >=2 mm, gusts >=35 km/h, maximum temperature >=35 C, or thunderstorms. These conservative daily planning thresholds are not official warnings. Research an indoor alternative instead of sending an unverified conditional outdoor suggestion. Indoor plans also require weather evidence; their opening hours, age restrictions and access still need research.

Outdoor checks additionally request `uv_index_max` for the exact local date (dimensionless unit). Missing, null, negative, nonnumeric or nonfinite UV values block outdoor delivery, including legacy ready checks without UV evidence. Indoor checks and automatic weather alerts retain their existing requirements. Outdoor messages always include the forecast daily maximum UV index: low <3, moderate <6, high <8, very high <11, extreme >=11. From UV 3 they include broad-spectrum SPF 30+ sunscreen, reapplication every two hours and after getting wet or sweating, clothing/hat/shade and avoiding midday sun. This is a daily maximum forecast, not a measurement at the planned activity time; UV alone does not block an outdoor plan.

The send action appends the measured forecast, uses only the bound WhatsApp destination, checkpoints before sending and retains the returned receipt. A failure or ambiguous result is uncertain; sending/sent/uncertain attempts block repeats for the same item and date, including after a new check. Reconcile manually. No automatic retry is implemented. No live send is needed for unit testing.

Scope: this is a hard gate inside recommendation-send, not a transport-wide firewall. Other tools can still send messages; queued-review and claim instructions explicitly prohibit bypassing this path. Artifact existence does not independently establish truthful coordinates, complete logistical research or message relevance. The gate does not claim those guarantees.

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

Each attempt is checkpointed before the network call. Previous verified evidence survives failures. Scheduled time changes, gate changes, cancellations/diversions and departure time drift of at least 10 minutes create a guarded agent task with old/new values and source. Terminal changes require the same new value in two consecutive verified polls at every airport, without airport-specific exceptions. A missing value, failed check, or return to the comparison baseline resets confirmation. Gate, cancellation and diversion alerts do not wait for terminal confirmation. Raw observations are retained separately from the confirmed comparison baseline. Arrival estimates create alerts only for delays of at least 30 minutes with at least 30 minutes of movement from the comparison anchor, or recovery from that delay to at most 15 minutes late. Early/on-time arrival estimate oscillations stay silent. The first provider-labelled Actual arrival creates one alert even when the timestamp matches the estimate; subsequent actual-time corrections require 30 minutes. Small estimated shifts accumulate against the comparison anchor. These thresholds control notification noise, not airline status or guarantees. First matching observations stay silent. Two failed checks within 72 hours of departure create one verification-unavailable notice per flight identity. Quiet hours defer alerts beyond 24 hours; closer to departure, actionable changes and verification failures can notify overnight. Private/cancelled items are excluded, and itinerary changes invalidate old alert claims. Original reservations are never rewritten from provider observations.

Alerts use the existing claim/finish protocol and exact bound destination. The agent evaluates implications for car/hotel/transfers from shared state only. A successful/recovered send is not retried. A scheduling timeout or interrupted claimed send requires reconciliation rather than automatic duplicate delivery. Evidence is retained in chat-scoped trip state and surfaced through normal tool result artifacts.

