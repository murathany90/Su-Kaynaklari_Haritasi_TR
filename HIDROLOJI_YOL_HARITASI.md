# Hidroloji veri yol haritası

## Mevcut durum

- [x] TATUS FeatureServer katman keşfi ve gerçek GeoJSON indirme
- [x] EPSG:4326 normalizasyonu, kaynak manifesti ve atomik dosya yazımı
- [x] Nehir katmanı için sayfalama ve paralel indirme
- [x] Native MapLibre kaynak/layer rehidrasyonu ve gerçek veri store'u
- [x] GEOGLOWS v2 adapter iskeleti; yalnızca doğrulanmış reach eşleşmelerini kabul eder
- [x] EPİAŞ sunucu tarafı kimlik doğrulama adapteri; secret yoksa açık `requires_access` durumu üretir
- [x] GitHub Actions ile TATUS günlük, GEOGLOWS 6 saatlik ve EPİAŞ secret koşullu veri işleri

## Kaynaklar ve sözleşmeler

TATUS: `https://cbs1.tarimorman.gov.tr/server/rest/services/TATUS/FeatureServer`

GEOGLOWS v2: `https://geoglows.ecmwf.int/api/v2/`

EPİAŞ giriş: `https://giris.epias.com.tr/cas/v1/tickets`

Üretim frontend’i yalnızca `/public/data/static`, `/public/data/live` ve
`/public/data/manifest` üzerinden okur. Eski demo veri katmanı artık kullanılmaz;
referans için tutulur ancak runtime tarafından import edilmez.

## TATUS katmanları

| Dosya | Layer | Geometri | Kanonik alanlar |
| --- | ---: | --- | --- |
| `flow_stations.geojson` | 3 | Point | `id`, `name`, `stationId`, `basinId`, `flow` |
| `hes_stations.geojson` | 4 | Point | `id`, `name`, `stationId`, `basinId` |
| `lake_stations.geojson` | 6 | Point | `id`, `name`, `stationId`, `basinId` |
| `dam_stations.geojson` | 7 | Point | `id`, `name`, `damName`, `basinId`, `occupancy` |
| `rivers.geojson` | 8 | LineString | `id`, `name`, `riverCode`, `basinId`, `lengthKm`, `flow` |
| `basins.geojson` | 11 | Polygon | `id`, `basinId`, `name`, `areaKm2` |

Raw ArcGIS öznitelikleri korunur. Gerçek zaman ölçümü gelmeyen alanlar `null`
kalır; renk ve KPI katmanı bu durumda “veri yok” durumunu gösterir.

## GEOGLOWS eşleşme politikası

`tools/hydro/build_river_reach_map.py` otomatik isim benzerliğiyle sahte ID
üretmez. `public/data/static/mappings/river_reach_map.json` içindeki her satır
review edilip `geoglowsRiverId` ve `reviewRequired: false` olarak işaretlenmeden
forecast isteği atılmaz. Böylece bir nehir adı benzerliği yanlış havza verisine
dönüşmez.

## EPİAŞ erişim politikası

Kullanıcı adı ve parola hiçbir zaman Vite bundle’ına girmez. GitHub Actions
secret’ları `EPIAS_USERNAME`, `EPIAS_PASSWORD` ve seçilen Swagger endpoint’i
olarak `EPIAS_DAM_ENDPOINT` ile verilir. Secret yoksa pipeline EPİAŞ job’ını
atlar; yerel adapter `requires_access` sonucu üretir. Sentetik doluluk, akış,
enerji veya KPI yazılmaz.

## Sonraki adımlar

1. GEOGLOWS OpenAPI sözleşmesinden forecast/ensemble response alanlarını teyit edip adapter mapper’ını tamamlamak.
2. Alan uzmanı onayıyla nehir reach ID eşleşmelerini parça parça doldurmak.
3. EPİAŞ Swagger’daki baraj endpoint’ini ve tarihsel aralık payload’ını hesap hesabına göre kesinleştirmek.
4. Tarihsel günlük JSON’ları append-only partition’lara taşımak ve veri kalite raporu üretmek.
5. 632 binden fazla TATUS nehir feature’ı için vector tile veya bölgesel lazy-load stratejisine geçmek.
