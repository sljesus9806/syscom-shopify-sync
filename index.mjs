import axios from "axios";

// ====== VARIABLES DE ENTORNO ======
const SHOP                 = process.env.SHOP;
const ADMIN_TOKEN          = process.env.ADMIN_TOKEN;
const SYSCOM_CLIENT_ID     = process.env.SYSCOM_CLIENT_ID;
const SYSCOM_CLIENT_SECRET = process.env.SYSCOM_CLIENT_SECRET;

const MODE      = process.env.SYSCOM_MODE  || "search";   // "search" | "brand"
const QUERY     = process.env.SYSCOM_QUERY || "camaras";
const RUN_PAGES = parseInt(process.env.RUN_PAGES || "2", 10);
const SLEEP_MS  = parseInt(process.env.SLEEP_MS  || "900", 10);

// Debug y filtro de stock (puedes controlarlos con Variables del workflow)
const DEBUG          = process.env.DEBUG === "1";
const ONLY_STOCK     = process.env.SYSCOM_ONLY_STOCK !== "0"; // true = solo con stock

// ====== ENDPOINTS SYSCOM ======
const SYS_OAUTH = "https://developers.syscom.mx/oauth/token";
const SYS_BASE  = "https://developers.syscom.mx/api/v1";

// Utilidad para esperar
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ====== SYSCOM HELPERS ======
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

// ====== SHOPIFY HELPERS ======
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
    .map((u) => ({ originalSource: u }))
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

async function updateVariantPrice(productId, variantId, price) {
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

async function setInventorySku(inventoryItemId, sku) {
  const q = `
    mutation InvItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } }
    }`;
  const d = await gql(q, { id: inventoryItemId, input: { sku, tracked: true } });
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

// ====== MAPEO DESDE SYSCOM ======
function mapSyscomProduct(P) {
  const sku   = P.sku || P.codigo;
  const title = P.nombre || P.titulo;
  if (!sku || !title) return null;

  const desc   = P.descripcion_html || P.descripcion || "";
  const vendor = P.marca?.nombre || P.marca || "";
  const ptype  = P.categoria?.nombre || P.categoria || "";
  const price  = P.precio ?? P.precio_publico ?? 0;
  const qty    = P.existencia ?? P.stock ?? 0;

  let weight_kg = P.peso_kg ?? P.peso ?? 0;
  if (weight_kg > 100) weight_kg = weight_kg / 1000;

  const images = [];
  if (Array.isArray(P.imagenes)) {
    for (const img of P.imagenes) {
      if (typeof img === "string") { images.push(img); break; }
      if (img?.url)                 { images.push(img.url); break; }
    }
  }

  const barcode = P.barcode || P.ean || null;

  return {
    sku: String(sku),
    title: String(title),
    descriptionHtml: String(desc),
    vendor: String(vendor),
    productType: String(ptype),
    price,
    available: Number(qty),
    images,
    barcode,
  };
}

// ====== MAIN ======
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
      });
    } else {
      list = await sysget(token, `/productos`, {
        busqueda: QUERY,
        stock: (ONLY_STOCK ? 1 : 0),
        agrupar: 1,
        pagina: page,
      });
    }

    // Normalizamos posibles formas de respuesta
    const productos =
      list?.data?.productos || list?.data || list?.productos || list;

    // DEBUG
    if (DEBUG) {
      console.log(
        `Página ${page}: ${Array.isArray(productos) ? productos.length : 0} productos`
      );
      if (Array.isArray(productos)) {
        console.log(
          "Muestra:",
          productos.slice(0, 3).map((p) => p.sku || p.codigo || p.pid || p.id)
        );
      }
    }

    if (!Array.isArray(productos) || productos.length === 0) break;

    for (const p of productos) {
      try {
        const pid = p.id || p.producto_id || p.pid; // aceptar 'pid'
        if (!pid) continue;

        const det = await sysget(token, `/productos/${pid}`, {});
        const sp  = det.data || det;

        const m = mapSyscomProduct(sp);
        if (!m) continue;

        const exists = await findVariantBySku(m.sku);
        if (exists) {
          await updateVariantPrice(exists.product.id, exists.id, m.price);
          await setInventorySku(exists.inventoryItem.id, m.sku);
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
          await updateVariantPrice(res.productId, res.variantId, m.price);
          await setInventorySku(res.inventoryItemId, m.sku);
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

// Arranque
main().catch((e) => {
  console.error(e?.response?.data || e?.message || e);
  process.exit(1);
});
