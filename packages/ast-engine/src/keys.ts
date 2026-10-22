/** camelCase key suggestion from visible text; ASCII words only, stable for identical input. */
export function suggestKey(text: string, taken: (k: string) => boolean = () => false): string {
  const words = text
    .replace(/\{\{?\w+\}?\}/g, " ")
    .normalize("NFKD").replace(/[^\x00-\x7F]/g, " ")
    .replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  let base = words.length
    ? words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("")
    : "text";
  if (/^\d/.test(base)) base = "t" + base;
  let key = base;
  for (let i = 2; taken(key); i++) key = base + i;
  return key;
}
