import { getSettings } from "@/lib/data";
import { isMongoConfigured } from "@/lib/mongo";
import { SettingsForm } from "@/components/SettingsForm";
import { DEFAULT_GUILD } from "@/lib/types";

// Settings page — GLOBAL config (not per-guild), so the guild toggle is hidden
// in the TopNav. Server component reads the settings doc (seeding defaults on
// first access) and hands a deterministic initial state to the client form, so
// SSR === first client render (hydration-clean).
//
// Force dynamic so the page always reads the CURRENT settings doc (it has no
// searchParams, so it would otherwise be statically prerendered at build).
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();
  return (
    <SettingsForm
      // DEFAULT_GUILD is passed only so the TopNav's nav links carry a guild for
      // the other pages; the toggle itself is hidden on /settings.
      guild={DEFAULT_GUILD}
      settings={settings}
      persistenceEnabled={isMongoConfigured}
    />
  );
}
