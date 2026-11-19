import { useEffect, useState } from "react";
import { api } from "../api";

const TIER_LABELS = { specialist: "Specialist", all_star: "All-Star", elite: "Elite" };
const TIER_STYLES = {
  specialist: "bg-slate-700 text-slate-300",
  all_star: "bg-sky-500/15 text-sky-400",
  elite: "bg-amber-500/15 text-amber-400",
};

const CATEGORY_LABELS = {
  skating: "Skating",
  shootingPassing: "Shooting/Passing",
  puckSkills: "Puck Skills",
  checking: "Checking",
  goalie: "Goalie",
};

function TierBadge({ tier }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIER_STYLES[tier] ?? "bg-slate-700 text-slate-300"}`}>
      {TIER_LABELS[tier] ?? tier}
    </span>
  );
}

// Grouped <option>s for the ability select — goalies just get the flat
// goalie list, skaters get their four categories as optgroups. `usedBy`
// abilities (picked in another slot) are left out so the same ability can't
// be chosen twice.
function AbilitySelect({ value, position, catalog, usedByOthers, onChange }) {
  const categoryKeys = position === "G" ? ["goalie"] : ["skating", "shootingPassing", "puckSkills", "checking"];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
    >
      <option value="">— choose ability —</option>
      {categoryKeys.map((key) => (
        <optgroup key={key} label={CATEGORY_LABELS[key]}>
          {catalog.categories[key]
            .filter((ability) => ability === value || !usedByOthers.has(ability))
            .map((ability) => (
              <option key={ability} value={ability}>
                {ability}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function PlayerXFactors({ player, canEdit, onUpdate }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getXFactorCatalog().then(setCatalog).catch((e) => setError(e.message));
  }, []);

  const xFactors = player.xFactors ?? [];

  const startEditing = () => {
    setDraft(xFactors.map((x) => ({ ...x })));
    setEditing(true);
    setError(null);
  };

  const cancelEditing = () => {
    setEditing(false);
    setError(null);
  };

  const updateSlot = (index, patch) => {
    setDraft((prev) => prev.map((x, i) => (i === index ? { ...x, ...patch } : x)));
  };

  const removeSlot = (index) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const addSlot = () => {
    setDraft((prev) => [...prev, { ability: "", tier: "specialist" }]);
  };

  const handleSave = async () => {
    if (draft.some((x) => !x.ability)) {
      setError("Every X-Factor needs an ability picked (or remove the empty one).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.setPlayerXFactors(player.id, draft);
      onUpdate(updated);
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!catalog) return null;

  return (
    <div className="mb-5">
      <div className="mb-1 flex items-center justify-between">
        <div className="hub-label">X-Factors</div>
        {canEdit && !editing && (
          <button type="button" onClick={startEditing} className="text-xs font-medium text-sky-400 hover:text-sky-300">
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        xFactors.length === 0 ? (
          <p className="text-sm text-slate-600">No X-Factors.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {xFactors.map((x) => (
              <span key={x.ability} className="flex items-center gap-1.5 rounded-md bg-slate-950 px-2.5 py-1 text-sm">
                <span className="text-slate-100">{x.ability}</span>
                <TierBadge tier={x.tier} />
              </span>
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2 rounded-md bg-slate-950 p-3">
          {draft.map((x, i) => {
            const usedByOthers = new Set(draft.filter((_, j) => j !== i).map((o) => o.ability));
            return (
              <div key={i} className="flex items-center gap-2">
                <AbilitySelect
                  value={x.ability}
                  position={player.position}
                  catalog={catalog}
                  usedByOthers={usedByOthers}
                  onChange={(ability) => updateSlot(i, { ability })}
                />
                <select
                  value={x.tier}
                  onChange={(e) => updateSlot(i, { tier: e.target.value })}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                >
                  {catalog.tiers.map((tier) => (
                    <option key={tier} value={tier}>
                      {TIER_LABELS[tier]}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => removeSlot(i)} className="text-slate-500 hover:text-red-400">
                  ✕
                </button>
              </div>
            );
          })}

          {draft.length < catalog.maxXFactors && (
            <button
              type="button"
              onClick={addSlot}
              className="self-start text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              + Add X-Factor
            </button>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={cancelEditing} className="text-xs text-slate-400 hover:text-slate-200">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
