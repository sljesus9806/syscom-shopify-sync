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
const PRICE_PREF = (process.env.SYSCOM_PRICE_PREF || "especial,oferta,descuento,precio,publico,lista")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// (Opcional) también colocar el precio final en la variante
const SET_PRICE  = process.env.SET_PRICE === "1";

// Parámetros de precio final
const MARKUP_MIN = Number(process.env.MARKUP_MIN || "0.20");
const MARKUP_MAX = Number(process.env.MARKUP_MAX || "0.25");
const VAT_RATE   = Number(process.env.VAT_RATE   || "0.16");

// Fallback de TC si la API falla
const USD_FX_FALLBACK = Number(process.env.USD_FX_FALLBACK || "20");

/* ================== ENDPOINTS SYSCOM ================== */
const SYS_OAUTH = "https://developers.syscom.mx/oauth/token";
const SYS_BASE  = "https://developers.syscom.mx/api/v1";

/* ================== UTILS ================== */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function firstNumber(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function pickDeterministicMargin(key = "") {
  if (MARKUP_MIN === MARKUP_MAX) return MARKUP_MIN;
  const seed = Array.from(String(key)).reduce((a, c) => a + (c.charCodeAt(0) % 10), 0);
  const t = (seed % 101) / 100; // 0..1
  return MARKUP_MIN + (MARKUP_MAX - MARKUP_MIN) * t;
}

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

/** Tipo de cambio oficial desde SYSCOM.
 *  GET /tipocambio → { normal, un_dia, una_semana, dos_semanas, tres_semanas, un_mes }
 */
async function getSyscomUsdRate(token) {
  try {
    const d = await sysget(token, "/tipocambio", { moneda: "usd" });
    const fx = firstNumber(
      d?.normal, d?.un_dia, d?.una_semana, d?.dos_semanas, d?.tres_semanas, d?.un_mes
    );
    const v = fx > 0 ? fx : USD_FX_FALLBACK;
    if (DEBUG) console.log("TC USD SYSCOM:", v);
    return v;
  } catch (e) {
    if (DEBUG) console.log("TC USD SYSCOM falló, usando fallback:", USD_FX_FALLBACK, e?.message);
    return USD_FX_FALLBACK;
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

/* ====== crear producto con media opcional ====== */
async function productCreate({ title, descriptionHtml, vendor, productType, images }) {
  const q = `
    mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { field message }
      }
    }`;

  const media = (images || [])
    .filter(Boolean)
    .slice(0, 10)
    .map((u) => ({ originalSource: u }));

  const product = {
    title,
    descriptionHtml: descriptionHtml || "",
    vendor: vendor || "",
    productType: productType || "",
    status: "ACTIVE",
  };

  const d = await gql(q, { product, media });
  const e = d.productCreate.userErrors;
  if (e?.length) throw new Error(JSON.stringify(e));
  const p = d.productCreate.product;
  return {
    productId: p.id,
    variantId: p.variants.nodes[0].id,
    inventoryItemId: p.variants.nodes[0].inventoryItem.id,
  };
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

function detectCurrency(P, precios) {
  const m = String(P.moneda || P.currency || P.divisa || "").toUpperCase();
  if (m.includes("USD") || m.includes("DOL")) return "USD";
  const keys = Object.keys(precios || {}).map(k => k.toLowerCase());
  if (keys.some(k => k.includes("usd") || k.includes("dolar"))) return "USD";
  return "MXN";
}

function mapSyscomProduct(P) {
  const sku   = P.sku || P.codigo || P.clave || P.modelo;
  const title = P.nombre || P.titulo || P.descripcion_corta || P.descripcion;
  if (!sku || !title) return null;

  const desc   = P.descripcion_html || P.descripcion || "";
  const vendor = (P.marca && (P.marca.nombre || P.marca)) || P.marca || P.fabricante || "";
  const ptype  =
    (Array.isArray(P.categorias) && (P.categorias[0]?.nombre || P.categorias[0])) ||
    (P.categoria && (P.categoria.nombre || P.categoria)) ||
    "";

  // Precio (preferimos "descuento"/"especial"... sin IVA)
  const precios = P.precios || {};
  const base    = pickPriceFromPrecios(precios) ||
                  firstNumber(P.precio, P.precio_publico, P.precio_lista);

  const currency = detectCurrency(P, precios);

  // existencias totales
  const qty = firstNumber(P.existencia, P.stock, P.total_existencia);

  // peso (si viene en gramos, lo normalizamos a kg)
  let weightKg = firstNumber(P.peso_kg, P.peso);
  if (weightKg > 100) weightKg = weightKg / 1000;

  // imágenes: imágenes[] / fotos[] / img_portada  (hasta 10)
  const images = [];
  const pushImg = (u) => { if (u && images.length < 10) images.push(String(u)); };
  if (Array.isArray(P.imagenes)) {
    for (const img of P.imagenes) {
      if (typeof img === "string") pushImg(img);
      else if (img?.url)           pushImg(img.url);
      if (images.length >= 10) break;
    }
  } else if (Array.isArray(P.fotos)) {
    for (const img of P.fotos) {
      if (typeof img === "string") pushImg(img);
      else if (img?.url)           pushImg(img.url);
      if (images.length >= 10) break;
    }
  } else if (typeof P.img_portada === "string") {
    pushImg(P.img_portada);
  }

  const barcode =
    P.codigo_barras || P.codigo_barras_ean || P.ean || P.barcode || P.gtin || P.upc || null;

  if (DEBUG && precios && Object.keys(precios).length) {
    try { console.log("Precios Syscom:", JSON.stringify(precios)); } catch {}
  }

  return {
    sku: String(sku),
    title: String(title),
    descriptionHtml: String(desc),
    vendor: String(vendor),
    productType: String(ptype),
    base,                 // precio base (descuento) SIN IVA, en MXN o USD según currency
    currency,             // "MXN" | "USD"
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

  // Tipo de cambio USD oficial SYSCOM (una vez por corrida)
  const usdRate = await getSyscomUsdRate(token);

  let created = 0, updated = 0, errors = 0;

  for (let page = 1; page <= RUN_PAGES; page++) {
    let list;

    if (MODE === "brand") {
      list = await sysget(token, `/marcas/${QUERY}/productos`, {
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
      });
    } else {
      list = await sysget(token, `/productos`, {
        busqueda: QUERY,
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
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
        console.log(
          "Muestra:",
          productos.slice(0, 3).map((pp) => {
            const r = pp.producto || pp.Producto || pp.item || pp.Item || pp;
            return r.sku || r.codigo || r.clave || r.modelo || r.pid || r.id || r.id_producto;
          })
        );
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

        const det = await sysget(token, `/productos/${pid}`, {});
        const sp  = det.data || det;

        const m = mapSyscomProduct(sp);
        if (!m) continue;

        // ==== COSTO (sin IVA) en MXN ====
        const costMXN = m.currency === "USD" ? (Number(m.base) * usdRate) : Number(m.base);

        // ==== PRECIO DE VENTA (con margen 20–25% y luego IVA) ====
        const margin = pickDeterministicMargin(m.sku);
        const priceFinal = round2( round2(costMXN * (1 + margin)) * (1 + VAT_RATE) );

        const exists = await findVariantBySku(m.sku);
        if (exists) {
          if (SET_PRICE) await updateVariantPrice(exists.product.id, exists.id, priceFinal);
          await updateVariantWeight(exists.id, m.weightKg);
          await setInventorySku(exists.inventoryItem.id, m.sku, m.barcode);
          await updateInventoryCost(exists.inventoryItem.id, round2(costMXN));
          await adjustInventory(exists.inventoryItem.id, location, m.available);
          await publishProduct(exists.product.id, publicationId);
          updated++;
        } else {
          const res = await productCreate({
            title: m.title,
            descriptionHtml: m.descriptionHtml,
            vendor: m.vendor,
            productType: m.productType,
            images: m.images,
          });
          if (SET_PRICE) await updateVariantPrice(res.productId, res.variantId, priceFinal);
          await updateVariantWeight(res.variantId, m.weightKg);
          await setInventorySku(res.inventoryItemId, m.sku, m.barcode);
          await updateInventoryCost(res.inventoryItemId, round2(costMXN));
          await adjustInventory(res.inventoryItemId, location, m.available);
          await publishProduct(res.productId, publicationId);
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
