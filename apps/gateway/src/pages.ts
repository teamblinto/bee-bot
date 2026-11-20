import type { UserRow } from "./store.ts";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

// Values mirror apps/web/src/index.css, which mirrors the Figma "Bee Bot Color" and "Bee Bot Size"
// collections. The page policy allows inline style only, so no font loads: Inter Tight if installed.
const styles = `
:root {
  color-scheme: light dark;
  --background: #ffffff; --subtle: #f5f5f7; --raised: #e8e8ed; --card: #ffffff;
  --hover: rgb(26 26 26 / 0.1);
  --ink: #1a1a1a; --ink-secondary: #686868;
  --edge: #d8d8d8; --edge-subtle: rgb(26 26 26 / 0.1); --edge-strong: rgb(26 26 26 / 0.6);
  --focus: #298dff; --brand: #0062c4; --brand-fill: #0071e3; --brand-fill-hover: #0062c4;
  --on-brand: #ffffff;
  --danger: #b42318; --danger-status: #d92d20; --danger-edge: #d92d20; --danger-surface: #fdecea;
  --waiting-status: #9c7300; --success-status: #1f9d5f; --neutral-status: #8e8e8e;
  --logo-head: #eab800; --logo-visor: #1a1a1a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #1a1a1a; --subtle: #212121; --raised: #363636; --card: #262626;
    --hover: rgb(255 255 255 / 0.08);
    --ink: #f5f5f7; --ink-secondary: #b4b4b4;
    --edge: rgb(255 255 255 / 0.12); --edge-subtle: rgb(255 255 255 / 0.08); --edge-strong: #8e8e8e;
    --brand: #298dff;
    --danger: #ff6b5e; --danger-status: #ff6b5e; --danger-edge: #ff6b5e; --danger-surface: #3a1a17;
    --waiting-status: #eab800; --success-status: #4cc38a;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: var(--background); color: var(--ink);
  font: 14px/20px "Inter Tight Variable", "Inter Tight", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; overflow-wrap: anywhere;
}
:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
a { color: var(--brand); text-underline-offset: 2px; }
code { font: 13px/20px "JetBrains Mono", ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
h1 { margin: 0 0 4px; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
h2 { margin: 0 0 16px; font-size: 16px; line-height: 24px; font-weight: 600; }
p { margin: 0 0 16px; }
.top { display: flex; align-items: center; gap: 8px; padding: 16px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.top svg { flex: none; }
main { margin: 0 auto; padding: 0 16px 48px; }
.narrow main { max-width: 400px; padding-top: 8vh; }
.narrow .card { padding: 32px 24px; }
.wide .top { padding-inline: max(16px, calc((100% - 1008px) / 2)); border-bottom: 1px solid var(--edge-subtle); }
.wide main { max-width: 1040px; padding-top: 32px; }
.card { margin-bottom: 24px; padding: 24px; border: 1px solid var(--edge-subtle); border-radius: 12px; background: var(--card); }
.lede { color: var(--ink-secondary); }
.back { display: inline-block; margin-bottom: 16px; }
label { display: block; font-weight: 500; }
.field { margin-bottom: 16px; }
.field label { margin-bottom: 4px; }
.field small { display: block; margin-top: 4px; font-size: 12px; line-height: 16px; color: var(--ink-secondary); }
input:not([type="checkbox"]) {
  display: block; width: 100%; min-height: 36px; padding: 7px 12px;
  border: 1px solid var(--edge-strong); border-radius: 8px; background: var(--card); color: var(--ink); font: inherit;
}
input:not([type="checkbox"]):hover:not(:focus) { background: color-mix(in srgb, var(--card), var(--ink) 6%); }
input:not([type="checkbox"]):focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); }
input[aria-invalid="true"] { border-color: var(--danger-edge); }
input[aria-invalid="true"]:focus-visible { box-shadow: 0 0 0 2px var(--danger-edge); }
input[readonly] { background: var(--subtle); }
input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--brand-fill); }
.check { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 16px;
  border: 1px solid var(--edge-strong); border-radius: 8px; background: var(--card); color: var(--ink);
  font: inherit; font-weight: 500; white-space: nowrap; cursor: pointer;
}
button:hover { background: var(--hover); }
.primary { border-color: transparent; background: var(--brand-fill); color: var(--on-brand); }
.primary:hover { background: var(--brand-fill-hover); }
.danger { border-color: var(--danger-edge); color: var(--danger); }
.danger:hover { background: var(--danger-surface); }
.narrow form .primary { width: 100%; margin-top: 8px; }
.small { min-height: 28px; padding: 0 12px; font-size: 13px; line-height: 18px; }
.banner { display: flex; gap: 8px; align-items: flex-start; margin: 16px 0 24px; padding: 12px; border: 1px solid var(--edge-subtle); border-radius: 12px; background: var(--subtle); }
.banner svg { flex: none; margin-top: 2px; }
.banner > div { flex: 1; min-width: 0; }
.banner p { margin: 0; }
.banner label { margin-bottom: 8px; }
.banner[role="alert"] { border-color: transparent; background: var(--danger-surface); }
.banner[role="alert"] svg { color: var(--danger-status); }
.banner[role="alert"] strong { color: var(--danger); font-weight: 500; }
.banner[role="status"] svg { color: var(--success-status); }
.table { margin-bottom: 32px; overflow-x: auto; border: 1px solid var(--edge-subtle); border-radius: 12px; background: var(--card); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; text-align: left; vertical-align: middle; white-space: nowrap; }
th { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--ink-secondary); background: var(--subtle); }
td { border-top: 1px solid var(--edge-subtle); }
/* Narrow screens scroll the table sideways; the email stays put so each row keeps its name. */
th:first-child, td:first-child { position: sticky; left: 0; white-space: normal; overflow-wrap: anywhere; min-width: 9rem; box-shadow: inset -1px 0 var(--edge-subtle); }
td:first-child { background: var(--card); }
td form { display: inline; }
.actions { display: flex; align-items: center; gap: 8px; }
.you { color: var(--ink-secondary); }
.status { display: inline-flex; align-items: center; gap: 6px; }
.status::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--neutral-status); }
.status.ok::before { background: var(--success-status); }
.status.wait::before { background: var(--waiting-status); }
.status.bad::before { background: var(--danger-status); }
.facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-bottom: 24px; color: var(--ink-secondary); }
.facts strong { color: var(--ink); font-weight: 500; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 16px; }
.invite { max-width: 400px; }
.danger-zone { border-color: var(--danger-edge); }
.danger-zone .field { max-width: 400px; }
`;

