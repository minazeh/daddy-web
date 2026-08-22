// Runs ONCE when a Next.js server instance starts (Next 16 `instrumentation`
// file convention — node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation.md).
//
// This is where the Mongo indexes and the settings seed live now, so that no
// page render ever issues a `createIndex` or a seeding upsert. `register` must
// complete before the server accepts requests, so the bootstrap is deliberately
// NOT awaited: it is fire-and-forget with its own catch, and every write path
// awaits the same memoized promise before it writes, so a slow or failed boot
// can never leave a seeding upsert running without its unique index.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureSchema } = await import("./lib/bootstrap");
  void ensureSchema().catch((err) => {
    console.error("[bootstrap] schema init failed (will retry on next write)", err);
  });
}
