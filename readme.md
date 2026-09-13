# Türkiye Su Kaynakları Haritası

React + Vite + TailwindCSS v4 + Zustand + Vanilla MapLibre GL JS ile hazırlanmış
hidroloji/GIS paneli. Harita çizimleri native GeoJSON source/layer olarak
MapLibre’ye eklenir; basemap erişilemese bile yerel katmanlar yeniden denenir.

## Çalıştırma

```bash
npm install
npm run dev
npm run build
npm run lint
```

Gerçek statik veri üretmek için Python 3.12 ve `requests` gerekir:

```bash
pip install -r tools/hydro/requirements.txt
python tools/hydro/fetch_tatus.py
python tools/hydro/build_river_reach_map.py
python tools/hydro/fetch_geoglows.py
python tools/hydro/fetch_epias.py
```

Frontend veri akışı `src/services/hydroData.ts` → Zustand store → MapLibre
overlay şeklindedir. TATUS çıktıları `public/data/static/tatus` altında,
canlı adapter sonuçları `public/data/live` altında ve kaynak metadata’sı
`public/data/manifest` altında tutulur. Eksik harici servis erişimi boş/sentetik
olmayan bir veri durumu olarak gösterilir.

## Harita davranışı

Sidebar’daki gerçek TATUS kayıtlarına tıklamak `flyTo` veya `fitBounds` ile
seçilen nokta/çizgi/poligona gider. Stil değişimlerinde kaynak ve çizim katmanları
`ensureHydrologyOverlay` ile yeniden kurulur. MapLibre worker Vite asset URL’sine
bağlandığı için GeoJSON çizimleri altlık yükünden bağımsızdır.

Veri pipeline ayrıntıları ve dış servis erişim kararları için
[`HIDROLOJI_YOL_HARITASI.md`](HIDROLOJI_YOL_HARITASI.md) dosyasına bakın.
