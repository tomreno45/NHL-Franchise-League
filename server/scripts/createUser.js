// One-off CLI for creating login accounts. There's no public registration
// endpoint (this is an invite-only friend league, not a public product) —
// the commissioner runs this by hand for each of the 4 human GMs.
//
// Usage:
//   LEAGUE=<test|development|production> node scripts/createUser.js <username> <password> "<Display Name>" [teamAbbrOrId] [role]
//
// Example:
//   LEAGUE=production node scripts/createUser.js jsmith hunter2 "John Smith" BOS commissioner
//
// role defaults to "user" — pass "commissioner" to grant league-advancing
// powers (see store.js's USER_ROLES). LEAGUE selects which of the parallel
// league databases the account is created in (see db.js) — required since
// this runs standalone, outside any request's session-derived league.
const { pool } = require("../db");
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
  const user = await store.createUser({ username, password, displayName, teamId, role });
  const teamLabel = teamId ? teams.find((t) => t.id === teamId).abbr : "(no team)";
  console.log(`Created user #${user.id} "${user.username}" — ${user.displayName} — ${teamLabel} — role: ${user.role}`);
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
