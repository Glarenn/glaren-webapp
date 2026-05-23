const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path"); // YENİ EKLENDİ
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// YENİ: Vite'ın derlediği production klasörünü serve et
app.use(express.static(path.join(__dirname, "dist")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS printed_orders (
        id BIGINT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ Veritabanı hazır");
  } catch (e) {
    console.error("❌ Veritabanı hatası:", e.message);
  }
}
initDB();

app.get("/api/printed", async (req, res) => { /* ... Eski kodun aynısı ... */ 
  try {
    const result = await pool.query("SELECT id FROM printed_orders");
    const ids = result.rows.map(r => Number(r.id));
    res.json({ ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/printed", async (req, res) => { /* ... Eski kodun aynısı ... */ 
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids dizisi gereklidir." });
  try {
    await pool.query("DELETE FROM printed_orders");
    if (ids.length > 0) {
      const values = ids.map((id, i) => `($${i + 1})`).join(",");
      await pool.query(`INSERT INTO printed_orders (id) VALUES ${values}`, ids);
    }
    res.json({ ok: true, count: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/printed/:id", async (req, res) => { /* ... Eski kodun aynısı ... */ 
  try {
    await pool.query("DELETE FROM printed_orders WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/orders", async (req, res) => { /* ... Eski kodun aynısı ... */ 
  const sellerId = process.env.SELLER_ID || req.query.sellerId;
  const apiKey = process.env.API_KEY || req.query.apiKey;
  const apiSecret = process.env.API_SECRET || req.query.apiSecret;
  const { status = "Created", size = 50, page = 0 } = req.query;
  if (!sellerId || !apiKey || !apiSecret) return res.status(400).json({ error: "Eksik yetki." });
  
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const url = `https://apigw.trendyol.com/integration/order/sellers/${sellerId}/orders?status=${status}&size=${size}&page=${page}`;
  try {
    const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");
    const response = await fetchFn(url, { headers: { "Authorization": `Basic ${credentials}` } });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    
    // Ürün resimlerini çekme işlemi (Eski kodunuzla aynı)
    const orders = data.content || [];
    await Promise.all(orders.map(async (order) => {
        await Promise.all((order.lines || []).map(async (line) => {
            if (!line.barcode) return;
            try {
              const productUrl = `https://apigw.trendyol.com/integration/product/sellers/${sellerId}/products?barcode=${encodeURIComponent(line.barcode)}&size=1`;
              const productRes = await fetchFn(productUrl, { headers: { "Authorization": `Basic ${credentials}` } });
              if (productRes.ok) {
                const productData = await productRes.json();
                if (productData.content?.[0]?.images?.[0]?.url) line.productImage = productData.content[0].images[0].url;
              }
            } catch (e) {}
        }));
    }));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/config", (req, res) => {
  res.json({
    hasConfig: !!(process.env.SELLER_ID && process.env.API_KEY && process.env.API_SECRET),
    sellerId: process.env.SELLER_ID || null
  });
});

// YENİ: React Router için Catch-all route (SPA desteği)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
});
