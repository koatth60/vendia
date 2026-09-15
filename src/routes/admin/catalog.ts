import { Router } from "express";
import {
  createProduct,
  deleteProduct,
  deleteProductMedia,
  assignProductMedia,
  listAllProductsPage,
  listActiveProductsForOrderPicker,
  updateProduct,
  addProductMedia,
  createProductVariant,
  updateProductVariant,
  deleteProductVariant,
} from "../../catalog/products";
import { listCategoryAliases, createCategoryAlias, deleteCategoryAlias } from "../../catalog/categoryAliases";
import { detectProductColors } from "../../ai/colorDetection";
import { uploadMedia } from "../../media/s3";
import { requireOwner } from "../../auth/requireOwner";
import { upload, businessIdOf, isUnsupportedImageType } from "./shared";

export const catalogRouter = Router();

// Paginado (feedback del dueño, 2026-09-13: un catálogo real puede pasar de cientos de SKUs).
const PRODUCTS_PAGE_SIZE = 20;

catalogRouter.get("/api/products", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
  const { items, total } = await listAllProductsPage(businessIdOf(req), (page - 1) * PRODUCTS_PAGE_SIZE, PRODUCTS_PAGE_SIZE, q);
  res.json({ items, total, page, pageSize: PRODUCTS_PAGE_SIZE });
});

// Catálogo completo (sin paginar, sin media) para el selector de producto/variante del cierre manual de
// venta - ese formulario necesita elegir por id de una, no buscar página por página.
catalogRouter.get("/api/products/for-order-picker", async (req, res) => {
  const items = await listActiveProductsForOrderPicker(businessIdOf(req));
  res.json({ items });
});

catalogRouter.post("/api/products", async (req, res) => {
  const { name, description, price, currency, stock, category, color, size, variants } = req.body;
  const product = await createProduct(businessIdOf(req), {
    name,
    description,
    price: Number(price),
    currency,
    stock: Number(stock ?? 0),
    category: category || undefined,
    color: color || undefined,
    size: size || undefined,
    variants: Array.isArray(variants)
      ? variants.map((v: { color?: string; size?: string; stock?: number }) => ({
          color: v.color || undefined,
          size: v.size || undefined,
          stock: Number(v.stock ?? 0),
        }))
      : undefined,
  });
  res.status(201).json(product);
});

catalogRouter.put("/api/products/:id", async (req, res) => {
  const { name, description, price, currency, stock, category, color, size, active } = req.body;
  const product = await updateProduct(businessIdOf(req), String(req.params.id), {
    name,
    description,
    price: price !== undefined ? Number(price) : undefined,
    currency,
    stock: stock !== undefined ? Number(stock) : undefined,
    category: category === "" ? null : category,
    color: color === "" ? null : color,
    size: size === "" ? null : size,
    active,
  });
  res.json(product);
});

catalogRouter.delete("/api/products/:id", async (req, res) => {
  await deleteProduct(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

// Variants are optional (see ProductVariant in schema.prisma) - a business whose products don't need
// per-color/size stock+photos never touches these routes and nothing here affects their catalog.
catalogRouter.post("/api/products/:id/variants", async (req, res) => {
  const { color, size, stock } = req.body;
  const variant = await createProductVariant(businessIdOf(req), String(req.params.id), {
    color: color || undefined,
    size: size || undefined,
    stock: Number(stock ?? 0),
  });
  res.status(201).json(variant);
});

catalogRouter.put("/api/variants/:id", async (req, res) => {
  const { color, size, stock, active } = req.body;
  const variant = await updateProductVariant(businessIdOf(req), String(req.params.id), {
    color: color === "" ? null : color,
    size: size === "" ? null : size,
    stock: stock !== undefined ? Number(stock) : undefined,
    active,
  });
  res.json(variant);
});

catalogRouter.delete("/api/variants/:id", async (req, res) => {
  await deleteProductVariant(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

// Lets the admin panel suggest variant colors from a catalog photo instead of typing each one by
// hand - the owner still confirms/edits before anything is saved, this only pre-fills.
catalogRouter.post("/api/products/:id/detect-colors", async (req, res) => {
  const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : "";
  if (!imageUrl) {
    res.status(400).json({ error: "imageUrl requerido" });
    return;
  }
  const colors = await detectProductColors(businessIdOf(req), imageUrl);
  res.json({ colors });
});

catalogRouter.post("/api/products/:id/media", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  if (isUnsupportedImageType(req.file.mimetype)) {
    res.status(400).json({ error: "Formato GIF no soportado todavía - usa JPG, PNG o video." });
    return;
  }

  const type = req.file.mimetype.startsWith("video") ? "VIDEO" : "IMAGE";
  const folder = type === "VIDEO" ? "videos" : "images";
  const { key, url } = await uploadMedia(req.file.buffer, req.file.mimetype, folder);
  // req.body.variantId (set by the admin UI when uploading photos for one specific color/size, not the
  // product overall) comes through as a plain form field alongside the multipart file.
  const variantId = req.body.variantId ? String(req.body.variantId) : undefined;
  const media = await addProductMedia(businessIdOf(req), String(req.params.id), { type, url, s3Key: key }, variantId);
  res.status(201).json(media);
});

catalogRouter.delete("/api/media/:id", async (req, res) => {
  await deleteProductMedia(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

catalogRouter.put("/api/media/:id/assign", async (req, res) => {
  const variantId = req.body.variantId ? String(req.body.variantId) : null;
  const media = await assignProductMedia(businessIdOf(req), String(req.params.id), variantId);
  res.json(media);
});


catalogRouter.get("/api/category-aliases", async (req, res) => {
  const aliases = await listCategoryAliases(businessIdOf(req));
  res.json(aliases);
});

catalogRouter.post("/api/category-aliases", requireOwner, async (req, res) => {
  const { canonical, synonym } = req.body;
  if (!canonical || !synonym) {
    res.status(400).json({ error: "Faltan la palabra principal o el sinonimo" });
    return;
  }
  const alias = await createCategoryAlias(businessIdOf(req), { canonical, synonym });
  res.status(201).json(alias);
});

catalogRouter.delete("/api/category-aliases/:id", requireOwner, async (req, res) => {
  await deleteCategoryAlias(businessIdOf(req), String(req.params.id));
  res.status(204).send();
});

