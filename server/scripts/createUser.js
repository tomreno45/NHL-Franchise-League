// One-off CLI for creating login accounts, or adding an existing one to
// another league. There's no public registration endpoint (this is an
// invite-only friend league, not a public product) — the commissioner runs
// this by hand, or uses the equivalent "Manage Users" form in the
// Commissioner tab.
//
// Usage:
//   LEAGUE=<test|development|production> node scripts/createUser.js <username> <password> "<Display Name>" [teamAbbrOrId] [role]
//
// Example:
//   LEAGUE=production node scripts/createUser.js jsmith hunter2 "John Smith" BOS commissioner
//
// If <username> already has an account (in this league or another — see
// accounts.js, login identity is global now), <password>/<displayName> are
// ignored (a warning is printed) and this just adds a membership for
// LEAGUE using the account's existing password. role defaults to "user" —
// pass "commissioner" to grant league-advancing powers. LEAGUE selects
// which league the new membership is created in — required since this
// runs standalone, outside any request's session-derived league.
const accounts = require("../accounts");
const store = require("../store");
const { teams } = require("../data");

function resolveTeamId(teamArg) {
  if (!teamArg) return null;
  const byAbbr = teams.find((t) => t.abbr.toLowerCase() === teamArg.toLowerCase());
  if (byAbbr) return byAbbr.id;
  const asId = Number(teamArg);
  if (Number.isInteger(asId) && teams.some((t) => t.id === asId)) return asId;
  throw new Error(`No team matches "${teamArg}" (use an abbreviation like BOS, or a numeric team id)`);
}

async function main() {
  const league = process.env.LEAGUE;
  if (!league) {
    console.error("LEAGUE env var is required, e.g. LEAGUE=test node scripts/createUser.js ...");
    process.exitCode = 1;
    return;
  }

  const [username, password, displayName, teamArg, roleArg] = process.argv.slice(2);
  if (!username || !password || !displayName) {
    console.error(
      'Usage: LEAGUE=<test|development|production> node scripts/createUser.js <username> <password> "<Display Name>" [teamAbbrOrId] [role]'
    );
    process.exitCode = 1;
    return;
  }

  const teamId = resolveTeamId(teamArg);
  const role = roleArg || "user";

  await accounts.ensureGlobalSchema();

  let account = await accounts.findAccountByUsername(username);
  if (account) {
    console.log(`Account "${username}" already exists (added ${new Date(account.createdAt).toLocaleDateString()}) — using it as-is, ignoring the password/display name given here.`);
  } else {
    account = await accounts.createAccount({ username, password, displayName });
  }

  await accounts.addMembership({ accountId: account.id, leagueSlug: league, teamId, role });
  if (teamId != null) {
    await store.setTeamHumanControlled(teamId, true);
  }

  const teamLabel = teamId ? teams.find((t) => t.id === teamId).abbr : "(no team)";
  console.log(`"${account.username}" (${account.displayName}) is now in ${league} — ${teamLabel} — role: ${role}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
