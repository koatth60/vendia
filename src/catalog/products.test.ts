import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { searchProducts } from "./products";

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
