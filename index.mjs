import axios from "axios";

/* ================== VARIABLES DE ENTORNO ================== */
const SHOP                 = process.env.SHOP;
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN;
const SYSCOM_CLIENT_ID     = process.env.SYSCOM_CLIENT_ID;
const SYSCOM_CLIENT_SECRET = process.env.SYSCOM_CLIENT_SECRET;

const MODE      = process.env.SYSCOM_MODE  || "search";   // "search" | "brand"
const QUERY     = process.env.SYSCOM_QUERY || "camaras";
const RUN_PAGES = parseInt(process.env.RUN_PAGES || "2", 10);
const SLEEP_MS  = parseInt(process.env.SLEEP_MS  || "900", 10);

const DEBUG      = process.env.DEBUG === "1";
const ONLY_STOCK = process.env.SYSCOM_ONLY_STOCK !== "0"; // true = solo con stock

// Preferencia de campos de precio desde Syscom.precios
const PRICE_PREF = (process.env.SYSCOM_PRICE_PREF || "descuento,especial,oferta,precio,publico,lista")
  .split(",").map(s => s.trim()).filter(Boolean);

// control de moneda/IVA/margen
const SYSCOM_CURRENCY = (process.env.SYSCOM_CURRENCY || "mxn").toLowerCase(); // si el endpoint lo soporta
const IVA_RATE   = Number(process.env.IVA_RATE || "1.16");  // 16% México
const MARGIN_MIN = Number(process.env.MARGIN_MIN || "0.20");
const MARGIN_MAX = Number(process.env.MARGIN_MAX || "0.25");

// ¿También escribir el precio de venta en la variante?
const SET_PRICE  = process.env.SET_PRICE !== "0";

// Imágenes
const MAX_IMAGES = parseInt(process.env.SYSCOM_MAX_IMAGES || "8", 10);

/* ================== ENDPOINTS SYSCOM ================== */
const SYS_OAUTH = "https://developers.syscom.mx/oauth/token";
const SYS_BASE  = "https://developers.syscom.mx/api/v1";

/* ================== UTILS ================== */
const wait   = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function firstNumber(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}
const pickMargin = () => MARGIN_MIN + Math.random() * (MARGIN_MAX - MARGIN_MIN);

/* ================== SYSCOM HELPERS ================== */
async function syscomToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SYSCOM_CLIENT_ID,
    client_secret: SYSCOM_CLIENT_SECRET,
  });
  const { data } = await axios.post(SYS_OAUTH, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return data.access_token;
}

