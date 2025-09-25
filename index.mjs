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

// Preferencia de campos de precio desde Syscom.precios (orden de preferencia)
const PRICE_PREF = (process.env.SYSCOM_PRICE_PREF || "descuento,especial,oferta,precio,publico,lista,precio_con_descuento,precio_publico,precio_lista")
  .split(",").map(s => s.trim()).filter(Boolean);

// Moneda/IVA/margen
const SYSCOM_CURRENCY = (process.env.SYSCOM_CURRENCY || "mxn").toLowerCase();
const IVA_RATE   = Number(process.env.IVA_RATE || "1.16");
const MARGIN_MIN = Number(process.env.MARGIN_MIN || "0.20");
const MARGIN_MAX = Number(process.env.MARGIN_MAX || "0.25");

const SET_PRICE  = process.env.SET_PRICE !== "0";

// Imágenes
const MAX_IMAGES = parseInt(process.env.SYSCOM_MAX_IMAGES || "8", 10);

// Filtro de precios (descarta candidatos absurdamente bajos)
const PRICE_MIN  = Number(process.env.SYSCOM_PRICE_MIN || "50");

/* ================== ENDPOINTS SYSCOM ================== */
const SYS_OAUTH = "https://developers.syscom.mx/oauth/token";
const SYS_BASE  = "https://developers.syscom.mx/api/v1";

/* ================== UTILS ================== */
const wait   = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Parseador robusto de dinero: quita símbolos, soporta coma decimal, miles con , o .
function money(val) {
  if (val == null) return NaN;
  if (typeof val === "number") return val;
  if (typeof val !== "string") return NaN;
  let s = val.trim();
  if (!s) return NaN;
  // quita símbolos y texto de moneda
  s = s.replace(/\s*(MXN|USD|\$|us[d]?|mxn|eur|€|dlls?|\bpesos?\b)\s*/ig, "");
  // si tiene coma y punto, decide formato (1.234,56 o 1,234.56)
  const hasComma = s.includes(",");
  const hasDot   = s.includes(".");
  if (hasComma && hasDot) {
    // si el último separador es coma → coma decimal (EU)
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // último es punto → punto decimal, quita comas miles
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    // solo coma → probablemente decimal
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // solo punto → quita comas de miles
    s = s.replace(/,/g, "");
  }
  // quita cualquier cosa que no sea dígito, punto o signo
  s = s.replace(/[^0-9.+-]/g, "");
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n = money(v);
    if (isFinite(n)) return n;
  }
  return NaN;
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
    { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" } }
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
    { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" } }
  );
  return data;
}

