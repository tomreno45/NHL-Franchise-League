// One-off CLI for permanently deleting an account — every league
// membership and push subscription goes with it (cascading deletes, see
// globalSchema.sql), and the username becomes available for someone else
// to take. Irreversible, unlike removing someone from a single league in
// the Commissioner tab (which leaves the account itself intact, ready to
// be added back later) — this is the "actually erase them" action, so it's
// deliberately a developer/shell-access-only CLI, never an HTTP route a
// commissioner could reach (a single league's commissioner shouldn't be
// able to wipe an account that might belong to leagues they have no
// authority over).
//
// Defaults to a dry run — prints what WOULD be deleted (every league/team/
// role it currently has) without touching anything. Pass --confirm to
// actually delete.
//
// Usage:
//   node scripts/deleteAccount.js <username>            (dry run)
//   node scripts/deleteAccount.js <username> --confirm   (actually deletes)
const accounts = require("../accounts");
const store = require("../store");
const { runWithLeague } = require("../db");

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const username = args.find((a) => !a.startsWith("--"));

  if (!username) {
    console.error("Usage: node scripts/deleteAccount.js <username> [--confirm]");
    process.exitCode = 1;
    return;
  }

  await accounts.ensureGlobalSchema();

  const account = await accounts.findAccountByUsername(username);
  if (!account) {
    console.error(`No account found with username "${username}"`);
    process.exitCode = 1;
    return;
  }

  const memberships = await accounts.getMemberships(account.id);
  console.log(`\n"${account.username}" (${account.displayName}), account #${account.id}:`);
  if (memberships.length === 0) {
    console.log("  Not a member of any league.");
  } else {
    memberships.forEach((m) => console.log(`  - ${m.leagueSlug}: team ${m.teamId ?? "(none)"}, role ${m.role}`));
  }

  if (!confirm) {
    console.log("\nDry run only — nothing was deleted. Re-run with --confirm to permanently delete this account.");
    return;
  }

  await accounts.deleteAccountEntirely(account.id);

  // Mirrors the flip DELETE /api/commissioner/users/:id does for a single
  // league — a team stops being "human-controlled" once nobody's left
  // assigned to it. This account could have had a team in more than one
  // league, so check each one it actually had.
  for (const m of memberships) {
    if (m.teamId == null) continue;
    const remaining = await accounts.countMembersOnTeam(m.leagueSlug, m.teamId);
    if (remaining === 0) {
      await runWithLeague(m.leagueSlug, () => store.setTeamHumanControlled(m.teamId, false));
      console.log(`  (${m.leagueSlug}: team ${m.teamId} has no members left — reverted to CPU-controlled)`);
    }
  }

  console.log(`\nDeleted. "${username}" is available again for a new account.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
