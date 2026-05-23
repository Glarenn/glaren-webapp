import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

const Barcode = ({ value }) => {
  const svgRef = useRef();
  useEffect(() => {
    if (value && svgRef.current) {
      JsBarcode(svgRef.current, String(value), {
        format: "CODE128", width: 2.5, height: 55, displayValue: false, margin: 0, background: "#fff", lineColor: "#000"
      });
    }
  }, [value]);
  return <svg ref={svgRef} style={{ display: 'block', margin: '0 auto', maxWidth: '100%' }}></svg>;
};

const PrintTemplate = React.forwardRef(({ orders, settings, logoDataUrl }, ref) => {
  const fs = settings.fontSize;
  const w = settings.labelWidth;
  const h = settings.labelHeight;

  return (
    <div ref={ref} className="bg-white text-black">
      {orders.map((order, index) => {
        const addr = order.shipmentAddress;
        return (
          <div key={order.shipmentPackageId} className="page-break" style={{
            width: `${w}mm`, minHeight: `${h}mm`, padding: '2mm', boxSizing: 'border-box',
            fontFamily: settings.fontFamily, fontSize: `${fs}pt`, border: '1px solid #ccc', lineHeight: 1.35
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1.5px solid #000', paddingBottom: '2mm', marginBottom: '2.5mm' }}>
              <div style={{ maxWidth: '55%' }}>
                {logoDataUrl 
                  ? <img src={logoDataUrl} alt="logo" style={{ maxHeight: '12mm', maxWidth: '45mm', objectFit: 'contain' }} />
                  : <div style={{ fontWeight: 'bold', fontSize: `${fs + 2}pt` }}>{settings.storeName || "LOGO"}</div>
                }
              </div>
              <div style={{ textAlign: 'right', fontWeight: 'bold', fontSize: `${fs + 1}pt` }}>{order.cargoProviderName}</div>
            </div>

            <div style={{ marginBottom: '2.5mm' }}>
              <div style={{ fontSize: `${fs - 2}pt`, color: '#555', textTransform: 'uppercase' }}>ALICI</div>
              <div style={{ fontWeight: 'bold', fontSize: `${fs + 5}pt`, lineHeight: 1.15 }}>{addr.firstName} {addr.lastName}</div>
              <div style={{ fontSize: `${fs}pt`, marginTop: '0.5mm' }}>{addr.address1}</div>
              <div style={{ fontSize: `${fs}pt` }}>{addr.district} / {addr.city} {addr.postalCode}</div>
            </div>

            {settings.showProducts && order.lines.length > 0 && (
              <div style={{ borderTop: '1px dashed #bbb', borderBottom: '1px dashed #bbb', padding: '1.5mm 0', marginBottom: '2.5mm', fontSize: `${fs - 1}pt` }}>
                <div style={{ fontSize: `${fs - 2}pt`, color: '#555' }}>ÜRÜNLER</div>
                {order.lines.slice(0, 4).map((l, i) => (
                  <div key={i} style={{ marginTop: '0.5mm' }}>
                    {l.quantity}x {l.productName}
                    {l.barcode && <span style={{ color: '#555', marginLeft: '2mm', fontSize: `${fs - 2}pt` }}>[{l.barcode}]</span>}
                  </div>
                ))}
                {order.lines.length > 4 && <div style={{ marginTop: '0.5mm', color: '#888', fontStyle: 'italic' }}>+ {order.lines.length - 4} ürün daha</div>}
              </div>
            )}

            <div style={{ textAlign: 'center', marginTop: '1mm' }}>
              <Barcode value={order.cargoTrackingNumber} />
              <div style={{ fontFamily: 'monospace', fontSize: `${fs + 1}pt`, letterSpacing: '1.5px', marginTop: '1mm' }}>
                {order.cargoTrackingNumber}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export default PrintTemplate;
