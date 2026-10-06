/** Helpers the sources share for turning system records into words people use. */

const LEGAL =
  /\s+(A\.Ş\.|A\.S\.|AŞ|GmbH|S\.L\.|LLC|A\/S|S\.A\.|SAS|d\.o\.o\.|Sp\. z o\.o\.|Ltd\. Şti\.|Ltd\.|Ltd|San\. ve Tic\. A\.Ş\.|Sanayi ve Ticaret A\.Ş\.|B\.V\.|S\.p\.A\.|AB|Inc\.)$/i;

/** The names people use for a company: "Petrokim Rafineri A.Ş." → "Petrokim Rafineri", "Petrokim". */
export function shortNames(name: string): string[] {
  let base = name.trim();
  for (let i = 0; i < 3 && LEGAL.test(base); i++) base = base.replace(LEGAL, "").trim();
  const words = base.split(/\s+/);
  const out = new Set<string>();
  if (base !== name) out.add(base);
  if (words.length >= 3) out.add(words.slice(0, 2).join(" "));
  if (words.length >= 2 && words[0]!.length >= 5) out.add(words[0]!);
  out.delete(name);
  return [...out];
}

const COUNTRIES: Record<string, string> = {
  TR: "Türkiye",
  DE: "Germany",
  ES: "Spain",
  AE: "United Arab Emirates",
  RS: "Serbia",
  DK: "Denmark",
  MA: "Morocco",
  FR: "France",
  PL: "Poland",
  IT: "Italy",
  SE: "Sweden",
  NL: "Netherlands",
  GB: "United Kingdom",
};

export function countryName(code: unknown): string | undefined {
  if (typeof code !== "string" || !code) return undefined;
  return COUNTRIES[code.toUpperCase()] ?? code;
}

export function capitalize(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const text = value.replace(/_/g, " ");
  return text[0]!.toUpperCase() + text.slice(1);
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "ACP-80", "AV-50", "PS-200" from a product's description. */
export function modelCodes(description: string): string[] {
  return [...new Set(description.match(/\b[A-Z]{2,3}-\d{2,3}\b/g) ?? [])];
}

export function domainOf(value: unknown): string | undefined {
  const textValue = text(value);
  if (!textValue) return undefined;
  const host = textValue.includes("@") ? textValue.split("@")[1] : textValue.replace(/^https?:\/\//, "").split("/")[0];
  return host?.replace(/^www\./, "").toLowerCase();
}
