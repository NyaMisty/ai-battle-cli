import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(__dirname, "..", "locales");

export type Locale = "en" | "zh-CN" | "zh-TW" | "ja" | "ko";

const bundles = new Map<string, Record<string, unknown>>();
for (const file of fs.readdirSync(localesDir).filter(f => f.endsWith(".json"))) {
  const locale = file.replace(".json", "");
  bundles.set(locale, JSON.parse(fs.readFileSync(path.join(localesDir, file), "utf-8")));
}

/** Parse language string → Locale (works for Accept-Language header, LANG env, etc.) */
export function parseLocale(lang?: string): Locale {
  const l = (lang ?? "").toLowerCase().replace(/_/g, "-");
  if (l.startsWith("zh-tw") || l.startsWith("zh-hant")) return "zh-TW";
  if (l.startsWith("zh")) return "zh-CN";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  return "en";
}

/** Detect system locale from AI_BATTLE_LANG/LANG/LC_ALL env */
let _locale: Locale = parseLocale(process.env.AI_BATTLE_LANG || process.env.LC_ALL || process.env.LANG || "en");

/** Get current default locale */
export function getLocale(): Locale { return _locale; }

/** Override default locale (useful for tests) */
export function setLocale(locale: Locale): void { _locale = locale; }

/** Get translation by dot-path key, e.g. t("roomNotFound", "zh-CN") */
export function t(key: string, lng: Locale = _locale): string {
  const bundle = bundles.get(lng) ?? bundles.get("en")!;
  const parts = key.split(".");
  let val: unknown = bundle;
  for (const p of parts) {
    if (val == null || typeof val !== "object") break;
    val = (val as Record<string, unknown>)[p];
  }
  if (typeof val === "string") return val;
  // fallback to English
  val = bundles.get("en")!;
  for (const p of parts) {
    if (val == null || typeof val !== "object") break;
    val = (val as Record<string, unknown>)[p];
  }
  return typeof val === "string" ? val : key;
}

/** Get spectate page i18n JSON string */
export function getSpectateI18n(locale: Locale): string {
  const bundle = bundles.get(locale) ?? bundles.get("en")!;
  return JSON.stringify((bundle as any).spectate ?? {});
}
