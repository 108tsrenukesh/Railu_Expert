# Rules

## Indian Railways queries

### Tool inventory
- **`railradar_advisory`** — main entry point for any trip question. Adaptive: probes cheaply first (~5 API calls), escalates itself to boarding/quota strategies, 60-day scans and connecting itineraries only when seats are tight or no direct train exists. `depth`: `auto` (default) | `simple` | `standard` | `deep`.
- **`railradar_seats`** — 60-day ARP availability scan for one train/class/quota.
- **`railradar_alternatives`** — boarding/quota strategies only (book-from-origin, board-earlier, alight-later tricks) ranked by confirmation odds.
- **`railradar_journey_plan`** / **`railradar_trains_between`** — itineraries with transfer risk/connection probability; timetable lookups.
- **`indian-rail` MCP** (official NTES/IRCTC sources): live status, schedules, station board, chart vacancy, PNR.
- **`brightdata` MCP** (optional, needs `BRIGHTDATA_API_TOKEN`): `search_engine_batch` for multi-query corridor news, `scrape_as_markdown` / `scrape_batch` to read the hits. Fallback: built-in websearch/webfetch.

### Routing
1. **"Can I get from A to B / will tickets confirm / best route"** → `railradar_advisory` with default `depth=auto`. Do not hand-roll the stages unless the user asks for a specific one.
2. **Explicit full analysis, "check everything", money on the line** → `depth=deep`.
3. **Trivial lookups** (train number, one date, live status) → the single matching tool (`railradar_trains_between`, `railradar_seats` with small `days`, or `indian-rail`); do not spend advisory depth on simple questions.
4. **Date-range availability** → `railradar_seats` with the full window (`days` up to 60), report bookable vs RAC vs waitlisted per date.
5. **No direct train** → `railradar_journey_plan` with 2-6 stops (major junctions) before saying "no option"; the advisory does this automatically.
6. **Live status / delay / platform / coach position / PNR** → `indian-rail` first (reads NTES).
7. **News & disruptions (mandatory before recommending a long booking)** → run 1-2 web searches: `"<corridor> train news today"`, plus `flood / fog / strike / blockade / accident / rally` for the route and the train's last-week running history. Use Bright Data `search_engine_batch` (then `scrape_as_markdown` on the hits) when available, else built-in websearch. Summarize impact on the recommended option.
8. **Tatkal/special quotas** → `railradar_seats` with `quota=TQ/PT`; note TQ opens 10:00 (AC) / 11:00 (non-AC) one day before travel.
9. **Degraded mode (RailRadar 429 / quota exhausted)** → `indian-rail` has no monthly quota (NTES/IRCTC direct). Fall back to it: `searchTrainBetweenStations` for options, `getSeatAvailability` for vacancy (meaningful only after chart preparation, ~4h before departure), `trackTrain` for live running. Tell the user full-window scans and confirmation scoring resume after the RailRadar reset; do not retry RailRadar in a loop.
10. **Session-start rules sync (once per day, not per question)** — railway rules change (ARP, tatkal, charting, refunds, zone-specific orders). On the day's first railway question: call `railradar_rules` with `action=get`. If **missing/stale**: run 2-4 web searches (Bright Data `search_engine_batch` when available, else built-in websearch) covering booking-window/ARP rules, tatkal timings, chart-preparation rules, refund/cancellation rules, plus zone-specific orders for the journey's zones — then store the compact digest (rules + sources + effective dates) with `action=save`. Reuse that digest all day. `railradar_advisory` prints which sync its verdict used.

### Interpretation rules (confirmation probability)
- Order of difficulty: **AVAILABLE > RAC > GNWL > RLWL > PQWL**; waitlist number lower = better; more days before chart = better.
- Charts prepare ~4-8h before departure; after that only cancellations/VACANCY clear lists.
- Booking window (ARP) is 60 days; advisory/seat tools enforce it.
- Transfer risk and `connectionProbability` come from `railradar_journey_plan` — surface them for multi-leg trips.

### Safety & budget (non-negotiable)
1. **Accuracy** — RailRadar/PRS data is a snapshot. Before the user spends money, tell them to confirm the exact date/class/quota on irctc.co.in. Never present tool numbers as guaranteed.
2. **Read-only** — no tool books, cancels or modifies anything. Never claim a ticket was booked; the user books on IRCTC themselves. Dial 139 for official enquiries.
3. **Rate limits** — RailRadar free tier 1,000 requests/month (one 60-day scan = 5 calls); Bright Data 5,000/month when configured. Advisory reports calls used. Never loop scans needlessly; respect the reported call counts.
4. **Secrets** — `RAILRADAR_API_KEY` and `BRIGHTDATA_API_TOKEN` live only in environment variables. Never print, log, echo or commit them.
5. Rail data is best-effort, never for safety-critical decisions.
6. **PNR privacy** — `checkPnrStatus` returns passenger personal data (names, age, berth). Look up one PNR at a time; never log, store, share or enumerate PNRs.
7. **No bulk extraction** — per-trip queries only. Never systematically download timetables, station catalogues or seat data into a database; respect call budgets and caches. NTES data is for personal, non-commercial use (see NTES disclaimer); keep `indian-rail` on local stdio, never route PNR/chart queries through hosted proxies.
8. **Bright Data scope** — public news and articles only (corridor disruptions for a planned trip). Never point it at login-walled, government or booking sites (IRCTC/NTES), and never at ticket purchasing or automation of any kind.

### Adoption gate (before adding any third-party tool, service or data source)
Every suggestion must pass all five checks — safe, stable, complete, rule-following — or it is rejected regardless of how attractive its features look:
1. **Rules first** — read its Terms of Service / Acceptable Use Policy and the terms of whatever it scrapes or calls. Reject if it scrapes login-walled, government or booking sites, automates ticket purchase, or resells proxied data against the provider's policy.
2. **Safe** — official or licensed sources preferred over third-party scrapes; PNR/personal data must stay local (stdio) with no logging or storage; no credential-sharing designs.
3. **Stable** — evidence of reliability (maintained, tested, typed errors, timeouts/retries) and honest signals (stars, users, success rates). Fragile positional parsing of third-party markup fails this bar.
4. **Complete** — it must fill a gap our stack genuinely lacks; overlapping features alone are not a reason to add a dependency.
5. **Free for a usual user** — must fit inside free tiers (RailRadar 1K/mo, Bright Data 5K/mo, keyless local tools). Reject anything pay-per-use or account-gated beyond a free key.
Record the decision and reasons generically (what class of tool was evaluated, what we improved) without naming specific third-party projects.
