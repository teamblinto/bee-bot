import { describe, expect, it } from "vite-plus/test";

import { detectChallenge, type PageSignals } from "./browserChallenge.ts";

const page = (signals: Partial<PageSignals>): PageSignals => ({
  url: "https://example.com/",
  title: "Example Domain",
  text: "This domain is for use in examples.",
  frames: [],
  passwordField: false,
  ...signals,
});

describe("challenge detection", () => {
  it("leaves an ordinary page alone", () => {
    expect(detectChallenge(page({}))).toBeNull();
    expect(detectChallenge(page({ url: "https://example.com/blog/login-tips-2026" }))).toBeNull();
    expect(detectChallenge(page({ url: "https://example.com/authors" }))).toBeNull();
  });

  it.each([
    { frames: ["https://www.google.com/recaptcha/api2/anchor?k=x"] },
    { frames: ["https://newassets.hcaptcha.com/captcha/v1/abc"] },
    { frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile"] },
    { title: "Just a moment..." },
    { text: "Our systems have detected unusual traffic from your computer network." },
    { text: "Please verify you are a human" },
  ])("sees a captcha in %o", (signals) => {
    expect(detectChallenge(page(signals))).toBe("captcha");
  });

  it.each([
    { passwordField: true },
    { url: "https://accounts.google.com/v3/signin/identifier" },
    { url: "https://github.com/login" },
    { url: "https://example.com/users/sign_in?return=/" },
    { url: "https://shop.example/account/signin.html" },
  ])("sees a sign-in wall in %o", (signals) => {
    expect(detectChallenge(page(signals))).toBe("login");
  });

  it("calls a captcha on a sign-in page a captcha, since that is what blocks", () => {
    expect(detectChallenge(page({ passwordField: true, title: "Attention Required!" }))).toBe(
      "captcha",
    );
  });
});