async function sysget(token, path, params = {}) {
  const { data } = await axios.get(SYS_BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  return data;
}

// tipo de cambio desde Syscom
async function getExchangeRate(token) {
  try {
    const d = await sysget(token, "/tipocambio");
    // responses suelen venir como { normal: "xx.xx" }
    const tc = Number(d?.normal ?? d?.data?.normal ?? 1);
    return tc > 0 ? tc : 1;
  } catch {
    return 1;
  }
}

/* ================== SHOPIFY HELPERS ================== */
async function gql(query, variables = {}) {
  const { data } = await axios.post(
    `https://${SHOP}.myshopify.com/admin/api/2025-07/graphql.json`,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function rest(path) {
  const { data } = await axios.get(
    `https://${SHOP}.myshopify.com/admin/api/2025-07/${path}`,
    { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN } }
  );
  return data;
}

async function restPut(path, payload) {
  const { data } = await axios.put(
    `https://${SHOP}.myshopify.com/admin/api/2025-07/${path}`,
    payload,
    {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  return data;
}

async function restPost(path, payload) {
  const { data } = await axios.post(
    `https://${SHOP}.myshopify.com/admin/api/2025-07/${path}`,
    payload,
    {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  return data;
}

async function getPublicationId() {
  const q = `
    query {
      publications(first: 10) {
        edges { node { id catalog { title } } }
      }
    }`;
  const d = await gql(q);
  if (!d.publications.edges.length) throw new Error("No hay publications");
  return d.publications.edges[0].node.id; // usualmente Online Store
}

async function getLocation() {
  const d = await rest("locations.json");
  if (!d.locations?.length) throw new Error("No hay locations activas");
  const loc = d.locations[0];
  return { gid: `gid://shopify/Location/${loc.id}`, id: String(loc.id) };
}

async function findVariantBySku(sku) {
  const q = `
    query ($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node { id sku product { id status } inventoryItem { id } }
        }
      }
    }`;
  const d = await gql(q, { q: `sku:${sku}` });
  const e = d.productVariants.edges;
  return e.length ? e[0].node : null;
}

/* ====== crear producto (con media) con fallback ====== */
async function productCreate({ title, descriptionHtml, vendor, productType, images }) {
  const createMutation = `
    mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { field message }
      }
    }`;

  const product = {
    title,
    descriptionHtml: descriptionHtml || "",
    vendor: vendor || "",
    productType: productType || "",
    status: "ACTIVE",
  };

  // Intento 1: con media (incluye mediaContentType)
  const media = (images || [])
    .filter(Boolean)
    .map((u) => ({ originalSource: u, mediaContentType: "IMAGE" }))
    .slice(0, Math.min(MAX_IMAGES, 10));

  try {
    const d = await gql(createMutation, { product, media });
    const e = d.productCreate.userErrors;
    if (e?.length) throw new Error(JSON.stringify(e));
    const p = d.productCreate.product;
    return {
      productId: p.id,
      variantId: p.variants.nodes[0].id,
      inventoryItemId: p.variants.nodes[0].inventoryItem.id,
      createdWithMedia: true,
    };
  } catch (err) {
    if (DEBUG) console.error("productCreate (con media) falló, intentando sin media:", err?.message || err);
    // Intento 2: sin media
    const d2 = await gql(createMutation, { product, media: [] });
    const e2 = d2.productCreate.userErrors;
    if (e2?.length) throw new Error(JSON.stringify(e2));
    const p2 = d2.productCreate.product;
    return {
      productId: p2.id,
      variantId: p2.variants.nodes[0].id,
      inventoryItemId: p2.variants.nodes[0].inventoryItem.id,
      createdWithMedia: false,
    };
  }
}

/* ====== actualizar SOLO PRECIO por GraphQL ====== */
async function updateVariantPrice(productId, variantId, price) {
  if (!(price > 0)) return; // evita poner precio 0
  const q = `
    mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`;
  const d = await gql(q, {
    productId,
    variants: [{ id: variantId, price: String(round2(price)) }],
  });
  const e = d.productVariantsBulkUpdate.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
}

/* ====== actualizar PESO por REST (en gramos) ====== */
async function updateVariantWeight(variantGid, weightKg) {
  if (!(weightKg > 0)) return;
  const variantIdNum = Number(String(variantGid).replace(/\D/g, ""));
  const grams = Math.max(0, Math.round(Number(weightKg) * 1000));
  await restPut(`variants/${variantIdNum}.json`, { variant: { id: variantIdNum, grams } });
}

/* ====== actualizar SKU + BARCODE en InventoryItem ====== */
async function setInventorySku(inventoryItemId, sku, barcode) {
  const q = `
    mutation InvItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } }
    }`;
  const input = { sku: String(sku), tracked: true };
  if (barcode) input.barcode = String(barcode);
  const d = await gql(q, { id: inventoryItemId, input });
  const e = d.inventoryItemUpdate.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
}

/* ====== actualizar COSTO por InventoryItem (Costo por artículo) ====== */
async function updateInventoryCost(inventoryItemId, cost) {
  if (!(cost > 0)) return;
  const q = `
    mutation InvItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } }
    }`;
  const d = await gql(q, { id: inventoryItemId, input: { cost: String(round2(cost)) } });
  const e = d.inventoryItemUpdate.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
}

async function getAvailable(inventoryItemId, locationIdNum) {
  const iid = inventoryItemId.replace(/\D/g, "");
  const d = await rest(
    `inventory_levels.json?inventory_item_ids=${iid}&location_ids=${locationIdNum}`
  );
  return d.inventory_levels?.[0]?.available ?? 0;
}

async function adjustInventory(inventoryItemId, location, targetQty) {
  const current = await getAvailable(inventoryItemId, location.id);
  const delta = Number(targetQty) - Number(current);
  if (!delta) return;
  const q = `
    mutation Adjust($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) { userErrors { field message } }
    }`;
  const input = {
    name: "available",
    reason: "correction",
    changes: [{ inventoryItemId, locationId: location.gid, delta }],
  };
  const d = await gql(q, { input });
  const e = d.inventoryAdjustQuantities.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
}

async function publishProduct(productId, publicationId) {
  const q = `
    mutation Pub($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`;
  const d = await gql(q, { id: productId, input: [{ publicationId }] });
  const e = d.publishablePublish.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
}

/* ====== IMÁGENES (multi) PARA EXISTENTES ====== */
async function getProductImageCountByGid(productGid) {
  const productIdNum = Number(String(productGid).replace(/\D/g, ""));
  const d = await rest(`products/${productIdNum}.json`);
  return d?.product?.images?.length || 0;
}

async function addImagesToProduct(productGid, imageUrls = []) {
  const productIdNum = Number(String(productGid).replace(/\D/g, ""));
  let added = 0;
  for (const src of imageUrls) {
    try {
      await restPost(`products/${productIdNum}/images.json`, { image: { src } });
      added++;
      await wait(500); // suaviza rate limit
    } catch (e) {
      console.error("addImagesToProduct error:", e?.response?.data || e?.message || e);
    }
  }
  if (DEBUG) console.log(`Imágenes añadidas: ${added}/${imageUrls.length} para ${productIdNum}`);
}

/* ================== MAPEO DESDE SYSCOM ================== */
function pickPriceFromPrecios(precios) {
  if (!precios || typeof precios !== "object") return 0;

  for (const k of PRICE_PREF) {
    if (k in precios) {
      const val = firstNumber(precios[k]);
      if (val > 0) return val;
    }
  }
  const candidates = Object.values(precios)
    .map(firstNumber)
    .filter(n => n > 0);
  return candidates.length ? Math.min(...candidates) : 0;
}

// ===== Imágenes: recoge varias y deduplica =====
function normalizeImages(P) {
  const urls = new Set();

  const pushUrl = (u) => {
    if (typeof u !== "string") return;
    const url = u.trim();
    if (!url) return;
    // Limpieza rápida de miniaturas (?, ?w=100, ?h=100, etc.)
    const cleaned = url.replace(/([?&](w|h|width|height|size|max)[=]\d+)+/gi, "");
    urls.add(cleaned);
  };

  if (Array.isArray(P.imagenes)) {
    for (const img of P.imagenes) {
      if (typeof img === "string") pushUrl(img);
      else if (img?.url)          pushUrl(img.url);
      else if (img?.original)     pushUrl(img.original);
      else if (img?.big)          pushUrl(img.big);
    }
  }

  if (Array.isArray(P.fotos)) {
    for (const img of P.fotos) {
      if (typeof img === "string") pushUrl(img);
      else if (img?.url)          pushUrl(img.url);
      else if (img?.original)     pushUrl(img.original);
      else if (img?.big)          pushUrl(img.big);
    }
  }

  if (typeof P.img_portada === "string") pushUrl(P.img_portada);
  if (typeof P.imagen === "string")      pushUrl(P.imagen);

  return Array.from(urls).slice(0, MAX_IMAGES);
}

function mapSyscomProduct(P, tc) {
  // sku/título
  const sku   = P.sku || P.codigo || P.clave || P.modelo;
  const title = P.nombre || P.titulo || P.descripcion_corta || P.descripcion;
  if (!sku || !title) return null;

  // desc/marca/categoría
  const desc   = P.descripcion_html || P.descripcion || "";
  const vendor = (P.marca && (P.marca.nombre || P.marca)) || P.marca || P.fabricante || "";
  const ptype  =
    (Array.isArray(P.categorias) && (P.categorias[0]?.nombre || P.categorias[0])) ||
    (P.categoria && (P.categoria.nombre || P.categoria)) ||
    "";

  // precio base: costo proveedor = precio_con_descuento (o el más bajo disponible)
  const precios = P.precios || {};
  let base = pickPriceFromPrecios(precios) ||
             firstNumber(P.precio, P.precio_publico, P.precio_lista);

  // moneda de origen reportada por Syscom (si viene). Si no, asumimos la que pedimos.
  const monedaOrigen =
    (P.moneda || P.precios?.moneda || SYSCOM_CURRENCY).toString().toLowerCase();

  // convertir costo a MXN si viene en USD
  let costMXN = base;
  if (monedaOrigen === "usd") costMXN = base * (tc || 1);

  // existencia/peso/imagenes/barcode
  const qty = firstNumber(P.existencia, P.stock, P.total_existencia);
  let weightKg = firstNumber(P.peso_kg, P.peso);
  if (weightKg > 100) weightKg = weightKg / 1000;

  const images = normalizeImages(P);

  const barcode =
    P.codigo_barras || P.codigo_barras_ean || P.ean || P.barcode || P.gtin || P.upc || null;

  // precio final = costo_mxn × IVA × (1 + margen[20..25] %)
  const margin = pickMargin();
  const price  = round2(costMXN * IVA_RATE * (1 + margin));

  if (DEBUG) {
    console.log(`SKU ${sku} | base:${base} ${monedaOrigen.toUpperCase()} | tc:${tc} | costMXN:${round2(costMXN)} | price:${price} | imgs:${images.length}`);
  }

  return {
    sku: String(sku),
    title: String(title),
    descriptionHtml: String(desc),
    vendor: String(vendor),
    productType: String(ptype),
    cost: round2(costMXN),
    price,                             // precio final calculado
    available: Number(qty) || 0,
    images,
    barcode,
    weightKg: Number(weightKg) || 0,
  };
}

/* ================== MAIN ================== */
async function main() {
  if (!SHOP || !ADMIN_TOKEN || !SYSCOM_CLIENT_ID || !SYSCOM_CLIENT_SECRET) {
    throw new Error("Faltan variables de entorno obligatorias");
  }

  const publicationId = await getPublicationId();
  const location      = await getLocation();
  const token         = await syscomToken();
  const tc            = await getExchangeRate(token); // USD→MXN de Syscom

  let created = 0, updated = 0, errors = 0;

  for (let page = 1; page <= RUN_PAGES; page++) {
    let list;

    if (MODE === "brand") {
      list = await sysget(token, `/marcas/${QUERY}/productos`, {
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
        moneda: SYSCOM_CURRENCY, // si el endpoint lo soporta, forzamos MXN
      });
    } else {
      list = await sysget(token, `/productos`, {
        busqueda: QUERY,
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
        moneda: SYSCOM_CURRENCY, // si el endpoint lo soporta, forzamos MXN
      });
    }

    const productos = list?.data?.productos || list?.data || list?.productos || list;

    if (DEBUG) {
      console.log(
        `Página ${page}: ${Array.isArray(productos) ? productos.length : 0} productos`
      );
      if (Array.isArray(productos) && productos.length) {
        const first = productos[0]?.producto || productos[0]?.Producto || productos[0]?.item || productos[0]?.Item || productos[0];
        console.log("Keys ejemplo (nivel 1):", first ? Object.keys(first) : "sin items");
        try { console.log("Ejemplo JSON (recortado):", JSON.stringify(first).slice(0, 800)); } catch {}
      }
    }

    if (!Array.isArray(productos) || productos.length === 0) break;

    for (const p of productos) {
      try {
        const row = p.producto || p.Producto || p.item || p.Item || p;

        let pid = row.id || row.producto_id || row.id_producto || row.pid;
        if (!pid) {
          const u = row.url || row.link || row.href || "";
          const m = typeof u === "string" ? u.match(/productos\/(\d+)/) : null;
          if (m) pid = m[1];
        }
        if (!pid) { if (DEBUG) console.log("Sin pid en item:", Object.keys(row || {})); continue; }

        const det = await sysget(token, `/productos/${pid}`, { moneda: SYSCOM_CURRENCY });
        const sp  = det.data || det;

        const m = mapSyscomProduct(sp, tc);
        if (!m || !(m.cost > 0)) continue;

        const exists = await findVariantBySku(m.sku);
        if (exists) {
          // Actualiza datos principales
          if (SET_PRICE) await updateVariantPrice(exists.product.id, exists.id, m.price);
          await updateVariantWeight(exists.id, m.weightKg);
          await setInventorySku(exists.inventoryItem.id, m.sku, m.barcode);
          await updateInventoryCost(exists.inventoryItem.id, m.cost);
          await adjustInventory(exists.inventoryItem.id, location, m.available);
          await publishProduct(exists.product.id, publicationId);

          // Añadir imágenes faltantes (hasta MAX_IMAGES)
          if (m.images?.length) {
            const imgCount = await getProductImageCountByGid(exists.product.id);
            if (imgCount < Math.min(MAX_IMAGES, m.images.length)) {
              await addImagesToProduct(
                exists.product.id,
                m.images.slice(imgCount, MAX_IMAGES)
              );
            }
          }
          updated++;
        } else {
          const res = await productCreate({
            title: m.title,
            descriptionHtml: m.descriptionHtml,
            vendor: m.vendor,
            productType: m.productType,
            images: m.images, // intenta con media; si falla, fallback sin media
          });
          if (SET_PRICE) await updateVariantPrice(res.productId, res.variantId, m.price);
          await updateVariantWeight(res.variantId, m.weightKg);
          await setInventorySku(res.inventoryItemId, m.sku, m.barcode);
          await updateInventoryCost(res.inventoryItemId, m.cost);
          await adjustInventory(res.inventoryItemId, location, m.available);
          await publishProduct(res.productId, publicationId);

          // Si se creó sin media, anexa por REST
          if (!res.createdWithMedia && m.images?.length) {
            await addImagesToProduct(res.productId, m.images.slice(0, MAX_IMAGES));
          }
          // (Opcional) asegurar anexado de faltantes si enviaste >10 en MAX_IMAGES
          if (m.images?.length > 10) {
            await addImagesToProduct(res.productId, m.images.slice(10, MAX_IMAGES));
          }
          created++;
        }
      } catch (err) {
        errors++;
        console.error(
          "Error con producto",
          p.id || p.producto_id || p.pid,
          err?.response?.data || err?.message || err
        );
      }

      await wait(SLEEP_MS);
    }
  }

  console.log(`Resumen => creados: ${created}, actualizados: ${updated}, errores: ${errors}`);
}

/* ================== ARRANQUE ================== */
main().catch((e) => {
  console.error(e?.response?.data || e?.message || e);
  process.exit(1);
});
