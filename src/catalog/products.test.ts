import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  searchProducts,
  findConfidentProductMatch,
  createProduct,
  createProductVariant,
  updateProductVariant,
  deleteProductVariant,
  listActiveProducts,
  findProductsByAttributes,
  textMentionsConfiguredCategory,
} from "./products";

let businessId: string;
let productId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;

  const product = await prisma.product.create({
    data: {
      businessId,
      name: "Parlante Boombox 4 LED",
      description: "Sonido potente con luces LED, ideal para fiestas y envíos rápidos",
      price: 125000,
      currency: "COP",
      stock: 3,
    },
  });
  productId = product.id;
});

after(async () => {
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("searchProducts matches an unaccented query against accented stored text", async () => {
  // Same class of bug as catalog/faq.ts: a SQL `contains` filter wouldn't strip accents, so
  // "envios" (typed by a customer) used to miss text stored as "envíos".
  const results = await searchProducts(businessId, "envios");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, productId);
});

test("searchProducts returns nothing for a query that matches no product", async () => {
  const results = await searchProducts(businessId, "refrigerador industrial");
  assert.equal(results.length, 0);
});

// Reliability plan Phase 3, item 4 (2026-09-13): relevanceScore used to check `category.includes(token)`
// as a raw substring, not a whole-word match - a query token as short as "pro" silently matched any
// category string containing "producto" (an extremely common Spanish category label meaning "product"),
// returning a completely unrelated item as if the customer had actually searched for something matching
// its name or category.
test("searchProducts does not false-match a short query token against an unrelated word that merely contains it", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await prisma.product.create({
    data: {
      businessId: business.id,
      name: "Camiseta Basica",
      description: "Camiseta comoda de algodon",
      category: "Producto General",
      price: 20000,
      currency: "COP",
      stock: 10,
    },
  });

  try {
    // "pro" is a real 3-letter token (tokenize keeps 3+ char words) that is a SUBSTRING of "Producto" but
    // not a whole word match against anything on this product - must return nothing.
    const results = await searchProducts(business.id, "pro");
    assert.equal(results.length, 0);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

// Same gap as the CategoryAlias fix for findProductsByAttributes, threaded through search_products too -
// a customer hitting the free-text search path (not the attribute filter) with a business-specific
// category synonym used to get zero results even though the real category matches once the synonym is
// resolved.
test("searchProducts resolves a business's own CategoryAlias synonym, not just the literal category word", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.categoryAlias.create({
      data: { businessId: business.id, canonical: "Smartwatches", synonym: "reloj", normalizedSynonym: "reloj" },
    });
    await prisma.product.create({
      data: {
        businessId: business.id,
        name: "Serie X Deportivo",
        description: "Pantalla tactil, resistente al agua",
        category: "Smartwatches",
        price: 150000,
        currency: "COP",
        stock: 4,
      },
    });

    const results = await searchProducts(business.id, "reloj");
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "Serie X Deportivo");
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.categoryAlias.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

// Regression coverage for the "bot sends the wrong product's photos" bug: a vision-derived description
// of one product can share a single incidental word (a color, a material) with a totally unrelated
// catalog product's description. Under the old `matches[0]` (score > 0, no floor) logic, a product that
// only matched on that one shared word was indistinguishable from a real match. The confident matcher
// must refuse to act on that kind of weak, single-word-only evidence instead of guessing.
test("findConfidentProductMatch correctly picks the real match over an unrelated product sharing one word", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const headphones = await prisma.product.create({
    data: {
      businessId: business.id,
      name: "Audifonos Over-Ear Pro Max",
      description: "Auriculares inalambricos color negro, banda acolchada, sonido envolvente",
      price: 180000,
      currency: "COP",
      stock: 2,
    },
  });
  await prisma.product.create({
    data: {
      businessId: business.id,
      name: "Smartwatch Serie 11 Mini",
      description: "Reloj inteligente compacto, correa de silicona color negro",
      price: 145000,
      currency: "COP",
      stock: 5,
    },
  });

  try {
    const result = await findConfidentProductMatch(
      business.id,
      "auriculares inalambricos negro con banda acolchada sobre las orejas"
    );
    assert.equal(result.ambiguous, false);
    assert.equal(result.product?.id, headphones.id);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findConfidentProductMatch refuses to guess when the only evidence is one shared description word", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  // Only product in the catalog is the watch - the query describes something else entirely (a cap) that
  // happens to share the word "negra" with the watch's description, nothing else. Under the old
  // `score > 0` rule this single-word hit was enough for matches[0] to confidently return the watch.
  await prisma.product.create({
    data: {
      businessId: business.id,
      name: "Smartwatch Serie 11 Mini",
      description: "Reloj inteligente compacto, correa de silicona negra",
      price: 145000,
      currency: "COP",
      stock: 5,
    },
  });

  try {
    const result = await findConfidentProductMatch(business.id, "gorra negra de algodon");
    assert.equal(result.product, null);
    assert.equal(result.ambiguous, false);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findConfidentProductMatch flags an ambiguous tie instead of silently picking one", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await prisma.product.create({
    data: {
      businessId: business.id,
      name: "Smartwatch Serie 11 Mini Negro",
      description: "Version negra",
      price: 145000,
      currency: "COP",
      stock: 5,
    },
  });
  await prisma.product.create({
    data: {
      businessId: business.id,
      name: "Smartwatch Serie 11 Mini Azul",
      description: "Version azul",
      price: 145000,
      currency: "COP",
      stock: 5,
    },
  });

  try {
    const result = await findConfidentProductMatch(business.id, "smartwatch serie 11 mini");
    assert.equal(result.product, null);
    assert.equal(result.ambiguous, true);
    assert.equal(result.candidates?.length, 2);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findConfidentProductMatch matches confidently on a clear catalog name hit", async () => {
  const result = await findConfidentProductMatch(businessId, "boombox");
  assert.equal(result.ambiguous, false);
  assert.equal(result.product?.id, productId);
});

// Coverage for the ProductVariant layer added for the category/color/talla plan (2026-09-12): a product
// sold in several colors/sizes under one name, each with its own stock, independent of the simple
// single-color case (Product.color/size directly).
test("createProductVariant/updateProductVariant/deleteProductVariant manage a color+size sub-item", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const product = await createProduct(business.id, {
      name: "Diadema M4",
      description: "Diadema bluetooth disponible en varios colores",
      price: 45000,
      currency: "COP",
      stock: 0,
    });

    const variant = await createProductVariant(business.id, product.id, { color: "Rojo", stock: 2 });
    assert.equal(variant.color, "Rojo");
    assert.equal(variant.stock, 2);

    const updated = await updateProductVariant(business.id, variant.id, { stock: 5 });
    assert.equal(updated.stock, 5);

    const [withVariants] = await listActiveProducts(business.id);
    assert.equal(withVariants.variants.length, 1);
    assert.equal(withVariants.variants[0].id, variant.id);

    await deleteProductVariant(business.id, variant.id);
    const [afterDelete] = await listActiveProducts(business.id);
    assert.equal(afterDelete.variants.length, 0);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("createProductVariant refuses a variant for a product belonging to a different business", async () => {
  const otherBusiness = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await assert.rejects(() => createProductVariant(otherBusiness.id, productId, { color: "Azul", stock: 1 }));
  } finally {
    await prisma.business.delete({ where: { id: otherBusiness.id } });
  }
});

// Coverage for find_products_by_attributes (2026-09-12 plan): the deterministic filter meant to replace
// "reloj negro also returns airpods and non-black watches", a real reported bug caused by the media
// backstop's prose scan matching any product NAME mentioned in text regardless of color/category.
test("findProductsByAttributes: category+color only returns products that actually match both, not the whole catalog", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.product.createMany({
      data: [
        { businessId: business.id, name: "Smartwatch Serie 11", description: "Reloj negro elegante", price: 100000, currency: "COP", stock: 5, category: "reloj", color: "Negro" },
        { businessId: business.id, name: "Smartwatch Gen 9", description: "Reloj disponible en color oscuro", price: 80000, currency: "COP", stock: 5, category: "reloj", color: "Oscuro" },
        { businessId: business.id, name: "Smartwatch V20", description: "Reloj deportivo", price: 90000, currency: "COP", stock: 5, category: "reloj", color: "Azul" },
        { businessId: business.id, name: "Airpods Pro 2", description: "Audifonos inalambricos negros", price: 60000, currency: "COP", stock: 5, category: "audifonos", color: "Negro" },
      ],
    });

    const result = await findProductsByAttributes(business.id, { category: "reloj", color: "negro" });
    assert.equal(result.matches.length, 2, "must match the two black/dark watches, not the blue one or the headphones");
    const names = result.matches.map((m) => m.productName).sort();
    assert.deepEqual(names, ["Smartwatch Gen 9", "Smartwatch Serie 11"]);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findProductsByAttributes: matches a compound real-world category string, not just an exact single-word category", async () => {
  // Real production bug (2026-09-13): a business's actual Product.category is free text and often
  // compound ("Tecnología / Relojes Inteligentes (Smartwatches)"), never just "reloj" - comparing the
  // whole string against the target word after singularizing silently returned zero matches for every
  // category-scoped color search, which pushed the model to a full-catalog fallback where it then
  // sent/listed products of the wrong color (a gold watch, a pair of airpods) as if they were black.
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.product.createMany({
      data: [
        {
          businessId: business.id,
          name: "Smartwatch Serie 11",
          description: "Reloj negro elegante",
          price: 100000,
          currency: "COP",
          stock: 5,
          category: "Tecnología / Relojes Inteligentes (Smartwatches)",
          color: "Negro",
        },
        {
          businessId: business.id,
          name: "Smartwatch Gen 9",
          description: "Reloj elegante",
          price: 80000,
          currency: "COP",
          stock: 5,
          category: "Tecnología (smartwatch)",
          color: "Dorado",
        },
        {
          businessId: business.id,
          name: "Airpods Serie 4",
          description: "Audifonos negros",
          price: 60000,
          currency: "COP",
          stock: 5,
          category: "Tecnologia (Audifonos)",
          color: "Negro",
        },
      ],
    });

    const result = await findProductsByAttributes(business.id, { category: "reloj", color: "negro" });
    assert.equal(result.matches.length, 1, "must match only the black watch, not the gold watch or the black headphones");
    assert.equal(result.matches[0].productName, "Smartwatch Serie 11");
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findProductsByAttributes: a business's own CategoryAlias links a vertical-specific synonym to its real category word", async () => {
  // Confirms the actual fix for the compound-category gap above is per-business configured data, never a
  // hardcoded vertical vocabulary - the same mechanism has to work for ANY business's own words (a fruit
  // stand's "guineo"/"banano" is used here specifically to prove this isn't secretly electronics-only).
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.categoryAlias.create({
      data: { businessId: business.id, canonical: "banano", synonym: "guineo", normalizedSynonym: "guineo" },
    });
    await prisma.product.createMany({
      data: [
        { businessId: business.id, name: "Guineo criollo", description: "Fruta fresca", price: 2000, currency: "COP", stock: 50, category: "Bananos" },
        { businessId: business.id, name: "Manzana roja", description: "Fruta fresca", price: 3000, currency: "COP", stock: 20, category: "Manzanas" },
      ],
    });

    const result = await findProductsByAttributes(business.id, { category: "guineo" });
    assert.equal(result.matches.length, 1, "the alias should resolve 'guineo' to the product categorized as 'Bananos'");
    assert.equal(result.matches[0].productName, "Guineo criollo");
  } finally {
    await prisma.categoryAlias.deleteMany({ where: { businessId: business.id } });
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findProductsByAttributes: a variant-level match returns only that variant, not the whole product's other colors", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const product = await createProduct(business.id, {
      name: "Diadema M4",
      description: "Diadema bluetooth disponible en varios colores",
      price: 45000,
      currency: "COP",
      stock: 0,
      category: "diademas",
    });
    const red = await createProductVariant(business.id, product.id, { color: "Rojo", stock: 2 });
    await createProductVariant(business.id, product.id, { color: "Amarillo", stock: 1 });
    await createProductVariant(business.id, product.id, { color: "Verde", stock: 3 });

    const result = await findProductsByAttributes(business.id, { color: "rojo" });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].variantId, red.id);
    assert.equal(result.matches[0].variantLabel, "Rojo");
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

