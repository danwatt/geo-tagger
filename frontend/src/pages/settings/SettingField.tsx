import { useEffect, useRef, useState } from "react";
import type { Schemas } from "../../api/client";

/* One live-tunable setting: label, hint with the env default, a checkbox or
 * number input, and Reset when the value is overridden in the DB. Checkboxes
 * save on toggle; numbers save on commit (blur or Enter), like the legacy page's
 * `change` event, not on every keystroke. */

export type Setting = Schemas["SettingOut"];
export type SettingValue = Setting["value"];

type Props = {
  setting: Setting;
  onSave: (key: string, value: number) => Promise<SettingValue>;
  onReset: (key: string) => Promise<void>;
};

const FLASH_MS = 1200;

export function SettingField({ setting, onSave, onReset }: Props) {
  const inputId = `input-${setting.key}`;
  const [draft, setDraft] = useState(String(setting.value));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);
  // The draft the server last rejected: Enter then blur (or clicking Reset) would
  // otherwise send the same bad value twice. The legacy `change` event didn't refire.
  const rejected = useRef<string | null>(null);

  // A reset or another tab's change arrives as a new prop value.
  useEffect(() => setDraft(String(setting.value)), [setting.value]);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  async function save(value: number, attempted = String(value)) {
    try {
      const stored = await onSave(setting.key, value);
      rejected.current = null;
      setError(null);
      setDraft(String(stored)); // the server may clamp or round
      setSaved(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setSaved(false), FLASH_MS);
    } catch (e) {
      rejected.current = attempted;
      setError((e as Error).message);
    }
  }

  function commitNumber() {
    if (draft === String(setting.value) || draft === rejected.current) return;
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value)) {
      setError("Enter a number");
      return;
    }
    void save(value, draft);
  }

  async function reset() {
    try {
      await onReset(setting.key);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-label">
        <label htmlFor={inputId}>{setting.label}</label>
        {setting.overridden && (
          <button type="button" className="reset-btn" onClick={() => void reset()}>
            Reset to default
          </button>
        )}
      </div>
      <div className="setting-help" id={`${inputId}-help`}>
        {setting.help} (default: {String(setting.default)})
      </div>
      <div className="setting-control">
        {setting.type === "bool" ? (
          <input
            id={inputId}
            type="checkbox"
            aria-describedby={`${inputId}-help`}
            checked={Boolean(setting.value)}
            onChange={(e) => void save(e.target.checked ? 1 : 0)}
          />
        ) : (
          <input
            id={inputId}
            type="number"
            aria-describedby={`${inputId}-help`}
            min={setting.min ?? undefined}
            max={setting.max ?? undefined}
            step={setting.step ?? undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitNumber}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNumber();
            }}
          />
        )}
        <span className={`setting-saved-flash${saved ? " show" : ""}`} aria-live="polite">
          {saved ? "Saved" : ""}
        </span>
      </div>
      {error && <div className="setting-error" role="alert">{error}</div>}
    </div>
  );
}