// Figma "Bee Bot Glyph": the pixel bee, its colours fixed in both modes.
const logo = `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--logo-head)" d="M6.375 0.75H8.25V2.625H6.375V0.75ZM15.75 0.75H17.625V2.625H15.75V0.75ZM8.25 2.625H10.125V4.5H8.25V2.625ZM13.875 2.625H15.75V4.5H13.875V2.625ZM4.5 4.5H19.5V6.375H4.5V4.5ZM2.625 6.375H21.375V8.25H2.625V6.375ZM2.625 8.25H6.375V10.125H2.625V8.25ZM8.25 8.25H15.75V10.125H8.25V8.25ZM17.625 8.25H21.375V10.125H17.625V8.25ZM2.625 10.125H6.375V12H2.625V10.125ZM8.25 10.125H15.75V12H8.25V10.125ZM17.625 10.125H21.375V12H17.625V10.125ZM0.75 12H23.25V13.875H0.75V12ZM2.625 15.75H21.375V17.625H2.625V15.75ZM4.5 19.5H19.5V21.375H4.5V19.5ZM4.5 21.375H6.375V23.25H4.5V21.375ZM10.125 21.375H13.875V23.25H10.125V21.375ZM17.625 21.375H19.5V23.25H17.625V21.375Z"/><path fill="var(--logo-visor)" d="M6.375 8.25H8.25V10.125H6.375V8.25ZM15.75 8.25H17.625V10.125H15.75V8.25ZM6.375 10.125H8.25V12H6.375V10.125ZM15.75 10.125H17.625V12H15.75V10.125ZM2.625 13.875H21.375V15.75H2.625V13.875ZM2.625 17.625H21.375V19.5H2.625V17.625Z"/></svg>`;

