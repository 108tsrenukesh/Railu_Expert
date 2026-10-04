import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"

const BASE = "https://api.railradar.in/v1"
const TIMEOUT_MS = 20000
const CHUNK_DAYS = 14
const MAX_DAYS = 60

const STATION_RE = /^[A-Za-z]{2,6}$/
const TRAIN_RE = /^\d{4,5}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CLASSES = ["1A", "2A", "3A", "3E", "CC", "EC", "EA", "FC", "SL", "2S", "VS", "CH", "SH", "VC", "EV"]
const QUOTAS = ["GN", "TQ", "PT", "LD", "DF", "FT", "SS", "YU", "DP", "HP", "PH"]

let cachedKey: string | null | undefined

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

function apiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey
  const fromEnv = (process.env.RAILRADAR_API_KEY || "").trim()
  if (fromEnv) {
    cachedKey = fromEnv
    return cachedKey
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('RAILRADAR_API_KEY','User')"],
        { encoding: "utf8", timeout: 15000 },
      )
      const v = (out || "").trim()
      if (v) {
        cachedKey = v
        return cachedKey
      }
    } catch {
      /* fall through */
    }
  }
  cachedKey = null
  return null
}

// Short-lived in-memory cache: RailRadar free tier is 1,000 calls/month and the
// advisory often re-requests the same read (e.g. probe + alternatives both check
// the same baseline). Successful GET/POST reads are reused for 10 minutes.
const CACHE_TTL_MS = 10 * 60 * 1000
const apiCache = new Map<string, { at: number; body: any }>()

function cacheKey(path: string, init?: RequestInit): string {
  const m = (init?.method || "GET").toUpperCase()
  const b = typeof init?.body === "string" ? init.body : ""
  return `${m} ${path} ${b}`
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const k = apiKey()
  if (!k) {
    throw new Error(
      "RAILRADAR_API_KEY is not set. Set it as a Windows user env var and restart opencode: " +
        '[Environment]::SetEnvironmentVariable("RAILRADAR_API_KEY","rr_live_XXXX","User")',
    )
  }
  const ck = cacheKey(path, init)
  const hit = apiCache.get(ck)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body
  let lastErr = "unknown"
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response
    try {
      res = await fetch(BASE + path, {
        ...init,
        headers: { Authorization: `Bearer ${k}`, ...(init?.headers || {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      lastErr = `network/timeout: ${errText(e)}`
      continue
    }
    if (res.status === 401) throw new Error("RailRadar 401 Unauthorized — RAILRADAR_API_KEY is missing or invalid.")
    if (res.status === 429)
      throw new Error("RailRadar 429 — free-tier quota exhausted (1,000 requests/month). Wait for next month or upgrade the plan.")
    if (res.status === 404) throw new Error(`RailRadar 404 — no data for this train/station/date: ${path}`)
    if (!res.ok) {
      lastErr = `HTTP ${res.status}`
      continue
    }
    const body = await res.json().catch(() => null)
    if (body && body.success === false) throw new Error(body?.error?.message || "RailRadar returned success=false")
    if (apiCache.size > 200) apiCache.clear()
    apiCache.set(ck, { at: Date.now(), body })
    return body
  }
  throw new Error(`RailRadar request failed after retry (${lastErr})`)
}

function normStation(s: string): string {
  const v = (s || "").trim().toUpperCase()
  if (!STATION_RE.test(v)) throw new Error(`Invalid station code "${s}" — expected 2-6 letters, e.g. NDLS, MMCT.`)
  return v
}

function parseDate(s: string): Date {
  if (!DATE_RE.test(s)) throw new Error(`Invalid date "${s}" — expected YYYY-MM-DD.`)
  const d = new Date(`${s}T00:00:00Z`)
  if (isNaN(d.getTime())) throw new Error(`Invalid date "${s}".`)
  return d
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000)
}

function todayIST(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)
}

function fmtDur(min?: number | null): string {
  if (typeof min !== "number" || isNaN(min)) return "?"
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`
}

async function diagnose(train: string, from: string, to: string, cls: string, startStr: string): Promise<string> {
  try {
    const b = await api(`/trains/${train}`)
    const t = b?.data?.train
    const route: string[] = (b?.data?.route || []).map((r: any) => r?.station?.code).filter(Boolean)
    const avail: string[] = t?.availableClasses || t?.classes || []
    const notes: string[] = []
    if (avail.length && !avail.includes(cls)) notes.push(`class ${cls} is not offered on this train (it offers ${avail.join(", ")})`)
    if (route.length) {
      const iFrom = route.indexOf(from)
      const iTo = route.indexOf(to)
      if (iFrom < 0) notes.push(`${from} is not on this train's route`)
      else if (iTo < 0) notes.push(`${to} is not on this train's route`)
      else if (iFrom >= iTo) notes.push(`${from} comes after ${to} on this train's route`)
    }
    const arpEnd = fmtDate(addDays(parseDate(todayIST()), MAX_DAYS))
    if (startStr > arpEnd) notes.push(`start date ${startStr} is beyond the ${MAX_DAYS}-day booking window (earliest ${todayIST()}, latest ${arpEnd})`)
    if (t?.isPrsBookable === false) notes.push("this train is not PRS-bookable (unreserved/special)")
    if (notes.length) return `Likely cause: ${notes.join("; ")}.`
    return `Train ${train} (${t?.name ?? "?"}) and class ${cls} look valid — the date is likely beyond the booking window, or upstream has no data for it.`
  } catch (e) {
    return `Could not fetch train details for diagnosis: ${errText(e)}`
  }
}

