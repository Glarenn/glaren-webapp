const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const app = express();
const PORT = process.env.PORT || 3001;

// ===================== AUTH YAPILANDIRMASI =====================

// Brute-force koruması: IP başına deneme sayısı
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 dakika

function checkBruteForce(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { blocked: false };
  if (Date.now() - entry.firstAttempt > LOCKOUT_MS) {
    loginAttempts.delete(ip);
    return { blocked: false };
  }
  if (entry.count >= MAX_ATTEMPTS) {
    const remaining = Math.ceil((LOCKOUT_MS - (Date.now() - entry.firstAttempt)) / 60000);
    return { blocked: true, remaining };
  }
  return { blocked: false };
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
  entry.count += 1;
  loginAttempts.set(ip, entry);
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// Ortam değişkenlerinden alınan şifre (ADMIN_PASSWORD)
// Railway dashboard → Variables bölümünden ayarlayın
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-in-production";

// Şifreyi hash'le (uygulama başlarken bir kere yapılır)
let passwordHash = "";
bcrypt.hash(ADMIN_PASSWORD, 10).then(hash => {
  passwordHash = hash;
  console.log("✅ Auth hazır");
});

app.use(cors());
app.use(express.json());

// Session middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                          // JS ile okunamaz (XSS koruması)
    sameSite: "lax",                         // CSRF koruması
    secure: process.env.NODE_ENV === "production", // Production'da HTTPS zorunlu
    maxAge: 8 * 60 * 60 * 1000,             // 8 saat
  },
}));

// Statik dosyalar (login sayfası dahil)
app.use(express.static("public"));

// ===================== AUTH ENDPOINT'LERİ =====================

// Oturum durumu sorgula
app.get("/auth/status", (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Giriş
app.post("/auth/login", async (req, res) => {
  const ip = req.ip;
  const bruteCheck = checkBruteForce(ip);
  if (bruteCheck.blocked) {
    return res.status(429).json({
      error: `Çok fazla başarısız deneme. ${bruteCheck.remaining} dakika sonra tekrar deneyin.`
    });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Şifre gereklidir." });
  }

  const match = await bcrypt.compare(password, passwordHash);
  if (!match) {
    recordFailedAttempt(ip);
    const entry = loginAttempts.get(ip);
    const remaining = entry ? MAX_ATTEMPTS - entry.count : MAX_ATTEMPTS;
    return res.status(401).json({
      error: remaining > 0
        ? `Hatalı şifre. ${remaining} deneme hakkınız kaldı.`
        : `Hesap kilitlendi. 15 dakika sonra tekrar deneyin.`
    });
  }

  clearAttempts(ip);
  req.session.authenticated = true;
  req.session.loginTime = new Date().toISOString();
  res.json({ ok: true });
});

// Çıkış
app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// ===================== API KORUMA KATMANI =====================

// Tüm /api/* endpoint'leri bu middleware'den geçer
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: "Oturum açmanız gerekiyor.", code: "UNAUTHORIZED" });
}

app.use("/api", requireAuth);

// ===================== POSTGRESQL BAĞLANTISI =====================

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

// Trendyol API proxy - Siparişler
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

// Trendyol API proxy - Ürün Listesi
app.get("/api/products", async (req, res) => {
  const sellerId = process.env.SELLER_ID;
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  if (!sellerId || !apiKey || !apiSecret) {
    return res.status(400).json({ error: "API bilgileri eksik." });
  }
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const { page = 0, size = 50, name, barcode } = req.query;

  // Barkod araması için: Trendyol tam eşleşme yaptığından, barkod varsa
  // server'a göndermiyoruz — dönen sonuçları burada "içerir" mantığıyla filtreliyoruz.
  let url = `https://apigw.trendyol.com/integration/product/sellers/${sellerId}/products?page=${page}&size=${size}&approved=true&archived=false`;
  if (name) url += `&name=${encodeURIComponent(name)}`;

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
    if (!response.ok) return res.status(response.status).json({ error: data });

    // Barkod "içerir" filtresi — server tarafında uygula
    if (barcode && barcode.trim()) {
      const q = barcode.trim().toLowerCase();
      data.content = (data.content || []).filter(p =>
        (p.barcode || "").toLowerCase().includes(q)
      );
      data.totalElements = data.content.length;
    }

    res.json(data);
  } catch (err) {
    console.error("Ürün listesi hatası:", err.message);
    res.status(500).json({ error: "Trendyol API'ye ulaşılamadı: " + err.message });
  }
});

// Trendyol API proxy - Stok Güncelleme
app.post("/api/products/stock", async (req, res) => {
  const sellerId = process.env.SELLER_ID;
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  if (!sellerId || !apiKey || !apiSecret) {
    return res.status(400).json({ error: "API bilgileri eksik." });
  }
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items dizisi gereklidir." });
  }
  const url = `https://apigw.trendyol.com/integration/inventory/sellers/${sellerId}/products/price-and-inventory`;
  const payload = {
    items: items.map(item => ({
      barcode: item.barcode,
      quantity: Number(item.quantity),
      salePrice: Number(item.salePrice),
      listPrice: Number(item.listPrice),
    }))
  };
  console.log("Stok güncelleme isteği:", JSON.stringify(payload));
  try {
    const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "User-Agent": `${sellerId} - SelfIntegration`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    console.log("Stok güncelleme cevabı:", JSON.stringify(data));
    if (!response.ok) return res.status(response.status).json({ error: data });
    res.json(data);
  } catch (err) {
    console.error("Stok güncelleme hatası:", err.message);
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