// Lucide circle-x and circle-check, as the Figma banner and status icons use.
const icon = (marks: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/>${marks}</svg>`;
const failedIcon = icon(`<path d="m15 9-6 6"/><path d="m9 9 6 6"/>`);
const doneIcon = icon(`<path d="m9 12 2 2 4-4"/>`);

const statusBanner = (content: string) =>
  `<div class="banner" role="status">${doneIcon}<div>${content}</div></div>`;

// A field the page-level error is about points at it, so a screen reader reads it with the field.
const invalid = (on: boolean, describedBy = "") =>
  on
    ? ` aria-invalid="true" aria-describedby="${`error ${describedBy}`.trim()}"`
    : describedBy && ` aria-describedby="${describedBy}"`;

function layout(title: string, body: string, error?: string, wide = false) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Bee Bot</title>
<style>${styles}</style>
</head>
<body class="${wide ? "wide" : "narrow"}">
<header class="top">${logo}<span>Bee Bot</span></header>
<main>
${wide ? "" : `<div class="card">`}
<h1>${escapeHtml(title)}</h1>
${error ? `<div class="banner" role="alert" id="error">${failedIcon}<div><p><strong>${escapeHtml(error)}</strong></p></div></div>` : ""}
${body}
${wide ? "" : `</div>`}
</main>
</body>
</html>`;
}

export const loginPage = (next: string, error?: string, badCredentials = false) =>
  layout(
    "Sign in",
    `<p class="lede">Use the email and password from your invite.</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<div class="field"><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus${invalid(badCredentials)}></div>
<div class="field"><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required${invalid(badCredentials)}></div>
<button class="primary" type="submit">Sign in</button>
</form>`,
    error,
  );

export const invitePage = (email: string, error?: string) =>
  layout(
    "Set your password",
    `<p class="lede">Your account will be <strong>${escapeHtml(email)}</strong>.</p>
<form method="post">
<input type="hidden" name="email" value="${escapeHtml(email)}" autocomplete="username">
<div class="field"><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus${invalid(Boolean(error), "password-hint")}>
<small id="password-hint">At least 8 characters.</small></div>
<button class="primary" type="submit">Create account</button>
</form>`,
    error,
  );

export const messagePage = (title: string, message: string) =>
  layout(title, `<p>${escapeHtml(message)}</p><p><a href="/login">Sign in</a></p>`);

export const logoutPage = () =>
  layout(
    "Sign out",
    `<form method="post" action="/logout"><button class="primary" type="submit">Sign out</button></form>`,
  );

const day = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const status = (tone: "ok" | "wait" | "bad" | "neutral", text: string) =>
  `<span class="status ${tone}">${escapeHtml(text)}</span>`;

const stateTones: Record<string, "ok" | "wait" | "bad"> = {
  ready: "ok",
  suspended: "wait",
  failed: "bad",
};

const cellForm = (action: string, cell: string, label: string) =>
  `<form method="post" action="/admin/users/${action}"><input type="hidden" name="cell" value="${escapeHtml(cell)}"><button class="small" type="submit">${label}</button></form>`;

