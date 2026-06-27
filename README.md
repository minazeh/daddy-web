# Daddy Poring — Member Dashboard & Party Builder

A Next.js web app for managing guild member rosters and building 5-man parties
via drag-and-drop.

**Daddy and Mummy are two SEPARATE guilds** — their members and their parties
are entirely independent and are never shown together. The app displays exactly
**one guild at a time**, with a **Daddy ⇄ Mummy toggle** (defaults to Daddy).

## Layout

A full-width, full-height two-pane builder (no centered container):

- **Left — member panel** (~300px, sticky, scrollable): the selected guild's
  member pool as compact draggable cards (name + class pill + MAIN/SUB badge).
  The Daddy ⇄ Mummy toggle lives at the top of this panel.
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
pill, a MAIN/SUB badge, a **lock** toggle, and an **X** remove button. Empty
slots show a "drop here" placeholder. A **locked slot can't be overwritten** by
a drop. (We only have name + class + isMain/isSub — no STR / build-spec / role
data, and none is invented.)

**Every slot change auto-saves** — drag assignments, locks, and renames persist
immediately. There is no manual save button.

### Roster auto-fill toolbar

A toolbar above the field grid has three buttons, all scoped to the
**currently-viewed guild** (both its Main + Sub fields). Randomness lives in the
server actions, so there is no hydration concern.

- **Generate** — auto-assigns the unlocked slots. Locked slots are frozen
  (preserved). It builds the available pool from this guild's members who are
  not pinned in a locked slot, clears all unlocked slots, then fills:
  1. **Hard rule — a Priest in every party:** each party lacking a (locked)
     Priest gets one from the Priest pool first (highest-power Priest → currently
     lowest-power party). If Priests run short, it fills as many as it can and
     shows a **"⚠ No Priest"** badge on the parties left without one.
  2. **Tank spread:** ~1 Tank (Knight) per party, again highest-power → lowest.
  3. **Power balance:** remaining members are placed **highest-power-first into
     the currently-lowest-power party** that has a free slot (a "largest-first
     into smallest-bin" partition heuristic) — this minimizes the spread of
     party power sums. Locked members' power counts toward their party from the
     start. Each member's power comes from `memberMeta` (default 0 when
     unrated). Equal-power members are shuffled so repeated Generates differ.
  Generate uses **ACTIVE members only** (present in `members`). No member is
  placed in two parties; the 5-slot cap is respected; fills stop when the pool
  is exhausted (later parties may be partial).
- **Reset** — clears only the **unlocked** slots (members return to the pool);
  locked members stay pinned; locks unchanged. (Confirm prompt.)
- **Reset Lock** — clears **everything** for the guild: all assignments **and**
  all locks → a blank board. (Confirm prompt; destructive.)

The role mapping is the `CLASS_ROLE` constant in `src/lib/types.ts` (easy to
edit): **Tank** = Knight; **Healer** = Priest; **DPS** = Assassin, Hunter,
Gunslinger, Blacksmith, Wizard, Druid. A member with an unknown/null `className`
is generic DPS/flex and never counts as a Priest.

### Raid Groups page (`/raids`)

The layer **above** parties: **Members → Parties → Raid Groups**. From the
builder toolbar, **"Manage Raid Groups"** navigates to `/raids` (carrying the
guild via `?guild=`); `/raids` has a **"← Back to parties"** link. Same
Daddy⇄Mummy toggle and per-guild scoping, plain vertical scroll (no zoom/pan).

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

A dark analytics-style member management dashboard. From the builder toolbar,
**"Members"** navigates to `/members` (carrying the guild); the page has a
**"← Back to parties"** link and the Daddy⇄Mummy toggle.

- **Stat cards (real data only):** Active Members, Departed, Avg Power (active,
  unrated count as 0), and Parties Filled / Members Assigned. An **"Attendance —
  coming soon"** placeholder is shown but **no attendance numbers are
  fabricated** (voice-chat tracking is a later phase).
- **Member grid:** every member (active + departed) with avatar/initial,
  displayName, class, guild (Main/Sub), and power. **Departed members are greyed
  out + marked "Left server"** — they are not removed (they also leave the
  builder pool / Generate automatically via the party prune).
- **Click a member → modal** with all details (userId, username, displayName,
  class, classRoleId, guild, status, lastSeen) + an editable **Power Rating**
  field (non-negative integer, default 0). Save persists to `memberMeta` via the
  `setMemberPower` server action (optimistic UI).

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
| `src/components/MemberPool.tsx` | Left sidebar (toggle + draggable member pool, also a drop target). |
| `src/components/PartyCard.tsx` | Neon party card: renameable header, 5 slots, lock + remove. |
| `src/components/MemberChip.tsx` | Draggable member card + MAIN/SUB badge. |
| `src/components/GuildToggle.tsx` | Daddy ⇄ Mummy switcher (links to `/?guild=...` or `/raids?guild=...`). |
| `src/components/PartyBoard.tsx` | Deprecated shim → re-exports `BuilderShell`. |
