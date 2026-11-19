const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

function layout(title: string, body: string, error?: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Bee Bot</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 22rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input, button { box-sizing: border-box; width: 100%; padding: 0.6rem; font: inherit; margin-top: 0.25rem; }
  button { margin-top: 1.5rem; cursor: pointer; }
  [role="alert"] { border: 2px solid #c62828; padding: 0.6rem; }
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