// The "el rosadito" example from the plan: a bare color with no category, present across several
// categories, must come back flagged as spanning categories so the caller asks instead of guessing.
test("findProductsByAttributes: a color with no category, present in several categories, reports categoriesFound", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.product.createMany({
      data: [
        { businessId: business.id, name: "Audifonos Bluetooth X", description: "Disponibles", price: 40000, currency: "COP", stock: 5, category: "audifonos", color: "Rosado" },
        { businessId: business.id, name: "Diadema Basica", description: "Disponible", price: 20000, currency: "COP", stock: 5, category: "diademas", color: "Rosadito" },
        { businessId: business.id, name: "Smartwatch Kids", description: "Disponible", price: 50000, currency: "COP", stock: 5, category: "smartwatch", color: "Fucsia" },
      ],
    });

    const result = await findProductsByAttributes(business.id, { color: "rosadito" });
    assert.equal(result.matches.length, 3);
    assert.deepEqual(new Set(result.categoriesFound), new Set(["audifonos", "diademas", "smartwatch"]));
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

// Real production incident, MAG.IMP, 2026-09-13: a customer asked for "relojes grises" and the bot
// listed "Combo Pareja" as one of the gray options - it has no color field and no variants, and its
// description is marketing prose listing 7 interchangeable pulsera colors as bundle CONTENTS ("incluye
// pulsos en Metalico Plateado, Cuero Marron, Silicona Azul/Negra/Morada/Gris/Blanca"), not the product's
// own color. Scanning that description made it match almost any color query. It must only match a color
// query via its dedicated color field or its name, never free-form description prose.
test("findProductsByAttributes: a bundle product whose description lists many colors as CONTENTS does not match every color query", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.product.create({
      data: {
        businessId: business.id,
        name: "Combo Pareja",
        description:
          "Incluye pulsos en acabado Metalico Plateado, Cuero Marron, Silicona Azul/Negra/Morada/Gris/Blanca y Nylon.",
        price: 250000,
        currency: "COP",
        stock: 3,
        category: "combos",
      },
    });

    const grisResult = await findProductsByAttributes(business.id, { color: "gris" });
    assert.equal(grisResult.matches.length, 0, "must not match 'gris' just because the description lists it as a bundled strap color");

    const rojoResult = await findProductsByAttributes(business.id, { color: "rojo" });
    assert.equal(rojoResult.matches.length, 0, "must not match every other color mentioned in the description either");
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("findProductsByAttributes: refuses to dump the whole catalog when neither color nor category is given", async () => {
  const result = await findProductsByAttributes(businessId, {});
  assert.deepEqual(result, { matches: [], categoriesFound: [] });
});

test("createProduct stores color and size for the simple single-variant case", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const product = await createProduct(business.id, {
      name: "Camiseta basica",
      description: "Camiseta de algodon",
      price: 35000,
      currency: "COP",
      stock: 10,
      color: "Negro",
      size: "M",
    });
    assert.equal(product.color, "Negro");
    assert.equal(product.size, "M");
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

// Reliability plan Phase 4 (2026-09-13): textMentionsConfiguredCategory is the classifier agent.ts uses
// to decide whether to force tool_choice toward find_products_by_attributes for a "color negro" style
// message - must recognize this business's REAL category words (and their aliases), never a hardcoded
// vertical vocabulary, and must not false-fire on an unrelated word.
test("textMentionsConfiguredCategory: recognizes a real category word from this business's own catalog", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.product.create({
      data: {
        businessId: business.id,
        name: "Serie X",
        description: "Reloj inteligente",
        category: "Smartwatches",
        price: 100000,
        currency: "COP",
        stock: 3,
      },
    });

    assert.equal(await textMentionsConfiguredCategory(business.id, "quiero un smartwatch negro"), true);
    assert.equal(await textMentionsConfiguredCategory(business.id, "tienen audifonos rojos"), false);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("textMentionsConfiguredCategory: recognizes a CategoryAlias synonym, not just the literal category word", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await prisma.categoryAlias.create({
      data: { businessId: business.id, canonical: "Smartwatches", synonym: "reloj", normalizedSynonym: "reloj" },
    });
    await prisma.product.create({
      data: {
        businessId: business.id,
        name: "Serie X",
        description: "Reloj inteligente",
        category: "Smartwatches",
        price: 100000,
        currency: "COP",
        stock: 3,
      },
    });

    assert.equal(await textMentionsConfiguredCategory(business.id, "quiero un reloj negro"), true);
  } finally {
    await prisma.product.deleteMany({ where: { businessId: business.id } });
    await prisma.categoryAlias.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
});

test("textMentionsConfiguredCategory: false when the business has no products/categories at all", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    assert.equal(await textMentionsConfiguredCategory(business.id, "quiero un reloj negro"), false);
  } finally {
    await prisma.business.delete({ where: { id: business.id } });
  }
});
