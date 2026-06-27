# Daddy Poring — Member Dashboard & Party Builder

A Next.js web app for managing guild member rosters and building 5-man parties
via drag-and-drop.

**Daddy and Mummy are two SEPARATE guilds** — their members and their parties
are entirely independent and are never shown together. The app displays exactly
**one guild at a time**, with a **Daddy ⇄ Mummy toggle** (defaults to Daddy).

## Navigation

A shared **top nav** (`TopNav`) appears on all three pages with three items —
**Party Setup** (`/`), **Raid Setup** (`/raids`), **Member Dashboard**
(`/members`) — plus the right-aligned **Daddy ⇄ Mummy toggle**. Every nav link
carries `?guild=${guild}`, so switching pages keeps the current guild; the
active page is highlighted. `active` is passed as a prop by each page shell (no
client hooks) so it's SSR-safe / hydration-clean. The toggle stays on the
current page.

## Layout

A full-width, full-height two-pane builder (no centered container):

- **Left — member panel** (~300px, sticky, scrollable): the selected guild's
  member pool as compact draggable cards (name + class pill + **⚡power**). The
  power comes from the web-owned `memberMeta` (joined in by the page; ⚡0 when
  unrated). No MAIN/SUB badge — the builder is already per-guild.
- **Right — vertically-scrollable board** (`overflow-y-auto`, no zoom/pan, no
  horizontal scroll): each guild has a **FIXED, pre-created field structure**
  laid out in a deterministic grid (5 cards per row). You scroll down through:
  - **Main Field — 12 parties** (top)
  - a clear visual divider
  - **Sub Field — 18 parties** (bottom)

  There is **no "+ Add New Party"** button and no card repositioning — the
  structure is fixed. Both fields pull from the selected guild's own member pool.

Each **party card** (dark blue/purple neon) has a header (name + member count),
5 slots, and per-slot controls. A filled slot shows the member's name, class
pill, **⚡power**, a **lock** toggle, and an **X** remove button. Empty slots
show a "drop here" placeholder.

**Drag & drop / swap:**
- Drag a member from the pool or a slot onto an **empty** slot → they **join**
  that party (5-slot cap respected; full parties reject an empty-slot join).
- Drag a member **A** onto an **occupied** unlocked slot holding **B** →
  **A and B swap**: A takes B's slot (in B's party), B takes A's source slot —
  or returns to the **pool** if A came from the pool. A swap is net-zero on
  party sizes, so it **works even when the target party is full**. Both affected
  parties auto-save.
- Drop a member back onto the **pool** → removed from its party.
- **Locks:** a **locked slot is fixed** — it can't be a move/swap *target* (its
  member can't be displaced), and a **locked member can't be dragged** (it's not
  draggable). Unlock first to switch a locked member.

**Every slot change auto-saves** — assignments, swaps, locks, and renames
persist immediately (no manual save button).

### Roster auto-fill toolbar

A toolbar above the field grid has three buttons, all scoped to the
**currently-viewed guild** (both its Main + Sub fields). Randomness lives in the
server actions, so there is no hydration concern.

- **Generate** — auto-assigns the unlocked slots, **two-tier and power-aware**.
  Locked slots are frozen (locked members + locked Priests count toward their
  party from the start). It builds the available pool (active, unlocked members)
  and fills:
  1. **Priest hard rule (power-based, Main-first):** each priestless party gets
     a Priest sorted by power DESC, **Main parties first, then Sub** — so the
     strongest non-locked Priests anchor Main. A locked Priest counts as present
     (not reassigned). Parties left without one get a **"⚠ No Priest"** badge.
  2. **Tier partition (Main = elite, Sub = the rest):** the remaining members
     are ranked by power DESC; the top ones fill **Main** (up to Main's free-slot
     capacity), the rest go to **Sub**. Net effect: Main's pool outpowers Sub's.
  3. **Per-field balance:** within Main's 12 parties (and separately within Sub's
     18) — a ~1-Tank pass then a **largest-into-smallest-bin** balance fill from
     that field's tier pool, so each tier is internally even (not stacked into
     party 1). **Main is never balanced against Sub** — Main is intentionally
     stronger.
  Power comes from `memberMeta` (default 0 unrated). **Randomness applies only to
  ties** (equal-power members shuffle), so the power-priority ordering is
  otherwise deterministic — reruns are similar by design (Main consistently gets
  the best), differing only among equal-power members. Generate uses **ACTIVE
  members only**; no member in two parties; 5-slot cap respected.
