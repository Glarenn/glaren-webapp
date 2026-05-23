const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// PostgreSQL bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabloyu otomatik oluştur
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

// Yazdırılan siparişleri getir
app.get("/api/printed", async (req, res) => {
  try {
    const result = await pool.query("SELECT id FROM printed_orders");
    const ids = result.rows.map(r => Number(r.id));
    res.json({ ids });
  } catch (e) {
    console.error("printed GET hatası:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Yazdırılan siparişleri kaydet (tüm liste)
app.post("/api/printed", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids dizisi gereklidir." });
  try {
    await pool.query("DELETE FROM printed_orders");
    if (ids.length > 0) {
      const values = ids.map((id, i) => `($${i + 1})`).join(",");
      await pool.query(`INSERT INTO printed_orders (id) VALUES ${values}`, ids);
    }
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    console.error("printed POST hatası:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Tek siparişin yazdırma işaretini kaldır
app.delete("/api/printed/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM printed_orders WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("printed DELETE hatası:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Trendyol API proxy endpoint
app.get("/api/orders", async (req, res) => {
  const sellerId = process.env.SELLER_ID || req.query.sellerId;
  const apiKey = process.env.API_KEY || req.query.apiKey;
  const apiSecret = process.env.API_SECRET || req.query.apiSecret;
  const { status = "Created", size = 50, page = 0 } = req.query;
  if (!sellerId || !apiKey || !apiSecret) {
    return res.status(400).json({ error: "sellerId, apiKey ve apiSecret zorunludur." });
  }
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const url = `https://apigw.trendyol.com/integration/order/sellers/${sellerId}/orders?status=${status}&size=${size}&page=${page}`;
  try {
    const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");
    const response = await fetchFn(url, {
      headers: {
        "Authorization": `Basic ${credentials}`,
        "User-Agent": `${sellerId} - SelfIntegration`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }
    const orders = data.content || [];
    await Promise.all(
      orders.map(async (order) => {
        await Promise.all(
          (order.lines || []).map(async (line) => {
            if (!line.barcode) return;
            try {
              const productUrl = `https://apigw.trendyol.com/integration/product/sellers/${sellerId}/products?barcode=${encodeURIComponent(line.barcode)}&size=1`;
              const productRes = await fetchFn(productUrl, {
                headers: {
                  "Authorization": `Basic ${credentials}`,
                  "User-Agent": `${sellerId} - SelfIntegration`,
                  "Content-Type": "application/json",
                },
              });
              if (productRes.ok) {
                const productData = await productRes.json();
                const product = productData.content?.[0];
                if (product?.images?.[0]?.url) {
                  line.productImage = product.images[0].url;
                }
              }
            } catch (e) {}
          })
        );
      })
    );
    res.json(data);
  } catch (err) {
    console.error("Trendyol API hatası:", err.message);
    res.status(500).json({ error: "Trendyol API'ye ulaşılamadı: " + err.message });
  }
});

// Config kontrolü
app.get("/api/config", (req, res) => {
  res.json({
    hasConfig: !!(process.env.SELLER_ID && process.env.API_KEY && process.env.API_SECRET),
    sellerId: process.env.SELLER_ID || null
  });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server çalışıyor: http://localhost:${PORT}`);
});
