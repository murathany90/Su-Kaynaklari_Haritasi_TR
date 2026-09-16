# Türkiye Su Kaynakları Haritası

React + Vite + TailwindCSS v4 + Zustand + Vanilla MapLibre GL JS ile hazırlanmış
hidroloji/GIS panelidir. Harita çizimleri native GeoJSON source/layer olarak
MapLibre'ye eklenir; basemap erişilemese bile yerel katmanlar yeniden denenir.

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
python tools/hydro/build_all.py
```

`HYDRO_FETCH=1` yalnız TATUS fetch adımlarını da çalıştırır. Harici servis
başarısız olduğunda mevcut cache korunur; eksik veri N/A/partial olarak raporlanır.

## Veri kalitesi ve kaynaklar

Kanonik HES paketi `docs/HES_177_Zenginlestirilmis_Envanter_v3.xlsx` ve build-time
TATUS katmanlarından üretilir. `riverNamedCount` ile
`riverSpatialVerifiedCount` ayrı tutulur; trafo koordinatları yalnızca yaklaşık
elektriksel bağlantı noktasıdır ve gerçek HES koordinatı olarak raporlanmaz.

Akarsu geometrileri HydroRIVERS ve TATUS segmentlerinden mantıksal sistemlere
indirgenir. `public/data/hes177/river_topology_audit.json` segment, bağlı bileşen
ve kopuk parça metriklerini içerir. `hes_177_relations.json` runtime ilişkilerinin
tek canonical kaynağıdır.

Rezervuar poligonları yalnızca build-time GDW Turkey envelope sorgusundan isim +
koordinat kontrolü geçen kayıtlarla `hes_reservoirs.geojson` dosyasına alınır.
GDW künye bilgisi harita attribution kontrolünde gösterilir. Kaynaklar:
[GDW Reservoir layer](https://services8.arcgis.com/oTalEaSXAuyNT7xf/ArcGIS/rest/services/GDW_v1_epsilon_gdb/FeatureServer/1)
ve [OpenStreetMap attribution](https://www.openstreetmap.org/copyright).

Doluluk resolver'ı önce doğrulanmış EPİAŞ kaydını, sonra uydu/alternatif
kaynakları, sonra semantiği doğrulanmış hacim hesabını kullanır. Aktif hacim
hesabı `aktif hacim / (maksimum hacim - minimum hacim)` olarak işaretlenir;
verisi olmayan tesis `N/A` kalır. Run-of-river tesislerde doluluk
`not_applicable`'dır. MOCK değerleri yalnızca
`VITE_ENABLE_MOCK_HYDROLOGY=true` ile geliştirme ortamında açılır.

Kaynak denetimi `public/data/hes177/fullness_source_audit.json` ve `reports/`
altındaki CSV/Markdown raporlarını üretir. DAHITI ve Hydroweb.next gibi
alternatiflerin istasyon/ürün eşleşmesi kanıtlanmadan kapsam metriğine eklenmez:
[DAHITI API docs](https://dahiti.dgfi.tum.de/en/api/doc/v2/) ve
[Hydroweb.next help](https://hydroweb.next.theia-land.fr/help).

`tools/hydro/fetch_observation_catalogs.py`, Hydroweb STAC ve Copernicus CLMS
lake-water-level ürün kataloglarından yalnız küçük keşif metadata'sı indirir.
Katalog eşleşmesi ölçüm değeri değildir: API anahtarı/token olmadan kayıtlar
`catalog_available` olarak audit'e girer, doluluk yüzdesine çevrilmez. DAHITI,
SWOT, DSİ ve G-REALM erişimi için gereken kimlik bilgileri yalnız CI secret
olarak verilebilir; frontend'e taşınmaz. Copernicus ürün kataloğu için
[CLMS lake water level](https://land.copernicus.eu/en/products/water-bodies/water-level-lakes-near-real-time-v2.0)
ve [CDSE CLMS documentation](https://documentation.dataspace.copernicus.eu/Data/CopernicusServices/CLMS.html)
kullanılır. `public/data/static/mappings/observation_catalogs.json` kaynak,
indirilen zaman, sürüm, ETag ve checksum bilgisini saklar.

Latest doluluk sözleşmesi `public/data/live/hes_fullness_latest.json` içinde
`pipelineRunAt` (pipeline çalışması) ve `latestObservationAt` (gerçek son
gözlem) alanlarını ayrı tutar. Kaynak kesintisinde son geçerli kayıt
`last-known-good` olarak stale işaretlenir; yeni `N/A` ile silinmez. Günlük
history snapshot'ları GitHub Actions tarafından ana branch'ten ayrı
`data-history` branch'ine `data/history/fullness/YYYY/MM/YYYY-MM-DD.json`
olarak append/idempotent biçimde yazılır. Frontend ilk açılışta history
indirmez; HES seçildiğinde versioned `data/timeseries/hes_fullness_365d.json`
dosyasını lazy yükler. Harici producer taşınırken veri kökü
`VITE_HYDROLOGY_DATA_BASE_URL` ile değiştirilebilir.

Kaynak yenileme cadence'i workflow içinde ayrıdır: EPİAŞ/GEOGLOWS yaklaşık
6 saat, gözlem katalogları günlük, TATUS/HydroRIVERS/rezervuar geometrisi
haftalık çalışır. `python tools/hydro/test_fullness_quality.py` framework
eklemeden source priority, future observation, LKG ve history dedupe
kontrollerini çalıştırır.

Kanonik koordinat kalite enum'u `hes`, `dam`, `reservoir`, `transformer`,
`approximate`, `unresolved` değerleridir. `transformer` kaydı yalnız elektrik
bağlantı referansıdır; havza doğrulamasını override etmez, gerçek HES/nehir
ankrajı sayılmaz. Akarsu sistemi geometrisi, HES/dam ankrajları arasında
HydroRIVERS ağı üzerinde route edilir; provider'dan geometri gelmezse yalnız
isimli, geometrisi olmayan kanonik kayıt tutulur ve bu durum `geometryAvailable`
ile açıkça belirtilir.

## Harita davranışı

Sidebar'daki canonical HES kayıtlarına tıklamak `flyTo` veya `fitBounds` ile
seçilen nokta/çizgi/poligona gider. Stil değişimlerinde kaynak ve çizim
katmanları `ensureHydrologyOverlay` ile yeniden kurulur. MapLibre worker Vite
asset URL'sine bağlı olduğu için GeoJSON çizimleri altlık yükünden bağımsızdır.
