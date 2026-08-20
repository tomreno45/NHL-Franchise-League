import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";

function formatHeight(inches) {
  const feet = Math.floor(inches / 12);
  const remainder = inches % 12;
  return `${feet}'${remainder}"`;
}

export default function DraftBoard() {
  const { user } = useAuth();
  const [prospects, setProspects] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickingId, setPickingId] = useState(null);
  const fileInputRef = useRef(null);

  const loadProspects = () => api.getDraftClass().then(setProspects).catch((e) => setError(e.message));

  const loadStatus = async () => {
    const s = await api.getDraftStatus();
    setStatus(s);
    return s;
  };

  useEffect(() => {
    (async () => {
      try {
        const s = await loadStatus();
        // Catch up any leading CPU picks (safe/no-op if it's already a
        // human's turn, or the draft phase isn't active).
        if (s.inDraftPhase && !s.complete) {
          const resumed = await api.advanceDraft();
          setStatus(resumed);
        }
        await loadProspects();
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      setProspects(await api.generateDraftClass());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const csvText = await file.text();
      setProspects(await api.importDraftClass(csvText));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePick = async (prospectId) => {
    setPickingId(prospectId);
    setError(null);
    try {
      const resumed = await api.makeDraftPick({ teamId: status.onTheClock.currentTeam.id, prospectId });
      setStatus(resumed);
      await loadProspects();
    } catch (e) {
      setError(e.message);
    } finally {
      setPickingId(null);
    }
  };

  if (error) return <p className="text-red-500">{error}</p>;
  if (!prospects || !status) return <p className="text-slate-400">Loading draft board…</p>;

  const draftActive = status.inDraftPhase && !status.complete;
  const humanOnTheClock = draftActive && status.onTheClock?.currentTeam.isHumanControlled;

  return (
    <div>
      {status.inDraftPhase && (
        <div className="mb-4 rounded-lg bg-slate-900 p-4">
          {status.complete ? (
            <p className="text-emerald-400">Draft complete — every pick has been made.</p>
          ) : humanOnTheClock ? (
            <p className="text-sky-400">
              On the clock (pick {status.currentPickIndex + 1} of {status.totalPicks}):{" "}
              <span className="font-semibold">
                {status.onTheClock.currentTeam.city} {status.onTheClock.currentTeam.name}
              </span>{" "}
              — round {status.onTheClock.round}, #{status.onTheClock.overallPickNumber} overall. Pick a prospect below.
            </p>
          ) : (
            <p className="text-slate-400">CPU teams are picking…</p>
          )}
        </div>
      )}

      {user.role === "commissioner" && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy || draftActive}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Working…" : "Generate Random Class"}
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            disabled={busy || draftActive}
            className="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600 disabled:opacity-50"
          >
            Import Draft Class (CSV)
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFileChange} />
          <span className="text-xs text-slate-500">
            {draftActive
              ? "Board is locked while the draft is in progress."
              : "CSV columns: name (required), position, nationality, height, weight — anything left out is filled in randomly."}
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-left text-slate-400">
            <th className="px-3 py-2 text-right font-medium">Rank</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Pos</th>
            <th className="px-3 py-2 font-medium">Nationality</th>
            <th className="px-3 py-2 font-medium">Ht</th>
            <th className="px-3 py-2 font-medium">Wt</th>
            {humanOnTheClock && <th className="px-3 py-2 font-medium"></th>}
          </tr>
        </thead>
        <tbody>
          {prospects.map((p, i) => (
            <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
              <td className="px-3 py-2 text-right text-slate-300">{p.prospectRank}</td>
              <td className="px-3 py-2 text-slate-100">{p.name}</td>
              <td className="px-3 py-2 text-slate-300">{p.position}</td>
              <td className="px-3 py-2 text-slate-300">{p.nationality}</td>
              <td className="px-3 py-2 text-slate-300">{formatHeight(p.heightInches)}</td>
              <td className="px-3 py-2 text-slate-300">{p.weightLbs} lbs</td>
              {humanOnTheClock && (
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => handlePick(p.id)}
                    disabled={pickingId != null}
                    className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {pickingId === p.id ? "Picking…" : "Draft"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