export const usersPage = (
  users: Array<UserRow & { unit: string; answering: boolean }>,
  selfCell: string,
  { invite, error, field }: { invite?: string; error?: string; field?: "email" } = {},
) =>
  layout(
    "Users",
    `<a class="back" href="/">Back to Bee Bot</a>
${
  invite
    ? statusBanner(
        `<label for="invite-url">Invite link. It is shown only once, so copy it now.</label><input id="invite-url" readonly value="${escapeHtml(invite)}">`,
      )
    : ""
}
<div class="table" role="region" aria-label="Users and their cells" tabindex="0"><table>
<thead><tr><th scope="col">Email</th><th scope="col">Cell</th><th scope="col">Admin</th><th scope="col">State</th><th scope="col">Created</th><th scope="col">Unit</th><th scope="col">Socket</th><th scope="col">Actions</th></tr></thead>
<tbody>
${users
  .map(
    (user) => `<tr>
<td>${escapeHtml(user.email).replace("@", "<wbr>@")}</td>
<td><code>${escapeHtml(user.cell)}</code></td>
<td>${user.admin ? "yes" : "no"}</td>
<td>${status(stateTones[user.state] ?? "neutral", user.state)}${user.error ? `: ${escapeHtml(user.error)}` : ""}</td>
<td>${day(user.createdAt)}</td>
<td>${status(user.unit === "active" ? "ok" : user.unit === "failed" ? "bad" : "neutral", user.unit)}</td>
<td>${user.answering ? status("ok", "answering") : status(user.unit === "active" ? "bad" : "neutral", "not answering")}</td>
<td><div class="actions">${
      user.cell === selfCell
        ? `<span class="you">you</span>`
        : user.state === "suspended"
          ? cellForm("resume", user.cell, "Resume")
          : cellForm("suspend", user.cell, "Suspend")
    } <a href="/admin/users/${escapeHtml(user.cell)}" aria-label="Manage ${escapeHtml(user.email)}">Manage</a></div></td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table></div>
<section class="card invite" aria-labelledby="invite-heading">
<h2 id="invite-heading">Invite someone</h2>
<form method="post" action="/admin/invites">
<div class="field"><label for="email">Email</label>
<input id="email" name="email" type="email" required${invalid(field === "email")}></div>
<div class="check"><input id="admin" name="admin" type="checkbox" value="true"><label for="admin">Admin</label></div>
<button class="primary" type="submit">Create invite link</button>
</form>
</section>`,
    error,
    true,
  );

export type QuotaValues = {
  memory: string;
  cpu: string;
  tasks: string;
  // Blank when unset: beebotd's default box cap, and no budget.
  boxes: string;
  "budget-usd": string;
};

export const userPage = (
  user: { email: string; cell: string; state: string },
  unit: string,
  quota: QuotaValues,
  { error, saved, field }: { error?: string; saved?: boolean; field?: "confirm" } = {},
) => {
  const quotaField = (
    name: keyof QuotaValues,
    label: string,
    pattern: string,
    hint: string,
    required = true,
  ) =>
    `<div class="field"><label for="${name}">${label}</label>
<input id="${name}" name="${name}" value="${escapeHtml(quota[name])}" pattern="${pattern}" aria-describedby="${name}-hint"${required ? " required" : ""}>
<small id="${name}-hint">${hint}</small></div>`;
  return layout(
    user.email,
    `<a class="back" href="/admin">All users</a>
${saved ? statusBanner(`<p>Quota saved.</p>`) : ""}
<p class="facts"><span>Cell <code>${escapeHtml(user.cell)}</code></span><span>State <strong>${escapeHtml(user.state)}</strong></span><span>Unit <strong>${escapeHtml(unit)}</strong></span></p>
<section class="card" aria-labelledby="quota-heading">
<h2 id="quota-heading">Quota</h2>
<form method="post" action="/admin/users/quota">
<input type="hidden" name="cell" value="${escapeHtml(user.cell)}">
<div class="grid">
${quotaField("memory", "Memory", "[1-9][0-9]{0,5}[KMGT]", "Like 4G or 512M.")}
${quotaField("cpu", "CPU", "[1-9][0-9]{0,4}%?", "Percent of one core, like 200%.")}
${quotaField("tasks", "Tasks", "[1-9][0-9]{0,6}", "Most processes and threads at once.")}
${quotaField("boxes", "Boxes", "[1-9][0-9]{0,2}", "Most boxes running at once. Blank uses the default.", false)}
${quotaField("budget-usd", "Budget (USD)", "(0|[1-9][0-9]{0,6})([.][0-9]{1,2})?", "Monthly API-key spending limit in dollars. Blank means no limit.", false)}
</div>
<button class="primary" type="submit">Save quota</button>
</form>
</section>
<section class="card danger-zone" aria-labelledby="delete-heading">
<h2 id="delete-heading">Delete</h2>
<form method="post" action="/admin/users/delete">
<input type="hidden" name="cell" value="${escapeHtml(user.cell)}">
<p>This removes the account and everything in its cell. It can't be undone.</p>
<div class="field"><label for="confirm">Type ${escapeHtml(user.email)} to confirm</label>
<input id="confirm" name="confirm" autocomplete="off" required${invalid(field === "confirm")}></div>
<button class="danger" type="submit">Delete user and their data</button>
</form>
</section>`,
    error,
    true,
  );
};
