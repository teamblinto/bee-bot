// What an engine on this machine needs to find its tools, its home and the network. Anything else in
// beebotd's environment, such as a vault key, a cloud or GitHub token, or BEEBOT_ internals, stays
// out: an engine gets a named list, never the parent minus a few names. Matched case-insensitively,
// as Windows treats names.
const passed = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SSH_AUTH_SOCK",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "COMPUTERNAME",
  ].map((name) => name.toUpperCase()),
);
const passedPrefix = /^(LC_|XDG_)/i;

export function engineEnv(parent: NodeJS.ProcessEnv, also: readonly string[] = []) {
  const extra = new Set(also.map((name) => name.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    const upper = name.toUpperCase();
    if (value !== undefined && (passed.has(upper) || extra.has(upper) || passedPrefix.test(name))) {
      env[name] = value;
    }
  }
  return env;
}