export const seats = tool({
  description:
    "Scan Indian Railways seat availability across the 60-day advance reservation window (ARP) for one train/class/quota. " +
    "Returns a date-by-date table of AVAILABLE / RAC / WAITLIST status. " +
    "Use this whenever the user asks whether seats can be booked on some future date range, which dates in the booking window are free, " +
    "or to pick the best travel date. Read-only — it never books anything.",
  args: {
    train: tool.schema.string().describe("5-digit train number, e.g. 12952"),
    from: tool.schema.string().describe("Boarding station code, e.g. NDLS"),
    to: tool.schema.string().describe("Destination station code, e.g. MMCT"),
    travel_class: tool.schema
      .string()
      .optional()
      .describe("Coach class: 1A, 2A, 3A, 3E, SL, CC, EC, 2S etc. Default 3A"),
    start_date: tool.schema
      .string()
      .optional()
      .describe("Window start YYYY-MM-DD. Default today (IST)."),
    days: tool.schema
      .number()
      .optional()
      .describe("How many days from start_date to scan, 1-60. Default 60 (full booking window)."),
    quota: tool.schema
      .string()
      .optional()
      .describe("Quota: GN (general), TQ (tatkal), PT (premium tatkal), LD (ladies), SS (senior). Default GN"),
  },
  execute: async (args) => (await computeSeats(args)).text,
})

async function computeSeats(args: any): Promise<{ text: string; calls: number }> {
  const train = (args.train || "").trim()
    if (!TRAIN_RE.test(train)) throw new Error(`Invalid train number "${args.train}" — expected 4-5 digits, e.g. 12952.`)
    const from = normStation(args.from)
    const to = normStation(args.to)
    const cls = (args.travel_class || "3A").trim().toUpperCase()
    if (!CLASSES.includes(cls)) throw new Error(`Invalid class "${args.travel_class}" — use one of: ${CLASSES.join(", ")}.`)
    const quota = (args.quota || "GN").trim().toUpperCase()
    if (!QUOTAS.includes(quota)) throw new Error(`Invalid quota "${args.quota}" — use one of: ${QUOTAS.join(", ")}.`)

    const startStr = (args.start_date || "").trim() || todayIST()
    const start = parseDate(startStr)
    const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(args.days ?? MAX_DAYS)))
    const endStr = fmtDate(addDays(start, days)) // exclusive

    const rows = new Map<string, any>()
    const failures: string[] = []
    let trainName = ""
    let calls = 0

    for (let off = 0; off < days; off += CHUNK_DAYS) {
      const w = fmtDate(addDays(start, off))
      try {
        const body = await api(
          `/trains/${train}/seats?journeyDate=${w}&source=${from}&destination=${to}&classCode=${cls}&quotaCode=${quota}`,
        )
        calls++
        const d = body?.data
        if (d?.trainName) trainName = d.trainName
        for (const e of d?.calendar || []) {
          const dt = e?.rawDate || e?.date
          if (typeof dt !== "string") continue
          if (dt < startStr || dt >= endStr) continue
          rows.set(dt, e)
        }
      } catch (e) {
        failures.push(`${w}: ${errText(e)}`)
      }
    }

    if (rows.size === 0 && failures.length > 0) {
      const has404 = failures.some((f) => f.includes("404"))
      const hint = has404 ? await diagnose(train, from, to, cls, startStr) : "No 404 involved — see the errors below."
      throw new Error(`All seat calls failed for ${train} ${from}→${to} class ${cls}.\n${hint}\n${failures.join("\n")}`)
    }

    const sorted = [...rows.values()].sort((a, b) =>
      String(a.rawDate || a.date).localeCompare(String(b.rawDate || b.date)),
    )

    let av = 0
    let rac = 0
    let wl = 0
    let other = 0
    const lines: string[] = []
    lines.push(
      `SEATS ${train}${trainName ? ` ${trainName}` : ""} | ${from}→${to} | ${cls} ${quota} | ` +
        `${startStr} → ${fmtDate(addDays(start, days - 1))} (${days}d, ${calls} API call${calls === 1 ? "" : "s"})`,
    )
    lines.push("")
    for (const e of sorted) {
      lines.push(`${String(e.rawDate || e.date).padEnd(11)} ${String(e.status ?? "").trim()}`)
      if (e.statusCode === "AVAILABLE") av++
      else if (e.statusCode === "RAC") rac++
      else if (e.statusCode === "WAITLIST") wl++
      else other++
    }
    lines.push("")
    lines.push(`Summary: ${sorted.length} date${sorted.length === 1 ? "" : "s"} | AVAILABLE ${av} | RAC ${rac} | WAITLIST ${wl}${other ? ` | other ${other}` : ""}`)
    const best = sorted.filter((e) => e.statusCode === "AVAILABLE")
    if (best.length) {
      lines.push(
        `Bookable now: ${best
          .slice(0, 8)
          .map((e) => `${e.rawDate || e.date}(${e.availableSeats} seats)`)
          .join(", ")}${best.length > 8 ? ", …" : ""}`,
      )
    }
    if (sorted.length === 0)
      lines.push("No dates returned — the train may not run in this window, or the date is beyond the 60-day ARP.")
    if (failures.length) lines.push(`Partial failures: ${failures.join(" ; ")}`)
  lines.push("Source: RailRadar (PRS snapshot). Always confirm on irctc.co.in before booking — this tool never books.")
  return { text: lines.join("\n"), calls }
}

