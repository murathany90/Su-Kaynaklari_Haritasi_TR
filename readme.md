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

## HES doluluk veri pipeline''�

### Kaynak �nceli�i (resolver)

`official_live` > `official_published` > `satellite_volume`
> `satellite_altimetry` + hypsometry > `satellite_area` + hypsometry
> `calculated_storage` > `unavailable`. S�n�f �nce gelir; freshness ve
confidence ayn� s�n�f i�inde karar verir. D���k g�venli veri, daha iyi bir
kayna�� override edemez. 30 g�nl�k official ile 2 g�nl�k uydu �ak���rsa
politika (`PROVIDER_FRESHNESS_DAYS`): bayat official (�ncelik 4''e d��er)
yerine taze uydu se�ilir.

### �l��m / t�rev / tahmin

* `isEstimated=false` + `official_*` = do�rudan �l��m.
* `isEstimated=true` + `calculated_storage` = envanter hacim hesab�
  (`activeVolume / (maxVolume - minVolume)` � workbook "Aktif Hacim" aktif
  depolama miktar�d�r; g�ncel mutlak hacim ak��lar� `(current - min) /
  (max - min)` kullan�r).
* Uydu kot/alan g�zlemleri do�rulanm�� hypsometry
  (`public/data/static/mappings/reservoir_hypsometry.json`) olmadan y�zdeye
  �evrilmez; ham de�er + birim (`m`, `km2`) aynen yay�nlan�r.

### not_applicable / unavailable

* `run_of_river` (kanonik `storageType`, provenance + confidence ile) =
  `not_applicable`, `fullnessPercent=null`. `unavailable` say�lmaz.
* Di�er her �ey veri yoksa `unavailable`, `fullnessPercent=null`.
* Eksik de�erlerde asla `0` yaz�lmaz; `null` kullan�l�r. `>100` / `<0`
  hacim sonu�lar� sessizce clamp edilmez: audit uyar�s� + `qualityFlags`
  bayra�� �retilir.

### Fetch / observation cadence ve credentials

* Cron UTC''dir; T�rkiye = UTC+3. 6 saatlik ak�� 03/09/15/21 TR''de ko�ar;
  EP�A� g�nl�k g�zlemi sabah netle�ir, 09:00 TR ana fetch, di�erleri retry.
* Ayn� g�zlemin tekrar fetch''i yeni nokta �retmez: dedupe key =
  `hesId + provider + observationTimestamp + sourceClass`.
* Snapshot (bug�n g�sterilen) ile observation (provider �l��m zaman�)
  ayr�d�r; 7/30/90/365d serileri ger�ek observation timestamp kullan�r.
* Secrets: `EPIAS_USERNAME/PASSWORD/TGT_URL/DAM_ENDPOINT`,
  `HYDROWEB_API_KEY`, `COPERNICUS_ACCESS_TOKEN`, `DAHITI_API_KEY`,
  `EARTHDATA_TOKEN`. Yoksa ilgili job `skipped` olur. EP�A� kimlik varken
  hata verirse exit 2 ile CI''da g�r�n�r �ekilde d��er.
* Backfill: `python tools/hydro/backfill_fullness.py --provider copernicus
  --from 2024-01-01 --to 2026-09-16` (incremental/resume/dedupe).
* Ar�iv: `public/data/history/fullness/YYYY/MM/YYYY-MM-DD.json` (+
  `data-history` branch''i); zaman serileri `public/data/timeseries/`.

### Testler ve �ema

* `python -m unittest discover -s tools/hydro/tests` (EP�A� mock, matcher,
  hesap, history, entegrasyon � credentials gerektirmez).
* `python tools/hydro/test_fullness_quality.py` resolver + yay�nlanan
  snapshot''�n `schemas/hes_fullness.schema.json` do�rulamas�n� yapar.
* Audit ��kt�lar�: `reports/fullness_source_audit.{md,csv}`,
  `reports/fullness_missing_sources.json`,
  `public/data/quality/fullness_rejected.json`.
