export type PageSignals = {
  url: string;
  title: string;
  text: string;
  frames: string[];
  passwordField: boolean;
};

const captchaFrames =
  /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|turnstile|arkoselabs\.com|funcaptcha|captcha-delivery\.com/i;
const captchaTitles =
  /just a moment|attention required|verify you are (a )?human|are you a robot|security check/i;
const captchaText =
  /verify you are (a )?human|i'm not a robot|unusual traffic from your|complete the security check|press (&|and) hold/i;
const loginPaths = /\/(log-?in|sign-?in|sign_in|signon|auth(enticate)?|sso|session\/new)(\/|$|\.)/i;
const loginHosts =
  /^(accounts\.google\.com|login\.(live|microsoftonline)\.com|appleid\.apple\.com)$/i;

// Heuristics, so a miss only means the bot gets the page and a false alarm only asks the owner.
export function detectChallenge(page: PageSignals) {
  if (
    page.frames.some((src) => captchaFrames.test(src)) ||
    captchaTitles.test(page.title) ||
    captchaText.test(page.text.slice(0, 5000))
  ) {
    return "captcha" as const;
  }
  const url = URL.parse(page.url);
  if (
    page.passwordField ||
    (url && (loginHosts.test(url.hostname) || loginPaths.test(url.pathname)))
  ) {
    return "login" as const;
  }
  return null;
}
