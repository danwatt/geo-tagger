import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../../api/client";
import { AppShell } from "../../shell/AppShell";
import { SettingField, type Setting, type SettingValue } from "./SettingField";
import "./settings.css";

const SETTINGS_KEY = ["settings"] as const;

/** Settings grouped in the server's SETTINGS_SPEC order (config.py owns it). */
function groupSettings(settings: Setting[]): [string, Setting[]][] {
  const groups = new Map<string, Setting[]>();
  for (const s of settings) {
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  return [...groups];
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => unwrap(await api.GET("/api/settings")).settings,
  });

  const update = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: number }) =>
      unwrap(await api.PATCH("/api/settings", { body: { values: { [key]: value } } })).updated,
    onSuccess: (updated) => {
      // Patch the cache in place rather than refetching the whole list.
      queryClient.setQueryData<Setting[]>(SETTINGS_KEY, (old) =>
        old?.map((s) => (s.key in updated ? { ...s, value: updated[s.key] as SettingValue, overridden: true } : s)),
      );
    },
  });

  const reset = useMutation({
    mutationFn: async (key: string) => unwrap(await api.POST("/api/settings/reset", { body: { keys: [key] } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });

  return (
    <AppShell active="settings">
      <main id="settings-page">
        <p className="settings-intro">
          Tuning knobs for geotagging, the work queue, RAW decoding, and face matching. Changes apply immediately — no
          restart needed — and are saved to the database, overriding the env-var default shown in each hint.
        </p>
        {settings.isPending && <p className="settings-intro">Loading settings…</p>}
        {settings.isError && (
          <div className="setting-error" role="alert">
            Error loading settings: {settings.error.message}
          </div>
        )}
        {settings.data &&
          groupSettings(settings.data).map(([group, items]) => (
            <section key={group} className="settings-group" aria-labelledby={`group-${group}`}>
              <h2 id={`group-${group}`}>{group}</h2>
              {items.map((s) => (
                <SettingField
                  key={s.key}
                  setting={s}
                  onSave={async (key, value) => {
                    const updated = await update.mutateAsync({ key, value });
                    return updated[key] as SettingValue;
                  }}
                  onReset={async (key) => {
                    await reset.mutateAsync(key);
                  }}
                />
              ))}
            </section>
          ))}
      </main>
    </AppShell>
  );
}