export const journey_plan = tool({
  description:
    "Plan an Indian Railways journey across 2-6 stops, including indirect/connecting routes when no direct train exists or direct seats are full. " +
    "Returns direct trains and connecting itineraries per leg with departure/arrival times, durations and live delay reliability. " +
    "Use this when the user wants a route combination, a connecting-train option, or a multi-city rail itinerary.",
  args: {
    stops: tool.schema
      .string()
      .describe("Comma-separated station codes in order, 2-6 of them, e.g. NDLS,BPL,MMCT"),
    date: tool.schema.string().optional().describe("Departure date from the first stop, YYYY-MM-DD. Default today."),
    max_transfers: tool.schema
      .number()
      .optional()
      .describe("Maximum transfers per leg, 0-3. Default 1."),
  },
  async execute(args) {
    const raw = String(args.stops || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase())
    if (raw.length < 2 || raw.length > 6) throw new Error("stops: give 2-6 station codes separated by commas, e.g. NDLS,BPL,MMCT")
    raw.forEach(normStation)
    const date = (args.date || "").trim() || undefined
    if (date) parseDate(date)
    const maxTransfers = Math.min(3, Math.max(0, Math.floor(args.max_transfers ?? 1)))

    const stops = raw.map((s, i) => (i === 0 && date ? { station: s, date } : { station: s }))
    const body = await api(`/journeys/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stops, maxTransfers }),
    })

    const data = body?.data || {}
    const segs = data.segments || []
    const lines: string[] = []
    lines.push(`JOURNEY ${raw.join(" → ")}${date ? ` from ${date}` : ""} | maxTransfers=${maxTransfers}`)
    if (!segs.length) lines.push("No route found for these stops.")
    for (const seg of segs) {
      const fCode = typeof seg.from === "string" ? seg.from : seg.from?.code || seg.plan?.from?.code || "?"
      const tCode = typeof seg.to === "string" ? seg.to : seg.to?.code || seg.plan?.to?.code || "?"
      lines.push("")
      lines.push(`${fCode} → ${tCode}  ${seg.date ?? seg.plan?.date ?? ""}`)
      const direct = seg.plan?.direct || []
      const its = seg.plan?.itineraries || []
      if (!direct.length && !its.length) lines.push("  (no train found on this leg)")
      for (const t of direct) {
        const delay = t.delayKnown && typeof t.expectedDelayMinutes === "number" ? ` | delay ~${t.expectedDelayMinutes}m` : ""
        const rel = t.reliability ? ` | reliability ${t.reliability}` : ""
        const cls = Array.isArray(t.train?.classes) && t.train.classes.length ? ` | ${t.train.classes.join("/")}` : ""
        lines.push(
          `  DIRECT ${t.train?.number ?? "?"} ${t.train?.name ?? ""}${cls} | dep ${t.from?.departure ?? "?"} → arr ${t.to?.arrival ?? "?"}` +
            ` | ${fmtDur(t.durationMinutes)}${delay}${rel}`,
        )
      }
      for (const it of its) lines.push(renderItinerary(it))
    }
    const s = data.summary
    if (s) {
      lines.push("")
      lines.push(
        `Summary: depart ${s.departDate ?? "?"} → arrive ${s.arriveDate ?? "?"} | total ${fmtDur(s.totalMinutes)}` +
          (typeof s.stayNights === "number" ? ` | ${s.stayNights} night${s.stayNights === 1 ? "" : "s"} en route` : ""),
      )
    }
    lines.push("Source: RailRadar. Confirm trains and seats on irctc.co.in before booking.")
    return lines.join("\n")
  },
})

function renderItinerary(it: any): string {
  if (it && typeof it === "object") {
    const trains = it.trains || it.trainOptions || it.options || it.legs
    if (Array.isArray(trains)) {
      const parts = trains.map((t: any) => `${t?.number ?? t?.train?.number ?? "?"} ${t?.name ?? t?.train?.name ?? ""}`.trim())
      const extra = typeof it.transferMinutes === "number" ? ` (transfer ${fmtDur(it.transferMinutes)})` : ""
      const dur = typeof it.totalDurationMinutes === "number" ? ` | total ${fmtDur(it.totalDurationMinutes)}` : ""
      const risk = it.overallRisk ? ` | risk ${it.overallRisk}` : ""
      const conn =
        typeof it.transfers?.[0]?.connectionProbability === "number"
          ? ` | conn ${it.transfers[0].connectionProbability}% at ${it.transfers[0]?.station?.code ?? "?"}`
          : ""
      const star = it.recommended ? " | RECOMMENDED" : ""
      return `  VIA ${parts.join(" → ")}${extra}${dur}${risk}${conn}${star}`
    }
    return `  VIA ${JSON.stringify(it).slice(0, 600)}`
  }
  return `  VIA ${String(it)}`
}

export const trains_between = tool({
  description:
    "List trains running directly between two Indian Railway stations on an optional date, with departure/arrival times, duration, running days and optional live delay status. " +
    "Use as the first step for any origin→destination query, before checking seats with railradar_seats.",
  args: {
    from: tool.schema.string().describe("Source station code, e.g. NDLS"),
    to: tool.schema.string().describe("Destination station code, e.g. MMCT"),
    date: tool.schema.string().optional().describe("Filter trains running on this date, YYYY-MM-DD. Default: all."),
    by_city: tool.schema
      .boolean()
      .optional()
      .describe("If true, include all stations of both metropolitan areas. Default false."),
    live: tool.schema.boolean().optional().describe("If true, include live departure/delay status. Default false."),
  },
  async execute(args) {
    const from = normStation(args.from)
    const to = normStation(args.to)
    const date = (args.date || "").trim() || undefined
    if (date) parseDate(date)
    const q = new URLSearchParams()
    if (date) q.set("date", date)
    q.set("byCity", String(args.by_city ?? false))
    q.set("live", String(args.live ?? false))

    const body = await api(`/trains/between/${from}/${to}?${q.toString()}`)
    const d = body?.data || {}
    const list = d.trains || []
    const lines: string[] = []
    lines.push(`TRAINS ${from} → ${to}${date ? ` on ${date}` : ""} | ${list.length} found`)
    if (!list.length) lines.push("No direct trains found between these stations.")
    const LIMIT = 40
    for (const t of list.slice(0, LIMIT)) {
      const dep = `${t.from?.departure ?? "?"}${t.from?.day > 1 ? `(+${t.from.day - 1}d)` : ""}`
      const arr = `${t.to?.arrival ?? "?"}${t.to?.day > 1 ? `(+${t.to.day - 1}d)` : ""}`
      const days = Array.isArray(t.train?.runDays)
        ? t.train.runDays.map((d: any) => String(d).slice(0, 3).toUpperCase()).join(",")
        : ""
      let live = ""
      if (t.live) {
        const dm = typeof t.live.delayMinutes === "number" ? `${t.live.delayMinutes}m delay` : ""
        const pf = t.live.platform ? ` PF ${t.live.platform}` : ""
        live = ` | live: ${dm}${pf}`
      }
      lines.push(`${String(t.train?.number ?? "?").padEnd(6)} ${String(t.train?.name ?? "").padEnd(34).slice(0, 34)} dep ${dep} → arr ${arr} | ${fmtDur(t.duration)} | ${days}${live}`)
    }
    if (list.length > LIMIT) lines.push(`…and ${list.length - LIMIT} more (narrow with a date).`)
    lines.push("Source: RailRadar (NTES timetable). Cross-check on irctc.co.in before booking.")
    return lines.join("\n")
  },
})

const CLASS_PREF = ["3A", "2A", "SL", "3E", "CC", "EC", "1A", "2S"]
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

function pickClass(avail: string[], want?: string): string {
  const list = (avail || []).filter((c) => CLASSES.includes(c))
  if (want) return want
  for (const c of CLASS_PREF) if (list.includes(c)) return c
  return list[0] || ""
}

function toMin(t?: string | null, day?: number | null): number | null {
  if (!t || !/^\d{1,2}:\d{2}$/.test(String(t))) return null
  const [h, m] = String(t).split(":").map(Number)
  return ((day ?? 1) - 1) * 1440 + h * 60 + m
}

function deltaStr(a: number | null, b: number | null): string {
  if (a == null || b == null) return ""
  const d = a - b
  if (d === 0) return ""
  return `, user's ${d < 0 ? "boarding" : "arrival"} ${Math.abs(d)} min ${d < 0 ? "earlier" : "later"}`
}

function confInfo(e: any, journeyDate: string): { label: string; score: number } {
  const daysLeft = Math.round((parseDate(journeyDate).getTime() - parseDate(todayIST()).getTime()) / 86400000)
  const nearChart = daysLeft <= 1
  const sc = String(e?.status ?? "").trim()
  if (e?.statusCode === "AVAILABLE") {
    const n = typeof e.availableSeats === "number" ? e.availableSeats : null
    const scarce = n != null && n < 10 ? " — scarce, book immediately" : ""
    return { label: `CONFIRMED (${n ?? "?"} seats)${scarce}`, score: 1000 + Math.min(n ?? 0, 99) }
  }
  if (e?.statusCode === "RAC") {
    const n = typeof e.waitlistNumber === "number" ? e.waitlistNumber : 99
    return {
      label: `${sc} — will travel; full berth odds scale with RAC number${nearChart ? " (chart imminent)" : ""}`,
      score: 700 - Math.min(n, 99),
    }
  }
  if (e?.statusCode === "WAITLIST") {
    const n = typeof e.waitlistNumber === "number" ? e.waitlistNumber : 99
    const type = String(e.waitlistType || "WL")
    const isGn = type === "GNWL"
    let odds: string
    if (nearChart) odds = "LOW now — chart likely prepared; only cancellations/VACANCY can clear it"
    else if (isGn && n <= 10) odds = "GOOD odds (GNWL has top priority and moves steadily before chart)"
    else if (n <= 10) odds = "MODERATE odds (RLWL/PQWL moves slower than GNWL)"
    else if (n <= 30) odds = "UNCERTAIN odds"
    else odds = "LOW odds"
    return { label: `${sc} — ${odds}`, score: 400 - Math.min(n, 99) + (isGn ? 60 : 0) }
  }
  return { label: `${sc || "no data"} — not a bookable status`, score: 0 }
}

type AltOption = {
  trainNo: string
  trainName: string
  src: string
  dst: string
  note: string
  score: number
  label: string
  checked: boolean
}

export const alternatives = tool({
  description:
    "Holistic ticket-confirmation advisor: for an origin→destination pair it finds direct trains, then generates alternative booking strategies " +
    "(book from the train's origin, board one halt earlier, book to the train's terminus — the tricks that often convert waitlists into confirmed tickets) " +
    "and checks actual availability for each, ranking options by confirmation odds using GNWL/RLWL/PQWL, RAC and chart-timing rules. " +
    "Costs up to 1 + trains + checks API calls (of the 1,000/month free quota). Read-only — never books.",
  args: {
    from: tool.schema.string().describe("Boarding station code, e.g. NGP"),
    to: tool.schema.string().describe("Destination station code, e.g. HWH"),
    date: tool.schema.string().optional().describe("Travel date YYYY-MM-DD (must be within the 60-day window). Default today."),
    travel_class: tool.schema.string().optional().describe("Preferred class (3A, SL, CC...). Default: first class the train offers."),
    max_trains: tool.schema.number().optional().describe("Direct trains to detail, 1-6. Default 3."),
    max_checks: tool.schema.number().optional().describe("Total availability checks to spend, 1-12. Default 8."),
  },
  execute: async (args) => (await computeAlternatives(args)).lines.join("\n"),
})

async function computeAlternatives(
  args: any,
): Promise<{ lines: string[]; options: AltOption[]; calls: number }> {
  const from = normStation(args.from)
  const to = normStation(args.to)
  const date = (args.date || "").trim() || todayIST()
    parseDate(date)
    const today = todayIST()
    if (date < today) throw new Error(`date ${date} is in the past (today IST ${today}).`)
    const arpEnd = fmtDate(addDays(parseDate(today), MAX_DAYS))
    if (date > arpEnd) throw new Error(`date ${date} is beyond the ${MAX_DAYS}-day booking window (latest ${arpEnd}).`)
    const wantCls = args.travel_class ? (args.travel_class || "").trim().toUpperCase() : undefined
    if (wantCls && !CLASSES.includes(wantCls)) throw new Error(`Invalid class "${wantCls}" — use one of: ${CLASSES.join(", ")}.`)
    const maxTrains = Math.min(6, Math.max(1, Math.floor(args.max_trains ?? 3)))
    const maxChecks = Math.min(12, Math.max(1, Math.floor(args.max_checks ?? 8)))
    const wd = WD[parseDate(date).getUTCDay()]
    let calls = 0

    const bt = await api(`/trains/between/${from}/${to}?date=${date}&byCity=false&live=false`)
    calls++
    const cand: any[] = bt?.data?.trains || []
    if (!cand.length) {
      const msg =
        `ALTERNATIVES ${from} → ${to} on ${date}: no direct train runs between these stations (${calls} API call).\n` +
        "Next step: use railradar_journey_plan with 2-6 stops (pick a major junction between them) to build a connecting itinerary, " +
        "then check seats on each leg with railradar_seats."
      return { lines: [msg], options: [], calls }
    }
    cand.sort((a, b) => {
      const ra = (a.train?.runDays || []).includes(wd) ? 0 : 1
      const rb = (b.train?.runDays || []).includes(wd) ? 0 : 1
      if (ra !== rb) return ra - rb
      return (a.duration ?? 1e9) - (b.duration ?? 1e9)
    })

    const lines: string[] = []
    lines.push(`ALTERNATIVES ${from} → ${to} on ${date} (${wd.toUpperCase()}) | ${cand.length} direct trains found`)
    lines.push("")

    const options: AltOption[] = []
    const seen = new Set<string>()
    const push = (trainNo: string, trainName: string, src: string, dst: string, note: string) => {
      const key = `${trainNo}|${src}|${dst}`
      if (seen.has(key)) return
      if (src === from && dst === to && options.length > 0) return
      seen.add(key)
      options.push({ trainNo, trainName, src, dst, note, score: -1, label: "", checked: false })
    }

    let detailed = 0
    const details: any[] = []
    for (const c of cand.slice(0, maxTrains)) {
      let d: any
      try {
        d = await api(`/trains/${c.train?.number}`)
        calls++
      } catch (e) {
        lines.push(`  (could not detail train ${c.train?.number}: ${errText(e)})`)
        continue
      }
      detailed++
      details.push(d)
      const t = d?.data?.train
      const name = t?.name || c.train?.name || ""
      const halts: any[] = (d?.data?.route || []).filter((r: any) => r?.isHalt && r?.station?.code)
      const iF = halts.findIndex((h) => h.station.code === from)
      const iT = halts.findIndex((h) => h.station.code === to)
      if (iF < 0 || iT < 0 || iF >= iT) continue
      const o = halts[0], dstH = halts[halts.length - 1]
      const daysOk = (t?.runDays || []).includes(wd)
      const runsNote = daysOk ? "" : ` [does NOT run on ${wd.toUpperCase()} — kept for reference]`

      // V0 baseline
      push(t.number, name, from, to, `baseline${runsNote}`)
      // V1 book from train origin (same ride, full-route quota)
      if (o.station.code !== from)
        push(t.number, name, o.station.code, to, `same ride — ticket from origin ${o.station.code} pools the whole train's quota; board at ${from} as planned${runsNote}`)
      // V3 full-route ticket
      if (o.station.code !== from && dstH.station.code !== to)
        push(t.number, name, o.station.code, dstH.station.code, `same ride — full-route ticket ${o.station.code}→${dstH.station.code} (max availability); board ${from}, alight ${to}${runsNote}`)
      // V2 book to terminus
      if (dstH.station.code !== to)
        push(t.number, name, from, dstH.station.code, `book to terminus ${dstH.station.code} (often more seats); get down at ${to} as planned${runsNote}`)
      // V4 board one halt earlier (different quota pool, actual ride change)
      if (iF > 0) {
        const p = halts[iF - 1]
        const extraKm = Math.round((halts[iF].distance ?? 0) - (p.distance ?? 0))
        const dlt = deltaStr(toMin(p.departure, p.departureDay), toMin(halts[iF].departure, halts[iF].departureDay))
        push(t.number, name, p.station.code, to, `board ${extraKm}km earlier at ${p.station.code} (different quota pool)${dlt}${runsNote}`)
      }
      // V5 alight one halt later
      if (iT < halts.length - 1) {
        const n = halts[iT + 1]
        const extraKm = Math.round((n.distance ?? 0) - (halts[iT].distance ?? 0))
        const dlt = deltaStr(toMin(n.arrival, n.arrivalDay), toMin(halts[iT].arrival, halts[iT].arrivalDay))
        push(t.number, name, from, n.station.code, `alight ${extraKm}km later at ${n.station.code} (different quota pool)${dlt}${runsNote}`)
      }
    }
    if (!options.length) {
      lines.push("No usable options — trains do not serve these stations in sequence.")
      lines.push(`(${calls} API calls) Source: RailRadar. Confirm on irctc.co.in.`)
      return { lines, options, calls }
    }

    // priority: baselines first (no commitment cost), then origin-booking, then ride changes
    const rank = (o: AltOption): number =>
      o.src === from && o.dst === to ? 0 : o.note.startsWith("same ride") ? 1 : 2
    options.sort((a, b) => rank(a) - rank(b))

    const checkQueue = options
      .filter((o) => {
        if (!wantCls) return true
        const dt = details.find((x) => x?.data?.train?.number === o.trainNo)
        const av: string[] = dt?.data?.train?.availableClasses || dt?.data?.train?.classes || []
        return av.includes(wantCls)
      })
      .slice(0, maxChecks)
    for (const o of checkQueue) {
      const t = details.find((d) => d?.data?.train?.number === o.trainNo)
      const avail: string[] = t?.data?.train?.availableClasses || t?.data?.train?.classes || []
      const cls = pickClass(avail, wantCls)
      if (!cls) {
        o.checked = false
        o.label = "no matching class found on this train"
        continue
      }
      try {
        const b = await api(
          `/trains/${o.trainNo}/seats?journeyDate=${date}&source=${o.src}&destination=${o.dst}&classCode=${cls}&quotaCode=GN`,
        )
        calls++
        const entry = (b?.data?.calendar || []).find((e: any) => (e.rawDate || e.date) === date)
        if (!entry) {
          o.checked = true
          o.label = `no calendar entry for ${date}`
          o.score = 0
        } else {
          const info = confInfo(entry, date)
          o.checked = true
          o.score = info.score
          o.label = `${cls} | ${info.label}`
        }
      } catch (e) {
        o.checked = true
        o.score = -1000
        o.label = `check failed: ${errText(e)}`
      }
    }

    options.sort((a, b) => b.score - a.score)
    lines.push(`Ranked options (availability actually checked for top ${checkQueue.length}, ${calls} API calls used):`)
    let rankN = 0
    for (const o of options) {
      rankN++
      const head = o.checked && o.score >= 0 ? `${rankN}. ` : " - "
      lines.push(`${head}[${o.trainNo}] ${o.src}→${o.dst}  ${o.label || "unchecked"}`)
      lines.push(`      ${o.note}`)
      if (rankN >= 10) {
        const rest = options.length - 10
        if (rest > 0) lines.push(` …and ${rest} more variants (raise max_checks or max_trains).`)
        break
      }
    }
    lines.push("")
    lines.push(
      "Rules applied: GNWL (booked near origin) converts faster than RLWL/PQWL; origin/long-route bookings tap the train's full quota pool; " +
        `charts are prepared ~4-8h before departure — after that only cancellations/VACANCY help; booking window is ${MAX_DAYS} days.`,
    )
    lines.push(
      "Next: confirm the exact date/class/quota on irctc.co.in before paying, and check recent news for the corridor (fog, floods, blockades, strikes) — " +
        "if direct options are all waitlisted, use railradar_journey_plan for a connecting route via a major junction.",
    )
  lines.push("Source: RailRadar (PRS snapshot). This tool never books anything.")
  return { lines, options, calls }
}

function verdictTier(score: number): string {
  if (score >= 1010) return "CONFIRMED"
  if (score >= 1000) return "CONFIRMED (scarce — book fast)"
  if (score >= 601) return "RAC-level (travel likely, berth probable)"
  if (score >= 301) return "WAITLIST risk on the tightest leg"
  if (score >= 0) return "unknown"
  return "check failed"
}

export const advisory = tool({
  description:
    "Adaptive end-to-end journey advisor — the main entry point for trip questions. Starts cheap for easy queries (~4-6 API calls) and escalates by itself only when needed: " +
    "boarding/quota strategies (book-from-origin, board-earlier tricks), 60-day window scans, connecting itineraries with per-leg availability, transfer risk and " +
    "confirmation-probability scoring (GNWL/RLWL/PQWL, RAC, chart timing). " +
    "depth: auto (default, escalates only if seats are tight or no direct train) | simple (quick probe only) | standard | deep (everything). Read-only — it never books.",
  args: {
    from: tool.schema.string().describe("Origin station code, e.g. NGP"),
    to: tool.schema.string().describe("Destination station code, e.g. HWH"),
    date: tool.schema.string().optional().describe("Travel date YYYY-MM-DD within the 60-day window. Default today."),
    travel_class: tool.schema.string().optional().describe("Preferred class (3A, SL, CC, EC...). Default: whatever the train offers."),
    depth: tool.schema.string().optional().describe("auto | simple | standard | deep. Default auto."),
    max_checks: tool.schema.number().optional().describe("Availability-check budget for standard/deep stages, 1-12. Default 8."),
  },
  async execute(args) {
    const from = normStation(args.from)
    const to = normStation(args.to)
    const date = (args.date || "").trim() || todayIST()
    parseDate(date)
    const today = todayIST()
    if (date < today) throw new Error(`date ${date} is in the past (today IST ${today}).`)
    const arpEnd = fmtDate(addDays(parseDate(today), MAX_DAYS))
    if (date > arpEnd) throw new Error(`date ${date} is beyond the ${MAX_DAYS}-day booking window (earliest ${today}, latest ${arpEnd}).`)
    const wantCls = args.travel_class ? (args.travel_class || "").trim().toUpperCase() : undefined
    if (wantCls && !CLASSES.includes(wantCls)) throw new Error(`Invalid class "${wantCls}" — use one of: ${CLASSES.join(", ")}.`)
    const depthReq = String(args.depth || "auto").toLowerCase()
    if (!["auto", "simple", "standard", "deep"].includes(depthReq)) throw new Error("depth must be one of: auto, simple, standard, deep")
    const budgetChecks = Math.min(12, Math.max(1, Math.floor(args.max_checks ?? 8)))
    const wd = WD[parseDate(date).getUTCDay()]
    let calls = 0
    const out: string[] = []
    const verdicts: string[] = []
    let mode = depthReq

    async function planConnections(legBudget: number): Promise<void> {
      let plan: any
      try {
        plan = await api(`/journeys/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stops: [{ station: from, date }, { station: to }],
            maxTransfers: depthReq === "deep" ? 2 : 1,
          }),
        })
        calls++
      } catch (e) {
        out.push(`Connection planning failed: ${errText(e)}`)
        return
      }
      const seg = plan?.data?.segments?.[0]
      const its: any[] = (seg?.plan?.itineraries || [])
        .slice()
        .sort((a: any, b: any) => (a.totalDurationMinutes ?? 1e9) - (b.totalDurationMinutes ?? 1e9))
      if (!its.length) {
        out.push("No connecting itinerary found either.")
        return
      }
      out.push("")
      out.push(`== ${its.length} CONNECTING ITINERARIES (top 3, legs checked within budget) ==`)
      type Scored = { it: any; worst: number; unchecked: number; legLines: string[] }
      const scored: Scored[] = []
      let budget = legBudget
      for (const it of its.slice(0, 3)) {
        const legs: any[] = it.legs || []
        const legLines: string[] = []
        let worst = 10000
        let unchecked = 0
        for (const leg of legs) {
          const cls = pickClass(leg.train?.classes || [], wantCls)
          const pair = `${leg.train?.number ?? "?"} ${leg.from?.code ?? "?"}→${leg.to?.code ?? "?"} ${cls || "no-class"}`
          if (budget <= 0 || !cls) {
            unchecked++
            legLines.push(`  ${pair}: unchecked`)
            continue
          }
          try {
            const b = await api(
              `/trains/${leg.train.number}/seats?journeyDate=${leg.from.date}&source=${leg.from.code}&destination=${leg.to.code}&classCode=${cls}&quotaCode=GN`,
            )
            calls++
            budget--
            const e = (b?.data?.calendar || []).find((x: any) => (x.rawDate || x.date) === leg.from.date)
            const info = e ? confInfo(e, leg.from.date) : { label: `no data for ${leg.from.date}`, score: 0 }
            worst = Math.min(worst, info.score)
            legLines.push(`  ${pair}: ${info.label}`)
          } catch (err) {
            worst = Math.min(worst, -1000)
            legLines.push(`  ${pair}: check failed (${errText(err)})`)
          }
        }
        scored.push({ it, worst, unchecked, legLines })
      }
      scored.sort((a, b) => {
        const av = a.worst === 10000 ? -1e9 : a.worst
        const bv = b.worst === 10000 ? -1e9 : b.worst
        return bv - av
      })
      let n = 0
      for (const sc of scored) {
        const it = sc.it
        const parts = (it.legs || []).map((l: any) => `${l.train?.number} ${l.from?.code}→${l.to?.code}`)
        const tr0 = it.transfers?.[0]
        const risk = it.overallRisk ? ` | transfer risk ${it.overallRisk}` : ""
        const conn = typeof tr0?.connectionProbability === "number" ? ` | conn ${tr0.connectionProbability}% at ${tr0?.station?.code ?? "?"}` : ""
        const tier = sc.worst === 10000 ? "unchecked" : verdictTier(sc.worst) + (sc.unchecked ? ` + ${sc.unchecked} leg(s) unchecked` : "")
        out.push(`${++n}. VIA ${parts.join(" + ")} | total ${fmtDur(it.totalDurationMinutes)}${risk}${conn} | ${tier}`)
        out.push(...sc.legLines)
        verdicts.push(`VIA ${parts.join(" + ")} — ${tier}${conn ? ` | connection ${tr0.connectionProbability}% (${it.overallRisk})` : ""}`)
        if (n >= 3) break
      }
    }

    // ---------- STAGE 1: direct trains ----------
    const bt = await api(`/trains/between/${from}/${to}?date=${date}&byCity=false&live=false`)
    calls++
    const cand: any[] = bt?.data?.trains || []

    if (!cand.length) {
      mode = depthReq === "simple" ? "simple (connections preview)" : depthReq === "auto" ? "auto→connections (no direct train)" : `${depthReq} (connections)`
      out.push(`No direct train runs ${from} → ${to} — building connecting itineraries.`)
      await planConnections(depthReq === "simple" ? 0 : budgetChecks)
    } else {
      const running = cand.filter((t: any) => (t.train?.runDays || []).includes(wd))
      const pool = (running.length ? running : cand)
        .slice()
        .sort((a: any, b: any) => (a.duration ?? 1e9) - (b.duration ?? 1e9))
      out.push(
        `Direct trains ${from} → ${to} on ${date} (${wd.toUpperCase()}): ` +
          `${running.length ? `${running.length} running` : "NONE run this weekday"} of ${cand.length} total. Fastest first:`,
      )
      for (const t of pool.slice(0, 6)) {
        const dep = `${t.from?.departure ?? "?"}${t.from?.day > 1 ? `(+${t.from.day - 1}d)` : ""}`
        const arr = `${t.to?.arrival ?? "?"}${t.to?.day > 1 ? `(+${t.to.day - 1}d)` : ""}`
        const days = Array.isArray(t.train?.runDays)
          ? t.train.runDays.map((d: any) => String(d).slice(0, 3).toUpperCase()).join(",")
          : ""
        out.push(
          `  ${String(t.train?.number ?? "?").padEnd(6)} ${String(t.train?.name ?? "").slice(0, 36).padEnd(36)} ` +
            `dep ${dep} → arr ${arr} | ${fmtDur(t.duration)} | ${days}`,
        )
      }

      // ---------- STAGE 2: probe best direct trains ----------
      const probeN = depthReq === "deep" ? 1 : 2
      const probes: { no: string; name: string; cls: string; label: string; score: number }[] = []
      const skippedTrains: string[] = []
      for (const c of pool.slice(0, probeN)) {
        let d: any
        try {
          d = await api(`/trains/${c.train?.number}`)
          calls++
        } catch {
          continue
        }
        const tr = d?.data?.train
        const availList: string[] = (tr?.availableClasses || tr?.classes || []).filter((x: string) => CLASSES.includes(x))
        if (wantCls && !availList.includes(wantCls)) {
          skippedTrains.push(`[${tr?.number ?? c.train?.number}] skipped — offers ${availList.join("/")} (no ${wantCls})`)
          continue
        }
        const cls = pickClass(availList, wantCls)
        if (!cls) continue
        try {
          const b = await api(
            `/trains/${tr.number}/seats?journeyDate=${date}&source=${from}&destination=${to}&classCode=${cls}&quotaCode=GN`,
          )
          calls++
          const e = (b?.data?.calendar || []).find((x: any) => (x.rawDate || x.date) === date)
          if (!e) probes.push({ no: tr.number, name: tr.name, cls, label: `no calendar entry for ${date}`, score: 0 })
          else {
            const i = confInfo(e, date)
            probes.push({ no: tr.number, name: tr.name, cls, label: i.label, score: i.score })
          }
        } catch (err) {
          probes.push({ no: tr.number, name: tr.name, cls, label: `probe failed: ${errText(err)}`, score: -1000 })
        }
      }
      out.push("")
      out.push("Probe (fastest direct trains, actual availability today):")
      for (const p of probes) out.push(`  [${p.no}] ${p.cls} — ${p.label}`)
      for (const s of skippedTrains) out.push(`  ${s}`)

      const best = probes.length ? Math.max(...probes.map((p) => p.score)) : -1000
      const easy = best >= 1010
      const goodProbes = [...probes]
        .sort((a, b) => b.score - a.score)
        .filter((p) => p.score >= 0)
      for (const p of goodProbes.slice(0, 2))
        verdicts.push(`[${p.no}] direct ${from}→${to} ${p.cls} — ${p.label}`)
      if (!goodProbes.length) verdicts.push("no valid probe result — see errors/notes above")

      let escalate = false
      if (depthReq === "auto") {
        escalate = !easy
        mode = easy ? "auto (easy query — resolved with probes)" : "auto→standard (seats tight)"
      } else if (depthReq === "standard" || depthReq === "deep") escalate = true

      if (escalate) {
        out.push("")
        out.push("== BOARDING / QUOTA STRATEGIES (actual checks) ==")
        const alt = await computeAlternatives({
          from,
          to,
          date,
          travel_class: wantCls,
          max_trains: depthReq === "deep" ? 4 : 3,
          max_checks: budgetChecks,
        })
        calls += alt.calls
        out.push(...alt.lines)
        const altVerdicts: string[] = []
        let n = 0
        for (const o of [...alt.options].sort((a, b) => b.score - a.score)) {
          if (!o.checked || o.score < 0) continue
          altVerdicts.push(`[${o.trainNo}] ${o.src}→${o.dst} — ${o.label}${o.note ? ` | ${o.note}` : ""}`)
          if (++n >= 4) break
        }
        if (altVerdicts.length) {
          verdicts.length = 0
          verdicts.push(...altVerdicts)
        }

        if (depthReq === "deep") {
          const top = [...alt.options].filter((o) => o.checked && o.score >= 0).sort((a, b) => b.score - a.score)[0]
          const scanCls = top?.label.match(/^([A-Z0-9]{2}) \|/)?.[1] || wantCls
          if (top && scanCls) {
            const daysLeft = Math.round((parseDate(arpEnd).getTime() - parseDate(date).getTime()) / 86400000) + 1
            out.push("")
            out.push(`== ${daysLeft}-DAY WINDOW ON BEST OPTION [${top.trainNo}] ${top.src}→${top.dst} ${scanCls} ==`)
            try {
              const s = await computeSeats({
                train: top.trainNo,
                from: top.src,
                to: top.dst,
                travel_class: scanCls,
                start_date: date,
                days: Math.max(1, Math.min(MAX_DAYS, daysLeft)),
                quota: "GN",
              })
              calls += s.calls
              out.push(s.text)
            } catch (e) {
              out.push(`window scan failed: ${errText(e)}`)
            }
          }
          out.push("")
          out.push("== CONNECTION BACKUP (if every direct option is waitlisted) ==")
          await planConnections(6)
        }
        if (depthReq === "auto" && !altVerdicts.length) {
          out.push("")
          out.push("(No direct option checked out — run again with depth=deep for connecting itineraries and a full window scan.)")
        }
      } else if (depthReq === "simple" && !easy) {
        out.push("")
        out.push("Seats look tight for a cheap probe — re-run with depth=standard (boarding strategies) or depth=deep (full analysis).")
      }
    }

    // ---------- VERDICT + FOOTER ----------
    out.push("")
    out.push("== VERDICT (best first) ==")
    if (verdicts.length) verdicts.forEach((v, i) => out.push(`${i + 1}. ${v}`))
    else out.push("No reliable verdict — see the sections above.")
    out.push("")
    out.push(
      "Rules applied: 60-day ARP; GNWL (booked near origin) confirms faster than RLWL/PQWL; charts are prepared ~4-8h before departure " +
        "(after that only cancellations/VACANCY help); Tatkal (TQ) opens 10:00 AC / 11:00 non-AC one day before travel; " +
        "ladies/senior quotas can be easier (railradar_seats quota=LD/SS).",
    )
    out.push(
      "Before paying: re-check the exact date/class/quota and the fare on irctc.co.in (flexi/dynamic fares vary by train and demand; this tool never books). " +
        'For disruptions run a web search like "<corridor> train news today / flood / fog / strike / blockade" and check the train\'s last-week running history.',
    )
    out.push(`Depth used: ${mode} | ${calls} RailRadar API calls this run (free tier 1,000/month).`)
    return out.join("\n")
  },
})
