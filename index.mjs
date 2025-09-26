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

// Moneda / IVA / margen (margen 15–25 % por defecto)
const SYSCOM_CURRENCY = (process.env.SYSCOM_CURRENCY || "mxn").toLowerCase();
const IVA_RATE   = Number(process.env.IVA_RATE || "1.16");
const MARGIN_MIN = Number(process.env.MARGIN_MIN || "0.15");
const MARGIN_MAX = Number(process.env.MARGIN_MAX || "0.25");

// ¿También escribir el precio de venta en la variante?
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
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
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
// Toma portada + imagenes[] (ordenadas por 'orden') y añade versión "limpia"
function collectBasicImages(P) {
  const out = [];

  const push = (u) => {
    if (typeof u !== "string") return;
    const url = u.trim();
    if (!url) return;
    out.push(url);
    const cleaned = url.replace(/([?&](w|h|width|height|size|max|quality|q)[=][^&#]+)+/gi, "");
    if (cleaned && cleaned !== url) out.push(cleaned);
  };

  // 1) portada primero si existe
  if (typeof P.img_portada === "string") push(P.img_portada);

  // 2) imagenes[] del schema (objetos {orden, url})
  if (Array.isArray(P.imagenes)) {
    const arr = [...P.imagenes]
      .filter(it => it && typeof it.url === "string")
      .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));
    for (const it of arr) push(it.url);
  }

  // 3) compatibilidad con otras colecciones si existieran
  const pickUrlish = (img) => (typeof img === "string" ? img : (img?.url || img?.src || img?.original || img?.big || img?.hires));
  if (Array.isArray(P.fotos))         for (const it of P.fotos)         { const u = pickUrlish(it); if (u) push(u); }
  if (Array.isArray(P.galeria))       for (const it of P.galeria)       { const u = pickUrlish(it); if (u) push(u); }
  if (Array.isArray(P.imagenes_url))  for (const it of P.imagenes_url)  { const u = pickUrlish(it); if (u) push(u); }
  if (typeof P.imagen === "string") push(P.imagen);

  // dedupe y limita
  const uniq = Array.from(new Set(out));
  return uniq.slice(0, MAX_IMAGES);
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
// Devuelve { value, source } priorizando precio con descuentos según el schema
function pickDiscountedPrice(precios) {
  if (!precios || typeof precios !== "object") return { value: NaN, source: "" };

  // 1) Claves exactas del schema
  const exactOrder = ["precio_descuentos", "precio_especial"];
  for (const k of exactOrder) {
    if (k in precios) {
      const n = money(precios[k]);
      if (isFinite(n) && n >= PRICE_MIN) return { value: n, source: k };
    }
  }

  // 2) Alias comunes (por si tu cuenta usa variantes)
  const alias = ["con_descuento", "con_descuentos", "precio_descuento", "neto", "precio_neto", "mi_precio", "oferta", "especial"];
  for (const k of alias) {
    if (k in precios) {
      const n = money(precios[k]);
      if (isFinite(n) && n >= PRICE_MIN) return { value: n, source: k };
    }
  }

  // 3) Cualquier clave con descuento/especial/oferta/neto
  const cand1 = Object.entries(precios)
    .filter(([k]) => /descuent|especial|oferta|neto/i.test(k))
    .map(([k, v]) => ({ k, n: money(v) }))
    .filter(o => isFinite(o.n) && o.n >= PRICE_MIN);
  if (cand1.length) {
    const best = cand1.reduce((a, b) => (a.n <= b.n ? a : b));
    return { value: best.n, source: best.k };
  }

  // 4) Evita lista/público/msrp
  const bad = /(lista|list|publico|msrp|sin_desc|base)/i;
  const cand2 = Object.entries(precios)
    .filter(([k]) => !bad.test(k))
    .map(([k, v]) => ({ k, n: money(v) }))
    .filter(o => isFinite(o.n) && o.n >= PRICE_MIN);
  if (cand2.length) {
    const best = cand2.reduce((a, b) => (a.n <= b.n ? a : b));
    return { value: best.n, source: best.k };
  }

  // 5) Último recurso: cualquier > 1
  const cand3 = Object.entries(precios)
    .map(([k, v]) => ({ k, n: money(v) }))
    .filter(o => isFinite(o.n) && o.n > 1);
  if (cand3.length) {
    const best = cand3.reduce((a, b) => (a.n <= b.n ? a : b));
    return { value: best.n, source: best.k };
  }

  return { value: NaN, source: "" };
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
  const { value: basePref, source: baseSource } = pickDiscountedPrice(precios);

  // fallback si no hay precio válido en "precios"
  let base = isFinite(basePref) ? basePref : firstNumber(P.precio, P.precio_publico, P.precio_lista);

  // moneda del producto
  const monedaOrigen =
    (P.moneda || P.precios?.moneda || SYSCOM_CURRENCY).toString().toLowerCase();

  // convertir a MXN; piso de emergencia si USD y tc dudoso
  let costMXN = base;
  if (monedaOrigen === "usd") {
    const tcSafe = (tc && tc > 10) ? tc : 18;   // evita TC mal devuelto
    costMXN = base * tcSafe;
  }

  const qty = firstNumber(P.existencia, P.stock, P.total_existencia);
  let weightKg = firstNumber(P.peso_kg, P.peso);
  if (isFinite(weightKg) && weightKg > 100) weightKg = weightKg / 1000;

  const barcode = P.codigo_barras || P.codigo_barras_ean || P.ean || P.barcode || P.gtin || P.upc || null;

  // precio final = costo × (1+margen) × IVA
  const margin = pickMargin();
  const price  = round2(costMXN * (1 + margin) * IVA_RATE);

  if (DEBUG) {
    console.log("— PRECIOS RAW KEYS:", Object.keys(precios || {}));
    try { console.log("— PRECIOS RAW JSON:", JSON.stringify(precios).slice(0, 300)); } catch {}
    console.log(`SKU ${sku} | base:${base} (src:${baseSource || "fallback"}) ${monedaOrigen.toUpperCase()} | tc:${tc} | costMXN:${round2(costMXN)} | price:${price} | imgs:${images?.length || 0}`);
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
      list = await sysget(token, `/marcas/${QUERY}/productos`, {
        stock: (ONLY_STOCK ? 1 : 0), agrupar: 1, pagina: page, moneda: SYSCOM_CURRENCY,
      });
    } else {
      list = await sysget(token, `/productos`, {
        busqueda: QUERY, stock: (ONLY_STOCK ? 1 : 0), agrupar: 1, pagina: page, moneda: SYSCOM_CURRENCY,
      });
    }

    const productos = list?.data?.productos || list?.data || list?.productos || list;

    if (!Array.isArray(productos) || productos.length === 0) break;

    if (DEBUG) {
      console.log(`Página ${page}: ${Array.isArray(productos) ? productos.length : 0} productos`);
      const first = productos[0]?.producto || productos[0]?.Producto || productos[0]?.item || productos[0]?.Item || productos[0];
      console.log("Keys ejemplo (nivel 1):", first ? Object.keys(first) : "sin items");
      try { console.log("Ejemplo JSON (recortado):", JSON.stringify(first).slice(0, 800)); } catch {}
    }

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

        if (DEBUG) {
          const imgKeys = Object.keys(sp || {}).filter(k => /img|imagen|imagenes|fotos|galeria/i.test(k));
          console.log(`PID ${pid} → claves de imagen:`, imgKeys);
        }

        // Construye lista de imágenes (básicas + hermanas, sin HEAD)
        const images = buildImageListNoHead(sp);
        if (DEBUG) console.log(`PID ${pid} → imágenes para subir (${images.length}):`, images.slice(0, 12));

        const m = mapSyscomProduct(sp, tc, images);
        if (!m || !(m.cost > 0)) continue;

        const exists = await findVariantBySku(m.sku);
        if (exists) {
          if (SET_PRICE) await updateVariantPrice(exists.product.id, exists.id, m.price);
          await updateVariantWeight(exists.id, m.weightKg);
          await setInventorySku(exists.inventoryItem.id, m.sku, m.barcode);
          await updateInventoryCost(exists.inventoryItem.id, m.cost);
          await adjustInventory(exists.inventoryItem.id, location, m.available);
          await publishProduct(exists.product.id, publicationId);

          // Anexar imágenes faltantes
          if (m.images?.length) {
            const prodIdNum = String(exists.product.id).replace(/\D/g, "");
            const d = await rest(`products/${prodIdNum}.json`);
            const imgCount = d?.product?.images?.length || 0;
            if (imgCount < Math.min(MAX_IMAGES, m.images.length)) {
              const toAdd = m.images.slice(imgCount, MAX_IMAGES);
              for (const src of toAdd) {
                try {
                  if (DEBUG) console.log("Subiendo imagen:", src);
                  await restPost(`products/${prodIdNum}/images.json`, { image: { src } });
                  await wait(400);
                } catch (e) {
                  console.error("add image error:", src, e?.response?.data || e?.message || e);
                }
              }
            }
          }
          updated++;
        } else {
          const res = await productCreate({
            title: m.title,
            descriptionHtml: m.descriptionHtml,
            vendor: m.vendor,
            productType: m.productType,
            images: m.images,
          });
          if (SET_PRICE) await updateVariantPrice(res.productId, res.variantId, m.price);
          await updateVariantWeight(res.variantId, m.weightKg);
          await setInventorySku(res.inventoryItemId, m.sku, m.barcode);
          await updateInventoryCost(res.inventoryItemId, m.cost);
          await adjustInventory(res.inventoryItemId, location, m.available);
          await publishProduct(res.productId, publicationId);

          if (!res.createdWithMedia && m.images?.length) {
            const prodIdNum = String(res.productId).replace(/\D/g, "");
            for (const src of m.images.slice(0, MAX_IMAGES)) {
              try {
                if (DEBUG) console.log("Subiendo imagen (nuevo):", src);
                await restPost(`products/${prodIdNum}/images.json`, { image: { src } });
                await wait(400);
              } catch (e) {
                console.error("add image error:", src, e?.response?.data || e?.message || e);
              }
            }
          }
          created++;
        }
      } catch (err) {
        errors++;
        console.error("Error con producto", p.id || p.producto_id || p.pid, err?.response?.data || err?.message || err);
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
