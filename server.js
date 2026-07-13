const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const pgSession = require("connect-pg-simple")(session);
const app = express();
const PORT = process.env.PORT || 3001;

// ===================== YAPILANDIRMA =====================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-in-production";
// FIX 5: CORS kısıtlaması — Railway URL'inizi ALLOWED_ORIGIN olarak ayarlayın
// Railway dashboard → Variables → ALLOWED_ORIGIN = https://glaren.up.railway.app
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3001";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 dakika

// Şifreyi hash'le (uygulama başlarken bir kere yapılır)
let passwordHash = "";
bcrypt.hash(ADMIN_PASSWORD, 10).then(hash => {
  passwordHash = hash;
  console.log("✅ Auth hazır");
});

// ===================== POSTGRESQL BAĞLANTISI =====================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===================== GÜVENLIK MİDDLEWARE'LERİ =====================

// FIX 2: Güvenlik header'ları (clickjacking, XSS, MIME sniffing koruması)
app.use(helmet({
  contentSecurityPolicy: false, // Babel CDN kullandığı için kapalı
}));

// FIX 5: CORS kısıtlaması — sadece kendi URL'imize izin ver
app.use(cors({
  origin: ALLOWED_ORIGIN,
  credentials: true,
}));

app.use(express.json());

// Railway / Heroku reverse proxy için HTTPS güveni
app.set("trust proxy", 1);

// FIX 4: Session'ları PostgreSQL'e taşı (deploy'larda oturum korunur, memory leak yok)
app.use(session({
  store: new pgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true,  // Tabloyu otomatik oluştur
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                                    // XSS koruması
    sameSite: "lax",                                   // CSRF koruması
    secure: process.env.NODE_ENV === "production",     // Sadece HTTPS
    maxAge: 8 * 60 * 60 * 1000,                       // 8 saat
  },
}));

// Statik dosyalar
app.use(express.static("public"));

// ===================== DB BAŞLATMA =====================

async function initDB() {
  try {
    // Yazdırılan siparişler tablosu
    await pool.query(`
      CREATE TABLE IF NOT EXISTS printed_orders (
        id BIGINT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // FIX 3: Brute-force tablosu (bellekten DB'ye taşındı, restart'ta sıfırlanmaz)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        count INT DEFAULT 1,
        first_attempt TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("✅ Veritabanı hazır");
  } catch (e) {
    console.error("❌ Veritabanı hatası:", e.message);
  }
}
initDB();

// ===================== FIX 3: DB TABANLI BRUTE-FORCE KORUMASI =====================

async function checkBruteForce(ip) {
  try {
    // Süresi geçmiş kayıtları temizle
    await pool.query(
      "DELETE FROM login_attempts WHERE first_attempt < NOW() - INTERVAL '15 minutes'"
    );
    const result = await pool.query("SELECT count FROM login_attempts WHERE ip = $1", [ip]);
    if (!result.rows.length) return { blocked: false };
    const count = result.rows[0].count;
    if (count >= MAX_ATTEMPTS) {
      const timeRes = await pool.query(
        "SELECT CEIL(EXTRACT(EPOCH FROM (first_attempt + INTERVAL '15 minutes' - NOW())) / 60) AS mins FROM login_attempts WHERE ip = $1",
        [ip]
      );
      const remaining = Math.max(1, timeRes.rows[0]?.mins || 1);
      return { blocked: true, remaining };
    }
    return { blocked: false };
  } catch (e) {
    return { blocked: false }; // DB hatasında engelleme
  }
}

async function recordFailedAttempt(ip) {
  try {
    await pool.query(`
      INSERT INTO login_attempts (ip, count, first_attempt)
      VALUES ($1, 1, NOW())
      ON CONFLICT (ip) DO UPDATE SET count = login_attempts.count + 1
    `, [ip]);
  } catch (e) {}
}

async function clearAttempts(ip) {
  try {
    await pool.query("DELETE FROM login_attempts WHERE ip = $1", [ip]);
  } catch (e) {}
}

// ===================== AUTH ENDPOINT'LERİ =====================

// Oturum durumu sorgula
app.get("/auth/status", (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Giriş
app.post("/auth/login", async (req, res) => {
  const ip = req.ip;

  const bruteCheck = await checkBruteForce(ip);
  if (bruteCheck.blocked) {
    return res.status(429).json({
      error: `Çok fazla başarısız deneme. ${bruteCheck.remaining} dakika sonra tekrar deneyin.`
    });
  }

  const { password } = req.body;

  // FIX 6: Şifre uzunluk kontrolü
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Geçersiz şifre." });
  }

  const match = await bcrypt.compare(password, passwordHash);
  if (!match) {
    await recordFailedAttempt(ip);
    const entry = await pool.query("SELECT count FROM login_attempts WHERE ip = $1", [ip]);
    const count = entry.rows[0]?.count || 1;
    const remaining = Math.max(0, MAX_ATTEMPTS - count);
    return res.status(401).json({
      error: remaining > 0
        ? `Hatalı şifre. ${remaining} deneme hakkınız kaldı.`
        : `Hesap kilitlendi. 15 dakika sonra tekrar deneyin.`
    });
  }

  await clearAttempts(ip);

  // FIX 1: Session Fixation — giriş sonrası session ID'yi yenile
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Oturum hatası." });
    req.session.authenticated = true;
    req.session.loginTime = new Date().toISOString();
    req.session.save((err2) => {
      if (err2) return res.status(500).json({ error: "Oturum kaydedilemedi." });
      res.json({ ok: true });
    });
  });
});

// Çıkış
app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// ===================== API KORUMA KATMANI =====================

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: "Oturum açmanız gerekiyor.", code: "UNAUTHORIZED" });
}

app.use("/api", requireAuth);



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
