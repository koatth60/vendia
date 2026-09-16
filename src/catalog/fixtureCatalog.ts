import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScopeMedia, ScopeProduct, ScopeVariant } from "./scope";

// Adaptador de prueba: convierte el catalogo anonimizado de produccion
// (src/ai/regression/fixtures/catalog.json, el mismo que usa la suite de regresion) en los productos
// que esperan resolveProductScopeFrom y renderCatalog. Asi las pruebas de la Fase B corren contra
// catalogos REALES - incluidos los dos negocios cuyas conversaciones motivaron esta fase - sin base de
// datos, sin red y sin modelo.
//
// El fixture no trae ids ni URLs de S3 (no las necesita para lo que probaba antes): los ids se derivan
// del nombre, de forma estable, y los medios se sintetizan a partir de mediaCount, que es el unico dato
// de medios del que dependen el alcance y el presentador.

interface FixtureVariant {
  color: string | null;
  size: string | null;
  stock: number;
  active: boolean;
  mediaCount?: number;
}

interface FixtureProduct {
  name: string;
  description: string;
  price: string;
  currency: string;
  stock: number;
  category: string | null;
  active: boolean;
  mediaCount: number;
  variants?: FixtureVariant[];
}

interface FixtureBusiness {
  id: string;
  name: string;
  products: FixtureProduct[];
}

const FIXTURE_PATH = join(__dirname, "..", "ai", "regression", "fixtures", "catalog.json");

// Sin expresion regular, igual que el resto del modulo: la regla del repositorio aplica tambien aca,
// aunque sea codigo de prueba - no hace falta una para convertir un nombre en un id estable.
function fakeId(prefix: string, name: string): string {
  const slug = [...name.toLowerCase()]
    .map((ch) => ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") ? ch : "-"))
    .join("")
    .slice(0, 40);
  return `${prefix}-${slug}`;
}

function fakeMedia(ownerId: string, count: number): ScopeMedia[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "IMAGE",
    url: `https://example.invalid/${ownerId}/${i}.jpg`,
    s3Key: `${ownerId}/${i}.jpg`,
  }));
}

export function loadFixtureCatalog(businessName: string): ScopeProduct[] {
  const businesses = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as FixtureBusiness[];
  const business = businesses.find((b) => b.name === businessName);
  if (!business) throw new Error(`El fixture de catalogo no tiene un negocio llamado "${businessName}"`);

  return business.products
    .filter((p) => p.active)
    .map((product) => {
      const id = fakeId("prod", product.name);
      const variants: ScopeVariant[] = (product.variants ?? []).map((variant, i) => {
        const variantId = `${id}-var-${i}`;
        return {
          id: variantId,
          color: variant.color,
          size: variant.size,
          active: variant.active,
          stock: variant.stock,
          media: fakeMedia(variantId, variant.mediaCount ?? 0),
        };
      });
      return {
        id,
        name: product.name,
        description: product.description,
        category: product.category,
        color: null,
        size: null,
        price: Number(product.price),
        currency: product.currency,
        stock: product.stock,
        media: fakeMedia(id, product.mediaCount),
        variants,
      } satisfies ScopeProduct;
    });
}

export function productNamed(products: ScopeProduct[], fragment: string): ScopeProduct {
  const found = products.find((p) => p.name.toLowerCase().includes(fragment.toLowerCase()));
  if (!found) throw new Error(`El fixture no tiene ningun producto cuyo nombre contenga "${fragment}"`);
  return found;
}
