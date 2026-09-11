import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { searchProducts, findConfidentProductMatch } from "./products";

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
