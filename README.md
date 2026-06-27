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

This app never writes to `members`; it only writes `parties`. Each guild's
parties are queried and stored independently (`type: 'daddy'` vs `type: 'mummy'`).

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
| `src/lib/types.ts` | Shared `Guild` / `Field` / `Member` / `Party` types + field sizes + `MAX_PARTY_SLOTS`. |
| `src/lib/data.ts` | Per-guild reads + idempotent field seeding (`ensureGuildParties`, `getMembers`, `getParties`). |
| `src/lib/actions.ts` | Server actions: `updateParty` (slots), `setPartyLocks`, `renameParty`. |
| `src/lib/mock.ts` | Local-dev fallback data (no DB). |
| `src/app/page.tsx` | Server component; reads `?guild=`, fetches that guild only, renders `BuilderShell`. |
| `src/components/BuilderShell.tsx` | Client builder: two-pane layout, single `DndContext`, scrollable board with two field grids, auto-save handlers. |
| `src/components/MemberPool.tsx` | Left sidebar (toggle + draggable member pool, also a drop target). |
| `src/components/PartyCard.tsx` | Neon party card: renameable header, 5 slots, lock + remove. |
| `src/components/MemberChip.tsx` | Draggable member card + MAIN/SUB badge. |
| `src/components/GuildToggle.tsx` | Daddy ⇄ Mummy switcher (links to `/?guild=...`). |
| `src/components/PartyBoard.tsx` | Deprecated shim → re-exports `BuilderShell`. |
