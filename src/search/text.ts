const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o",
  "que", "con", "para", "por", "en", "del", "al", "es", "son", "hay",
  "tienen", "tiene", "tienes", "algo", "algun", "alguna", "quiero", "busco",
]);

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && (word.length > 2 || /^\d+$/.test(word)) && !STOPWORDS.has(word));
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
