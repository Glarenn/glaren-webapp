import React, { useState, useEffect, useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import { loadPrinted, savePrinted, removePrinted } from './api/api';
import PrintTemplate from './components/PrintTemplate';

export default function App() {
  const [orders, setOrders] = useState([]);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [printedOrders, setPrintedOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Arayüz state'leri
  const [search, setSearch] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState('/text-1773078104872.png');
  const [settings, setSettings] = useState({
    labelWidth: 100, labelHeight: 100,
    fontFamily: "Arial, sans-serif", fontSize: 8,
    storeName: "Mağaza Adım", showProducts: true,
  });

  const printRef = useRef();

  useEffect(() => {
    loadPrinted().then(setPrintedOrders).catch(console.error);
    fetchOrders(); // Sayfa açılınca API varsa otomatik çekmeyi dener
  }, []);

  const fetchOrders = async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/orders?status=Created&size=200`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Siparişler çekilemedi");
      setOrders(data.content || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    onAfterPrint: async () => {
      // Yazdırma işlemi bittikten sonra veritabanına kaydet
      const toPrintIds = selectedOrders;
      const newPrinted = [...new Set([...printedOrders, ...toPrintIds])];
      setPrintedOrders(newPrinted);
      await savePrinted(newPrinted);
      setSelectedOrders([]); // Yazdırıldıktan sonra seçimi temizle
    },
  });

  const toggleSelect = (id) => {
    setSelectedOrders(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleClearPrinted = async () => {
    if (window.confirm("Tüm yazdırıldı işaretleri kaldırılsın mı?")) {
      setPrintedOrders([]);
      await savePrinted([]);
    }
  };

  // Filtreleme
  const filtered = orders.filter(o => 
    (o.shipmentAddress.firstName + " " + o.shipmentAddress.lastName).toLowerCase().includes(search.toLowerCase()) ||
    (o.orderNumber || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="bg-brand-card border-b border-brand-border p-4 flex justify-between items-center shrink-0">
        <h1 className="font-bold text-lg tracking-wide">TRENDYOL KARGO PANELİ</h1>
        <div className="flex gap-4 items-center">
          <span className="text-brand-textMuted text-sm">
             Toplam: <strong className="text-white">{orders.length}</strong> | 
             Bekleyen: <strong className="text-brand-primary">{orders.length - printedOrders.length}</strong>
          </span>
          <button onClick={fetchOrders} disabled={loading} className="btn-primary py-1 px-3 text-sm">
            {loading ? "⏳ Yükleniyor" : "🔄 Yenile"}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar Liste */}
        <div className="w-[400px] bg-brand-input border-r border-brand-border flex flex-col shrink-0">
          <div className="p-4 border-b border-brand-border">
            <input 
              className="input-field mb-2" 
              placeholder="🔍 İsim veya Sipariş No Ara..." 
              value={search} onChange={e => setSearch(e.target.value)} 
            />
            {error && <div className="text-red-400 bg-red-900/20 p-2 rounded text-xs mt-2">{error}</div>}
            
            <div className="flex justify-between items-center mt-2">
              <button 
                onClick={() => setSelectedOrders(filtered.map(o => o.shipmentPackageId))}
                className="text-xs text-brand-primary hover:text-brand-primaryHover"
              >
                Tümünü Seç
              </button>
              <button onClick={() => setSelectedOrders([])} className="text-xs text-brand-textMuted">
                Seçimi Temizle
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {filtered.map(order => {
              const id = order.shipmentPackageId;
              const isSelected = selectedOrders.includes(id);
              const isPrinted = printedOrders.includes(id);

              return (
                <div 
                  key={id} 
                  onClick={() => toggleSelect(id)}
                  className={`p-3 rounded-lg cursor-pointer border transition-all ${
                    isSelected ? 'border-brand-primaryHover bg-brand-primary/10' : 
                    isPrinted ? 'border-brand-border bg-brand-bg opacity-60' : 'border-brand-border bg-brand-card hover:border-brand-textMuted'
                  }`}
                >
                  <div className="flex justify-between">
                    <div>
                      <div className="font-semibold text-sm">{order.shipmentAddress.firstName} {order.shipmentAddress.lastName}</div>
                      <div className="text-xs text-brand-textMuted mt-1">#{order.orderNumber}</div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] bg-brand-input border border-brand-border px-2 py-1 rounded text-brand-primary">
                        {order.cargoProviderName}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Yazdırma Ayarları ve Tetikleyici */}
        <div className="flex-1 p-6 bg-brand-bg overflow-y-auto flex flex-col items-center">
          <div className="w-full max-w-md bg-brand-card p-6 rounded-xl border border-brand-border shadow-xl">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
              🖨️ Yazdırma İşlemi
            </h2>
            
            <div className="mb-6 p-4 bg-brand-input rounded-lg text-center">
              <div className="text-2xl font-bold text-brand-primary">{selectedOrders.length}</div>
              <div className="text-brand-textMuted text-sm">sipariş seçildi</div>
            </div>

            <button 
              onClick={handlePrint} 
              disabled={selectedOrders.length === 0}
              className="w-full btn-primary py-3 text-lg mb-6 shadow-lg shadow-brand-primary/20"
            >
              Etiketleri Yazdır
            </button>

            {printedOrders.length > 0 && (
              <button onClick={handleClearPrinted} className="w-full btn-secondary text-xs mb-6">
                🗑️ Veritabanındaki Yazdırıldı Kayıtlarını Sıfırla
              </button>
            )}

            <hr className="border-brand-border mb-6"/>
            
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-brand-textMuted uppercase tracking-wide">⚙️ Etiket Ayarları</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-brand-textMuted mb-1">Genişlik (mm)</label>
                  <input type="number" className="input-field" value={settings.labelWidth} onChange={e => setSettings({...settings, labelWidth: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs text-brand-textMuted mb-1">Yükseklik (mm)</label>
                  <input type="number" className="input-field" value={settings.labelHeight} onChange={e => setSettings({...settings, labelHeight: e.target.value})} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-brand-textMuted mb-1">Mağaza Adı</label>
                  <input type="text" className="input-field" value={settings.storeName} onChange={e => setSettings({...settings, storeName: e.target.value})} />
                </div>
                <div className="col-span-2 flex items-center gap-2">
                  <input type="checkbox" id="showProds" checked={settings.showProducts} onChange={e => setSettings({...settings, showProducts: e.target.checked})} className="w-4 h-4 accent-brand-primary" />
                  <label htmlFor="showProds" className="text-sm text-brand-textMuted cursor-pointer">Ürünleri etiket üzerinde göster</label>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* GİZLİ YAZDIRMA ALANI */}
      <div style={{ display: "none" }}>
        <PrintTemplate 
          ref={printRef} 
          orders={orders.filter(o => selectedOrders.includes(o.shipmentPackageId))} 
          settings={settings} 
          logoDataUrl={logoDataUrl} 
        />
      </div>
      
    </div>
  );
}
