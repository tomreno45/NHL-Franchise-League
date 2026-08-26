// One-off CLI for resetting an account's password — for when someone
// forgets theirs. No email/self-serve "forgot password" flow exists (this
// is an invite-only friend league), so this is the recovery path: the
// developer runs it by hand and passes the new password along directly,
// same as account creation. Deliberately not exposed over HTTP — a
// commissioner's authority is scoped to their own league, and resetting a
// password affects every league the account belongs to.
//
// Usage:
//   node scripts/resetPassword.js <username> <newPassword>
const accounts = require("../accounts");

async function main() {
  const [username, newPassword] = process.argv.slice(2);
  if (!username || !newPassword) {
    console.error("Usage: node scripts/resetPassword.js <username> <newPassword>");
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

  await accounts.resetPassword(account.id, newPassword);
  console.log(
    `Password reset for "${account.username}" (${account.displayName}) — share the new password with them directly. They'll be asked to set their own on next sign-in.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
