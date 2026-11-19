import type { UserRow } from "./store.ts";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

function layout(title: string, body: string, error?: string, wide = false) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Bee Bot</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: ${wide ? "64rem" : "22rem"}; margin: ${wide ? "2rem" : "15vh"} auto; padding: 0 1rem; line-height: 1.5; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input, button { box-sizing: border-box; width: 100%; padding: 0.6rem; font: inherit; margin-top: 0.25rem; }
  button { margin-top: 1.5rem; cursor: pointer; }
  [role="alert"] { border: 2px solid #c62828; padding: 0.6rem; }
  [role="status"] { border: 2px solid #2e7d32; padding: 0.6rem; }
  .scroll { overflow-x: auto; }
  small { display: block; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid #8884; vertical-align: top; }
  td form, td button { display: inline; width: auto; margin: 0; padding: 0.2rem 0.6rem; }
  .inline { display: flex; gap: 0.5rem; align-items: center; }
  .inline input[type="checkbox"], .inline label { width: auto; margin: 0; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
${body}
</main>
</body>
</html>`;
}

export const loginPage = (next: string, error?: string) =>
  layout(
    "Sign in",
    `<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>`,
    error,
  );

export const invitePage = (email: string, error?: string) =>
  layout(
    "Set your password",
    `<form method="post">
<p>Your account will be <strong>${escapeHtml(email)}</strong>.</p>
<input type="hidden" name="email" value="${escapeHtml(email)}" autocomplete="username">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus>
<button type="submit">Create account</button>
</form>`,
    error,
  );

export const messagePage = (title: string, message: string) =>
  layout(title, `<p>${escapeHtml(message)}</p><p><a href="/login">Sign in</a></p>`);

export const logoutPage = () =>
  layout(
    "Sign out",
    `<form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
  );

const day = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const cellForm = (action: string, cell: string, label: string) =>
  `<form method="post" action="/admin/users/${action}"><input type="hidden" name="cell" value="${escapeHtml(cell)}"><button type="submit">${label}</button></form>`;

export const usersPage = (
  users: Array<UserRow & { unit: string; answering: boolean }>,
  selfCell: string,
  { invite, error }: { invite?: string; error?: string } = {},
) =>
  layout(
    "Users",
    `<p><a href="/">Back to Bee Bot</a></p>
${
  invite
    ? `<div role="status"><label for="invite-url">Invite link. It is shown only once, so copy it now.</label><input id="invite-url" readonly value="${escapeHtml(invite)}"></div>`
    : ""
}
<div class="scroll"><table>
<thead><tr><th scope="col">Email</th><th scope="col">Cell</th><th scope="col">Admin</th><th scope="col">State</th><th scope="col">Created</th><th scope="col">Unit</th><th scope="col">Socket</th><th scope="col">Actions</th></tr></thead>
<tbody>
${users
  .map(
    (user) => `<tr>
<td>${escapeHtml(user.email)}</td>
<td><code>${escapeHtml(user.cell)}</code></td>
<td>${user.admin ? "yes" : "no"}</td>
<td>${escapeHtml(user.state)}${user.error ? `: ${escapeHtml(user.error)}` : ""}</td>
<td>${day(user.createdAt)}</td>
<td>${escapeHtml(user.unit)}</td>
<td>${user.answering ? "answering" : "not answering"}</td>
<td>${
      user.cell === selfCell
        ? "you"
        : user.state === "suspended"
          ? cellForm("resume", user.cell, "Resume")
          : cellForm("suspend", user.cell, "Suspend")
    } <a href="/admin/users/${escapeHtml(user.cell)}" aria-label="Manage ${escapeHtml(user.email)}">Manage</a></td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table></div>
<h2>Invite someone</h2>
<form method="post" action="/admin/invites">
<label for="email">Email</label>
<input id="email" name="email" type="email" required>
<div class="inline"><input id="admin" name="admin" type="checkbox" value="true"><label for="admin">Admin</label></div>
<button type="submit">Create invite link</button>
</form>`,
    error,
    true,
  );

export type QuotaValues = {
  memory: string;
  cpu: string;
  tasks: string;
  boxes: string | undefined;
  "budget-usd": string | undefined;
};

const field = (name: string, label: string, value: string, pattern: string, hint: string) =>
  `<label for="${name}">${label}</label>
<input id="${name}" name="${name}" value="${escapeHtml(value)}" pattern="${pattern}" aria-describedby="${name}-hint" required>
<small id="${name}-hint">${hint}</small>`;

export const userPage = (
  user: { email: string; cell: string; state: string },
  unit: string,
  quota: QuotaValues,
  { error, saved }: { error?: string; saved?: boolean } = {},
) =>
  layout(
    user.email,
    `<p><a href="/admin">All users</a></p>
${saved ? `<p role="status">Quota saved.</p>` : ""}
<p>Cell <code>${escapeHtml(user.cell)}</code>, ${escapeHtml(user.state)}, unit ${escapeHtml(unit)}.</p>
<h2>Quota</h2>
<form method="post" action="/admin/users/quota">
<input type="hidden" name="cell" value="${escapeHtml(user.cell)}">
${field("memory", "Memory", quota.memory, "[1-9][0-9]{0,5}[KMGT]", "Like 4G or 512M.")}
${field("cpu", "CPU", quota.cpu, "[1-9][0-9]{0,4}%?", "Percent of one core, like 200%.")}
${field("tasks", "Tasks", quota.tasks, "[1-9][0-9]{0,6}", "Most processes and threads at once.")}
${quota.boxes === undefined ? "" : field("boxes", "Boxes", quota.boxes, "[1-9][0-9]{0,2}", "Most boxes running at once.")}
${quota["budget-usd"] === undefined ? "" : field("budget-usd", "Budget (USD)", quota["budget-usd"], "(0|[1-9][0-9]{0,6})([.][0-9]{1,2})?", "Spending limit in dollars.")}
<button type="submit">Save quota</button>
</form>
<h2>Delete</h2>
<form method="post" action="/admin/users/delete">
<input type="hidden" name="cell" value="${escapeHtml(user.cell)}">
<p>This removes the account and everything in its cell. It can't be undone.</p>
<label for="confirm">Type ${escapeHtml(user.email)} to confirm</label>
<input id="confirm" name="confirm" autocomplete="off" required>
<button type="submit">Delete user and their data</button>
</form>`,
    error,
    true,
  );
