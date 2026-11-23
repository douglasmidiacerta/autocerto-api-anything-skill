#!/usr/bin/env node
/**
 * Syncs AutoCerto's ASP.NET MVC __RequestVerificationToken (form token)
 * from GET https://sistema.autocerto.com/Lead/Lista into api-anything's
 * sealed local session (~/.api-anything/sessions/autocerto.json) under
 * values.requestVerificationToken (bound to sistema.autocerto.com).
 *
 * Security: Never prints cookies or token values.
 */
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = "autocerto";
const TARGET_URL = "https://sistema.autocerto.com/Lead/Lista";
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function findApiAnythingDist() {
  const candidates = [];

  if (process.env.API_ANYTHING_DIST) {
    candidates.push(process.env.API_ANYTHING_DIST);
  }
  if (process.env.PREFIX) {
    candidates.push(join(process.env.PREFIX, "lib", "node_modules", "api-anything", "dist"));
  }

  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (npmRoot) candidates.push(join(npmRoot, "api-anything", "dist"));
  } catch {
    // ignore
  }

  try {
    const binPath = execFileSync("which", ["api-anything"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (binPath) {
      const real = realpathSync(binPath);
      const binDir = dirname(real);
      candidates.push(resolve(binDir, "..", "lib", "node_modules", "api-anything", "dist"));
      candidates.push(resolve(binDir, "..", "dist"));
    }
  } catch {
    // ignore
  }

  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "session.js"))) {
      return dir;
    }
  }

  throw new Error(
    "Could not locate api-anything dist/session.js. Set API_ANYTHING_DIST or install api-anything globally."
  );
}

async function main() {
  const distDir = findApiAnythingDist();
  const { loadSession, mergeCapture, cookieHeaderFor, parseSetCookie } = await import(
    pathToFileURL(join(distDir, "session.js")).href
  );

  const session = loadSession(SITE);
  const cookies = session.cookies || [];
  const hasAuthCookie = cookies.some((c) => c.name === ".AspNet.ApplicationCookie");
  if (!hasAuthCookie) {
    console.error(
      'ERROR: No active AutoCerto session found (.AspNet.ApplicationCookie missing).\nRun: api-anything login autocerto --cookies /path/to/autocerto-cookies.json'
    );
    process.exit(1);
  }

  const cookieHeader = cookieHeaderFor(cookies, TARGET_URL);
  const res = await fetch(TARGET_URL, {
    method: "GET",
    redirect: "manual",
    headers: {
      cookie: cookieHeader,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "pt-BR,pt;q=0.9",
      "user-agent": USER_AGENT,
    },
  });

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    console.error(`ERROR: Redirected (${res.status}) to ${loc || "login"} — AutoCerto session expired. Re-import cookies.`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`ERROR: GET ${TARGET_URL} returned HTTP ${res.status}.`);
    process.exit(1);
  }

  const html = await res.text();
  const match =
    html.match(/<input[^>]+name=["']__RequestVerificationToken["'][^>]+value=["']([^"']+)["']/i) ||
    html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']__RequestVerificationToken["']/i);

  if (!match || !match[1]) {
    console.error(
      "ERROR: Could not find __RequestVerificationToken input on /Lead/Lista. Session may be expired or logged out."
    );
    process.exit(1);
  }

  const token = match[1];
  const rawSetCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const rotatedCookies = rawSetCookies
    .map((line) => parseSetCookie(line, TARGET_URL))
    .filter(Boolean);

  mergeCapture(
    SITE,
    rotatedCookies,
    {
      from: TARGET_URL,
      values: { requestVerificationToken: token },
    },
    {
      settings: [],
      urls: [TARGET_URL],
    }
  );

  console.log(`OK: Synced AutoCerto anti-forgery token into local session (length: ${token.length}, host-bound to sistema.autocerto.com).`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
