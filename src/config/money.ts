// Fase 11 del plan maestro (2026-09-15): formatCopPrice (catalog/products.ts) era literalmente
// `toLocaleString("es-CO")` - un negocio mexicano leia "145.000" donde su cliente espera "145,000".
// Esta es su version por moneda y locale, que es lo unico que cambiaba entre paises.
//
// Deliberadamente NO imprime el simbolo de moneda: los callers (el prompt, los bloques fijos, las fichas
// de producto) ya escriben "$" o el codigo de moneda por su cuenta, y meterlo aca cambiaria el texto de
// cada mensaje que hoy sale bien. Solo resuelve el separador de miles y los decimales.

// COP y CLP no usan centavos; MXN, USD y EUR si. Redondear un precio en MXN a entero mostraria "1,234"
// donde el catalogo dice 1234.50.
const ZERO_DECIMAL_CURRENCIES = new Set(["COP", "CLP", "PYG", "JPY", "KRW"]);

export function formatPrice(amount: number | { toString(): string }, currency: string, locale: string): string {
  const value = typeof amount === "number" ? amount : Number(amount.toString());
  if (!Number.isFinite(value)) return String(amount);
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
  return value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