async function restPost(path, payload) {
  const { data } = await axios.post(
    `https://${SHOP}.myshopify.com/admin/api/2025-07/${path}`,
    payload,
    { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" } }
  );
  return data;
}

async function getPublicationId() {
  const q = `query { publications(first: 10) { edges { node { id catalog { title } } } } }`;
  const d = await gql(q);
  if (!d.publications.edges.length) throw new Error("No hay publications");
  return d.publications.edges[0].node.id;
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
        edges { node { id sku product { id status } inventoryItem { id } } }
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

  const product = { title, descriptionHtml: descriptionHtml || "", vendor: vendor || "", productType: productType || "", status: "ACTIVE" };

  const media = (images || [])
    .filter(Boolean)
    .map((u) => ({ originalSource: u, mediaContentType: "IMAGE" }))
    .slice(0, Math.min(MAX_IMAGES, 10));

  try {
    const d = await gql(createMutation, { product, media });
    const e = d.productCreate.userErrors;
    if (e?.length) throw new Error(JSON.stringify(e));
    const p = d.productCreate.product;
    return { productId: p.id, variantId: p.variants.nodes[0].id, inventoryItemId: p.variants.nodes[0].inventoryItem.id, createdWithMedia: true };
  } catch (err) {
    if (DEBUG) console.error("productCreate (con media) falló, intentando sin media:", err?.message || err);
    const d2 = await gql(createMutation, { product, media: [] });
    const e2 = d2.productCreate.userErrors;
    if (e2?.length) throw new Error(JSON.stringify(e2));
    const p2 = d2.productCreate.product;
    return { productId: p2.id, variantId: p2.variants.nodes[0].id, inventoryItemId: p2.variants.nodes[0].inventoryItem.id, createdWithMedia: false };
  }
}

/* ====== PRECIO / PESO / INVENTARIO ====== */
async function updateVariantPrice(productId, variantId, price) {
  if (!(price > 0)) return;
  const q = `
    mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`;
  const d = await gql(q, { productId, variants: [{ id: variantId, price: String(round2(price)) }] });
  const e = d.productVariantsBulkUpdate.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
}

async function updateVariantWeight(variantGid, weightKg) {
  if (!(weightKg > 0)) return;
  const variantIdNum = Number(String(variantGid).replace(/\D/g, ""));
  const grams = Math.max(0, Math.round(Number(weightKg) * 1000));
  await restPut(`variants/${variantIdNum}.json`, { variant: { id: variantIdNum, grams } });
}

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
  const d = await rest(`inventory_levels.json?inventory_item_ids=${iid}&location_ids=${locationIdNum}`);
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
  const input = { name: "available", reason: "correction", changes: [{ inventoryItemId, locationId: location.gid, delta }] };
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

/* ================== IMÁGENES ================== */
// Toma varias del JSON, conserva originales y añade versión "limpia"
function collectBasicImages(P) {
  const originals = [];
  const hires = [];

  const push = (u) => {
    if (typeof u !== "string") return;
    const url = u.trim();
    if (!url) return;
    originals.push(url);
    const cleaned = url.replace(/([?&](w|h|width|height|size|max|quality|q)[=][^&#]+)+/gi, "");
    if (cleaned && cleaned !== url) hires.push(cleaned);
  };

  const collect = (arr) => {
    for (const img of arr) {
      if (typeof img === "string") { push(img); continue; }
      if (!img || typeof img !== "object") continue;
      if (img.url)       push(img.url);
      if (img.original)  push(img.original);
      if (img.big)       push(img.big);
      if (img.hires)     push(img.hires);
      if (img.src)       push(img.src);
    }
  };

  if (Array.isArray(P.imagenes)) collect(P.imagenes);
  if (Array.isArray(P.fotos))    collect(P.fotos);
  if (typeof P.img_portada === "string") push(P.img_portada);
  if (typeof P.imagen === "string")      push(P.imagen);
  if (Array.isArray(P.galeria))          collect(P.galeria);
  if (Array.isArray(P.imagenes_url))     collect(P.imagenes_url);

  const uniq = (arr) => Array.from(new Set(arr));
  return uniq([...originals, ...hires]).slice(0, MAX_IMAGES);
}

// Genera hermanas ...-0.jpg → ...-1.jpg..-8.jpg (sin validar con HEAD)
function guessSiblings(u) {
  const out = [];
  const m = u.match(/(.*?)([-_])0(\.[a-z]+)$/i);
  if (!m) return out;
  const [, base, sep, ext] = m;
  for (let i = 1; i <= 8; i++) out.push(`${base}${sep}${i}${ext}`);
  return out;
}

function buildImageListNoHead(P) {
  const base = collectBasicImages(P);
  const want = new Set(base);
  if (base.length < MAX_IMAGES) {
    for (const u of base) {
      for (const sib of guessSiblings(u)) {
        if (want.size >= MAX_IMAGES) break;
        want.add(sib);
      }
      if (want.size >= MAX_IMAGES) break;
    }
  }
  return Array.from(want).slice(0, MAX_IMAGES);
}

/* ================== MAPEO DESDE SYSCOM ================== */
function pickPriceFromPrecios(precios) {
  if (!precios || typeof precios !== "object") return NaN;

  // Preferencia explícita
  for (const k of PRICE_PREF) {
    if (k in precios) {
      const v = money(precios[k]);
      if (isFinite(v) && v >= PRICE_MIN) return v;
    }
  }

  // Fallback: cualquier numérico >= PRICE_MIN
  const nums = Object.values(precios).map(money).filter(n => isFinite(n) && n >= PRICE_MIN);
  if (nums.length) return Math.min(...nums);

  // Último recurso: evita porcentajes (0..1) y toma el menor >1
  const notPerc = Object.values(precios).map(money).filter(n => isFinite(n) && n > 1);
  if (notPerc.length) return Math.min(...notPerc);

  return NaN;
}

function mapSyscomProduct(P, tc, images) {
  const sku   = P.sku || P.codigo || P.clave || P.modelo;
  const title = P.nombre || P.titulo || P.descripcion_corta || P.descripcion;
  if (!sku || !title) return null;

  const desc   = P.descripcion_html || P.descripcion || "";
  const vendor = (P.marca && (P.marca.nombre || P.marca)) || P.marca || P.fabricante || "";
  const ptype  =
    (Array.isArray(P.categorias) && (P.categorias[0]?.nombre || P.categorias[0])) ||
    (P.categoria && (P.categoria.nombre || P.categoria)) ||
    "";

  const precios = P.precios || {};
  let base = pickPriceFromPrecios(precios);
  if (!isFinite(base)) base = firstNumber(P.precio, P.precio_publico, P.precio_lista);

  const monedaOrigen =
    (P.moneda || P.precios?.moneda || SYSCOM_CURRENCY).toString().toLowerCase();

  let costMXN = base;
  if (monedaOrigen === "usd") costMXN = base * (tc || 1);

  const qty = firstNumber(P.existencia, P.stock, P.total_existencia);
  let weightKg = firstNumber(P.peso_kg, P.peso);
  if (isFinite(weightKg) && weightKg > 100) weightKg = weightKg / 1000;

  const barcode = P.codigo_barras || P.codigo_barras_ean || P.ean || P.barcode || P.gtin || P.upc || null;

  const margin = pickMargin();
  const price  = round2(costMXN * IVA_RATE * (1 + margin));

  if (DEBUG) {
    console.log("— PRECIOS RAW KEYS:", Object.keys(precios || {}));
    try { console.log("— PRECIOS RAW JSON:", JSON.stringify(precios).slice(0, 300)); } catch {}
    console.log(`SKU ${sku} | base:${base} ${monedaOrigen.toUpperCase()} | tc:${tc} | costMXN:${round2(costMXN)} | price:${price} | imgs:${images?.length || 0}`);
  }

  return {
    sku: String(sku),
    title: String(title),
    descriptionHtml: String(desc),
    vendor: String(vendor),
    productType: String(ptype),
    cost: round2(costMXN),
    price,
    available: Number(qty) || 0,
    images: images || [],
    barcode,
    weightKg: isFinite(weightKg) ? Number(weightKg) : 0,
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
  const tc            = await getExchangeRate(token);

  let created = 0, updated = 0, errors = 0;

  for (let page = 1; page <= RUN_PAGES; page++) {
    let list;

    if (MODE === "brand") {
      list = await sysget(token,
