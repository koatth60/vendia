import { prisma } from "../db/client";
import { countryConfig, type CountryCode, type CountryConfig } from "./countries";
import type { BusinessRequirements } from "../orders/checkoutState";
import { parseBusinessHours, type BusinessHours } from "./businessHours";

// Fase 11 del plan maestro (2026-09-15): una sola lectura de "que pais/moneda/reglas tiene este negocio",
// para que ningun caller vuelva a resolverlo por su cuenta ni asuma Colombia. Todo lo que antes estaba
// cableado sale de aca.

export interface BusinessLocale {
  countryCode: CountryCode;
  country: CountryConfig;
  currency: string;
  timezone: string;
  /** Locale de formateo (Intl). Sale del pais; no es un campo propio del negocio. */
  locale: string;
  requirements: BusinessRequirements;
  businessHours: BusinessHours | null;
}

export const LOCALE_SELECT = {
  countryCode: true,
  currency: true,
  timezone: true,
  requiresIdDocument: true,
  idDocumentExemptZones: true,
  businessHours: true,
} as const;

type LocaleRow = {
  countryCode: string;
  currency: string;
  timezone: string;
  requiresIdDocument: boolean;
  idDocumentExemptZones: string[];
  businessHours: unknown;
};

// Puro, para poder probarlo sin base y para que el webhook reuse la fila de Business que ya trajo en vez
// de pedirla de nuevo.
export function toBusinessLocale(row: LocaleRow | null | undefined): BusinessLocale {
  const country = countryConfig(row?.countryCode);
  return {
    countryCode: country.code,
    country,
    currency: row?.currency || country.defaultCurrency,
    timezone: row?.timezone || country.defaultTimezone,
    locale: country.locale,
    requirements: {
      requiresIdDocument: row?.requiresIdDocument ?? country.requiresIdDocumentByDefault,
      idDocumentExemptZones: row?.idDocumentExemptZones ?? [],
    },
    businessHours: parseBusinessHours(row?.businessHours),
  };
}

export async function getBusinessLocale(businessId: string): Promise<BusinessLocale> {
  const row = await prisma.business.findUnique({ where: { id: businessId }, select: LOCALE_SELECT });
  return toBusinessLocale(row);
}