- **Reset** — clears only the **unlocked** slots (members return to the pool);
  locked members stay pinned; locks unchanged. (Confirm prompt.)
- **Reset Lock** — clears **everything** for the guild: all assignments **and**
  all locks → a blank board. (Confirm prompt; destructive.)

The role mapping is the `CLASS_ROLE` constant in `src/lib/types.ts` (easy to
edit): **Tank** = Knight; **Healer** = Priest; **DPS** = Assassin, Hunter,
Gunslinger, Blacksmith, Wizard, Druid. A member with an unknown/null `className`
is generic DPS/flex and never counts as a Priest.

### Raid Groups page (`/raids`)

The layer **above** parties: **Members → Parties → Raid Groups**. Reached via
the shared top nav (**Raid Setup**). Per-guild scoping, plain vertical scroll
(no zoom/pan).

For each of **Main Field** and **Sub Field** (stacked, separated by a divider):
- An **Unassigned** pool of that field's parties not yet in any raid group —
  each a draggable **party chip** (name + member count + ⚠ if it has members but
  no Priest, via `partyHasPriest`).
- The field's raid groups, each a drop container. Drag a party chip into a raid
  group, between raid groups, or back to the pool to unassign. A party is in
  **at most one** raid group within its field; **Main raid groups hold only Main
  parties, Sub only Sub** — never cross fields.
- **"+ Add Raid Group"** per field (manual; none are pre-created). Each raid
  group has an editable name and a **delete** button (confirm-gated); deleting
  frees its parties back to the pool (parties + members untouched).

All raid-group changes auto-save immediately (optimistic UI, no save button).

### Members page (`/members`)

A dark analytics-style member management dashboard — **two-pane**, like the
builder. Reached via the shared top nav (**Member Dashboard**). All stats are
**real data** for the selected guild (no fabricated attendance).

**LEFT — member list** (scrollable, ~320px): every member (active + departed)
as a compact card (avatar/initial, displayName, class, ⚡power). Departed members
are greyed + marked "Left". A **search box** (by name/class) and a **sort
control** sit above the list:
- Sort options: **Name A→Z** (default), **Name Z→A**, **Power high→low**,
  **Power low→high**. The default is a single deterministic order applied
  identically on the server + first client render (hydration-safe); changing it
  re-sorts client-side only. Power sorts break ties by name; name sorts break
  ties by userId (stable/deterministic).
Clicking a member opens the **detail + Power Rating modal** (all fields: userId,
username, displayName, class, classRoleId, guild, status, lastSeen) — power is a
non-negative integer (default 0), saved to `memberMeta` via `setMemberPower`.

