// One-off CLI for granting (or revoking) the global admin flag — see
// globalSchema.sql's comment on accounts.is_admin. Deliberately the only
// way to set it: there's no in-app "make someone an admin" button, the
// same bootstrap-only trust boundary as everything else that crosses
// league lines (deleteAccount.js, resetPassword.js). An admin can create/
// edit/delete any account in any league via the in-app Admin Panel once
// they have this flag — start with yourself.
//
// Usage:
//   node scripts/setAdmin.js <username> true
//   node scripts/setAdmin.js <username> false
const accounts = require("../accounts");

async function main() {
  const [username, flagArg] = process.argv.slice(2);
  if (!username || (flagArg !== "true" && flagArg !== "false")) {
    console.error("Usage: node scripts/setAdmin.js <username> true|false");
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

  const isAdmin = flagArg === "true";
  await accounts.setAdminFlag(account.id, isAdmin);
  console.log(`"${account.username}" (${account.displayName}) is ${isAdmin ? "now" : "no longer"} an admin.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
