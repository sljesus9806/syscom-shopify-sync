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

// Preferencia de campos de precio desde Syscom.precios (orden de prioridad)
const PRICE_PREF = (process.env.SYSCOM_PRICE_PREF || "especial,oferta,descuento,precio,publico,lista")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Poner también ese valor como “Precio” en la variante (opcional)
const SET_PRICE  = process.env.SET_PRICE === "1";

// Moneda y conversión
const FORCED_CURRENCY = (process.env.FORCED_CURRENCY || "MXN").toUpperCase();
const USD_MXN  = Number(process.env.USD_MXN || "17.0");   // TC para convertir USD->MXN si hiciera falta
const ADD_VAT_ON_COST = process.env.ADD_VAT_ON_COST === "1"; // si true, costo *= 1.16

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

function toMXN(value, moneda) {
  if (!(value > 0)) return 0;
  if (!moneda) return value;
  if (/usd/i.test(String(moneda))) return value * USD_MXN;
  return value; // asumimos MXN u otra ya en pesos
}

function normUrl(u) {
  if (!u || typeof u !== "string") return "";
  // Asegura https
  return u.replace(/^http:\/\//i, "https://");
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
    .map((u) => ({ originalSource: normUrl(u) }))
    .slice(0, 10);

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

/* ====== (opcional) actualizar SOLO PRECIO por GraphQL ====== */
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
    variants: [{ id: variantId, price: String(price) }],
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
  const d = await gql(q, { id: inventoryItemId, input: { cost: String(cost) } });
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
  // Nombres comunes: especial, oferta, descuento, precio, publico, lista
  for (const k of PRICE_PREF) {
    if (k in precios) {
      const val = firstNumber(precios[k]);
      if (val > 0) return val;
    }
  }
  // Fallback: toma el menor número positivo encontrado
  const candidates = Object.values(precios)
    .map(firstNumber)
    .filter(n => n > 0);
  return candidates.length ? Math.min(...candidates) : 0;
}

function collectImagesFromSyscom(P) {
  const out = new Set();

  const pushStr = (s) => { if (s && typeof s === "string") out.add(normUrl(s)); };
  const pushMaybeObj = (x) => {
    if (!x) return;
    if (typeof x === "string") pushStr(x);
    else if (typeof x === "object") {
      pushStr(x.url || x.src || x.original || x.image || "");
    }
  };

  // Arrays conocidas
  if (Array.isArray(P.imagenes))  P.imagenes.forEach(pushMaybeObj);
  if (Array.isArray(P.fotos))     P.fotos.forEach(pushMaybeObj);
  if (Array.isArray(P.imagen_360))P.imagen_360.forEach(pushMaybeObj);

  // Campos individuales
  pushMaybeObj(P.img_portada);
  pushMaybeObj(P.imagen);
  pushMaybeObj(P.foto);

  // Filtra basura / no-imagen
  const urls = Array.from(out).filter(u =>
    /\.(png|jpe?g|webp|gif|bmp|tiff)(\?|#|$)/i.test(u)
  );

  // Si no detectó extensión pero es probable imagen (algunos endpoints devuelven .PNG en mayúsculas o sin query)
  if (!urls.length && typeof P.img_portada === "string") pushStr(P.img_portada);

  return urls.slice(0, 10);
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

  // Precio (costo) – preferimos precios.especial/oferta/... (sin IVA)
  const precios = P.precios || {};
  // Moneda reportada por Syscom si viene
  const moneda = precios.moneda || precios.currency || P.moneda || P.currency || FORCED_CURRENCY;

  let rawCost = pickPriceFromPrecios(precios) ||
                firstNumber(P.precio, P.precio_publico, P.precio_lista);
  let costMXN = toMXN(rawCost, moneda);
  if (ADD_VAT_ON_COST && costMXN > 0) costMXN = +(costMXN * 1.16).toFixed(2);

  // existencias totales
  const qty = firstNumber(P.existencia, P.stock, P.total_existencia);

  // peso (si viene en gramos, lo normalizamos a kg)
  let weightKg = firstNumber(P.peso_kg, P.peso);
  if (weightKg > 100) weightKg = weightKg / 1000;

  // imágenes
  const images = collectImagesFromSyscom(P);

  const barcode =
    P.codigo_barras || P.codigo_barras_ean || P.ean || P.barcode || P.gtin || P.upc || null;

  if (DEBUG) {
    try {
      console.log("Moneda Syscom detectada:", moneda, "Costo elegido:", costMXN, "Raw:", rawCost);
      if (precios && Object.keys(precios).length) {
        console.log("Precios Syscom:", JSON.stringify(precios));
      }
      if (images?.length) {
        console.log("Imágenes detectadas:", images.slice(0, 3));
      }
    } catch {}
  }

  return {
    sku: String(sku),
    title: String(title),
    descriptionHtml: String(desc),
    vendor: String(vendor),
    productType: String(ptype),
    cost: Number(costMXN) || 0,   // <== costo proveedor (irá a “Costo por artículo”)
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

  let created = 0, updated = 0, errors = 0;

  for (let page = 1; page <= RUN_PAGES; page++) {
    let list;

    if (MODE === "brand") {
      list = await sysget(token, `/marcas/${QUERY}/productos`, {
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
        moneda: FORCED_CURRENCY,           // <=== forzamos MXN
      });
    } else {
      list = await sysget(token, `/productos`, {
        busqueda: QUERY,
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
        moneda: FORCED_CURRENCY,           // <=== forzamos MXN
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

        const det = await sysget(token, `/productos/${pid}`, { moneda: FORCED_CURRENCY }); // <=== MXN
        const sp  = det.data || det;

        const m = mapSyscomProduct(sp);
        if (!m) continue;

        const exists = await findVariantBySku(m.sku);
        if (exists) {
          if (SET_PRICE) await updateVariantPrice(exists.product.id, exists.id, m.cost); // opcional
          await updateVariantWeight(exists.id, m.weightKg);
          await setInventorySku(exists.inventoryItem.id, m.sku, m.barcode);
          await updateInventoryCost(exists.inventoryItem.id, m.cost);                     // COSTO
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
          if (SET_PRICE) await updateVariantPrice(res.productId, res.variantId, m.cost);  // opcional
          await updateVariantWeight(res.variantId, m.weightKg);
          await setInventorySku(res.inventoryItemId, m.sku, m.barcode);
          await updateInventoryCost(res.inventoryItemId, m.cost);                         // COSTO
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