**RIGHT — analytics dashboard** (scrollable), all real, current-guild data
(active members for stats unless noted):
- **Roster-health stat cards:** Active, Departed, Avg Power (active, unrated=0),
  **Priest coverage** (# Priests vs party count, flagged amber if short),
  Assigned / Bench (in a party vs not, from `parties`), Rated / Unrated
  (power>0 vs =0).
- **Per-class table:** one row per class (the 8 + an "Unknown/none" row) with
  count, avg, min, max, median power, and unrated count; the role column uses
  `CLASS_ROLE` (Tank/Healer/DPS).
- **Charts:** members-per-class bar, average-power-per-class bar, power
  histogram (buckets 0 / 1–25 / 26–50 / 51–75 / 76–100 / 100+), and a role-split
  (Tank/Healer/DPS) stacked bar.
- **Lists:** Top 10 by power, and "Needs rating" (active members with power 0).
- An **"Attendance — coming soon"** placeholder (voice-chat tracking is a later
  phase) — no fabricated numbers.

**Charts are plain CSS/SVG** with deterministic widths/heights derived from the
data — **no charting library, no DOM measurement** — so they SSR identically to
the first client render (zero hydration mismatch; no mounted guard needed).

Guild membership maps to the bot's member flags:

- **Daddy** guild = members where `isMain === true`, parties where `type === 'daddy'`
- **Mummy** guild = members where `isSub === true`, parties where `type === 'mummy'`

## Architecture

- **Next.js** (App Router, React, TypeScript, Tailwind).
- No separate API service. The app reads the roster and reads/writes party
  layouts **directly from MongoDB** via server components and server actions.
  The Mongo connection string is read **server-side only** and never reaches the
  browser.
- **Drag-and-drop** uses [`@dnd-kit`](https://dndkit.com/)
  (`@dnd-kit/core` + `@dnd-kit/sortable`).
- **Plain scrollable board (no zoom/pan):** the board is a normal
  `overflow-y-auto` container of plain DOM, so it **SSRs normally** with no
  hydration mismatch (no client-only guard needed). dnd-kit collision uses
  `getBoundingClientRect()` for droppable slots; `MeasuringStrategy.Always`
  re-measures during the drag so slots scrolled into view mid-drag still
  register. The `DragOverlay` renders in screen space and tracks the cursor 1:1.
- **Fixed field structure + idempotent seeding:** each guild is guaranteed
  exactly 12 Main + 18 Sub blank parties, seeded server-side with deterministic
  ids `${type}-${field}-${position}` via upserts (`$setOnInsert`) plus a unique
  index on `partyId`. Seeding is race-safe and never duplicates or overwrites
  existing assignments on reload.
- **Roster reconcile (prune departed members):** the Discord bot owns `members`
  and its sync deletes departed / de-roled users (they drop out of the left
  pool automatically). On load, `ensureGuildParties` also reconciles each party
  against the live roster — any `memberId` no longer in the guild's `members` is
  removed, and if it sat in a **locked** slot that lock is dropped too (the
  pinned member is gone → slot freed + unlocked). The prune is idempotent
  (writes only changed parties) and race-safe. This is **eventually
  consistent**: a departure is reflected on the bot's next sync (hourly timer +
  `/syncmembers`) and the next dashboard load, not instantly.
- **Selected guild is driven by a URL search param** (`/?guild=daddy` or
  `/?guild=mummy`). Toggling re-runs the server component, which re-seeds/fetches
  only that guild's members + parties. Each guild's parties live independently in
  Mongo, so a guild's layout is retained across toggles and page reloads.
- **Auto-save:** every slot change (assign/move/remove), lock toggle, and rename
  immediately calls a server action. No manual save step.

## Data contract

Database: `discordbot` (MongoDB Atlas).

- **`members`** — *read-only here.* Owned and kept fresh by the Discord bot on a
  timer. Document shape (UNCHANGED — the app reads these flags, it does not
  rename them):

  ```ts
  { userId, username, displayName, avatarUrl | null,
    isMain (bool, Daddy guild), isSub (bool, Mummy guild),
    className | null, classRoleId | null, updatedAt: Date }
  ```

- **`parties`** — *owned by this app* (read + write). A party is identified by
  `(type, field, position)`. `type` is the guild; `field` is which of the
  guild's two fields it belongs to. Document shape:

  ```ts
  { partyId: `${type}-${field}-${position}`,  // deterministic id
    type: 'daddy' | 'mummy',
    field: 'main' | 'sub',         // Main Field (12) or Sub Field (18)
    name (string),
    memberIds: string[] (assigned userIds, max 5),
    position (number, 0-based index within (type, field)),
    x (number), y (number),        // legacy; unused now (grid-driven layout)
    lockedSlots: number[],         // slot indexes that can't be overwritten
    updatedAt: Date }
  ```

  Each guild is seeded with exactly **12 `field: 'main'` + 18 `field: 'sub'`**
  blank parties (idempotent upsert; unique index on `partyId`).

- **`raidGroups`** — *owned by this app* (read + write). The layer **above**
  parties (Members → Parties → Raid Groups). Created manually (not pre-seeded),
  scoped per guild **and** per field. Document shape:

  ```ts
  { raidGroupId (uuid string),
    type: 'daddy' | 'mummy',
    field: 'main' | 'sub',     // Main raid groups hold Main parties only
    name (string),
    partyIds: string[],        // parties in this group (no cap)
    position (number, order within (type, field)),
    updatedAt: Date }
  ```

  A party is **"unassigned"** for its field if its `partyId` is in no raid
  group's `partyIds` for that `(type, field)`. The **one-raid-per-party**
  invariant is enforced server-side (assigning a party first pulls it from every
  other raid group in that field). Deleting a raid group removes **only** the
  group — its parties return to the unassigned pool (parties + members untouched).

- **`memberMeta`** — *owned by this app* (read + write). The source of truth for
  manual **power ratings** and the **historical roster**. Power and "departed"
  history must NOT live in `members` (the bot's sync would wipe them). Shape:

  ```ts
  { userId (unique),
    power (int >= 0, default 0),       // manual rating
    displayName, username, className, classRoleId, isMain, isSub, avatarUrl,
    lastSeenAt: Date,                  // last time seen in live `members`
    updatedAt: Date }
  ```

  **On load**, the data layer upserts meta for every current member: it
  `$set`s the cached roster fields + `lastSeenAt`, and `$setOnInsert`s
  `power: 0` for new members — so a re-sync **never resets an existing power**.
  **active** = userId present in `members`; **departed** = a `memberMeta` row
  whose userId is no longer in `members` (kept for history, shown greyed on
  `/members`).

This app never writes to `members`; it only writes `parties` + `raidGroups` +
`memberMeta`.
Each guild's data is queried and stored independently
(`type: 'daddy'` vs `type: 'mummy'`).

## Running locally

```bash
npm i
cp .env.local.example .env.local   # then set MONGODB_URI
npm run dev
```

Open http://localhost:3000.

`MONGODB_URI` should point at the same Atlas cluster the Discord bot uses.

### Without a database

If `MONGODB_URI` is unset, the app still runs: it renders a clearly-labeled
banner and serves **local mock data** (`src/lib/mock.ts`) so the dashboard and
drag-and-drop can be exercised. In this mode, changes are **not** persisted.

## Build

```bash
npm run build
npm run lint
```

## Deployment

Deploys to any Node host or Vercel. Set `MONGODB_URI` as a server-side
environment variable in the host. Nothing else is required.

See **[DEPLOY.md](./DEPLOY.md)** for exact Vercel steps (env var, Atlas network
access, Node version, and the two deploy paths: GitHub Git integration or the
`vercel` CLI).

## Project structure

| Path | Purpose |
|---|---|
| `src/lib/mongo.ts` | Server-only cached `MongoClient` singleton. |
| `src/lib/types.ts` | Shared types (`Guild` / `Field` / `Member` / `Party` / `RaidGroup` / `MemberMeta` / `ManagedMember`) + helpers (`partyHasPriest`, `CLASS_ROLE`, `normalizePower`). |
| `src/lib/data.ts` | Per-guild reads, field seeding + roster reconcile, memberMeta sync/power (`getParties`, `getRaidGroups`, `syncMemberMeta`, `getMembersForManagement`, `getPowerMap`). |
| `src/lib/actions.ts` | Server actions: party, roster auto-fill (power-aware `generateGuild`), raid groups, and `setMemberPower`. |
| `src/lib/mock.ts` | Local-dev fallback data (no DB) incl. in-memory raid-group + memberMeta stores. |
| `src/app/page.tsx` | Builder server component; reads `?guild=`, renders `BuilderShell`. |
| `src/app/raids/page.tsx` | Raid Groups server component; reads `?guild=`, renders `RaidShell`. |
| `src/app/members/page.tsx` | Members server component; upserts memberMeta, renders `MembersDashboard`. |
| `src/components/MembersDashboard.tsx` | Client member dashboard: stat cards, member grid, power-edit modal. |
| `src/components/BuilderShell.tsx` | Client builder: two-pane layout, single `DndContext`, scrollable two-field grid, auto-save + Generate/Reset toolbar. |
| `src/components/RaidShell.tsx` | Client raid builder: two field sections, each with an unassigned-party pool + raid-group containers; one `DndContext id="raid-dnd"`. |
| `src/components/RaidGroupCard.tsx` | Droppable raid group: editable name, delete, holds party chips. |
| `src/components/PartyChip.tsx` | Draggable party chip (name + member count + no-Priest ⚠). |
| `src/components/MemberPool.tsx` | Left sidebar (draggable member pool, also a drop target). |
| `src/components/PartyCard.tsx` | Neon party card: renameable header, 5 slots, lock + remove. |
| `src/components/MemberChip.tsx` | Draggable member card (name + class + ⚡power). |
| `src/components/TopNav.tsx` | Shared top nav (Party/Raid/Member + guild toggle) on all 3 pages. |
| `src/components/GuildToggle.tsx` | Daddy ⇄ Mummy switcher (`basePath` keeps you on the current page). |
| `src/components/PartyBoard.tsx` | Deprecated shim → re-exports `BuilderShell`. |
