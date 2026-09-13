export const RIVERS_DATA = [
  {
    id: "firat_ana",
    name: "Fırat Nehri (Ana Kol)",
    basin: "Fırat-Dicle Havzası",
    current_flow: 640.0,
    normal_flow: 520.0,
    length_km: 1260,
    drainage_km2: 135000,
    ssi_score: 1.4,
    next_down: "firat_mansap",
    upstream_ids: ["karasu", "murat"],
    seasonal_profile: [420, 490, 680, 1150, 1280, 850, 510, 390, 420, 460, 510, 540],
    coords: [
      [40.80, 39.90], [39.50, 39.75], [38.75, 38.80], [38.50, 38.30],
      [38.40, 37.80]
    ]
  },
  {
    id: "firat_mansap",
    name: "Fırat Nehri (Suriye Sınırı / Mansap)",
    basin: "Fırat-Dicle Havzası",
    current_flow: 710.0,
    normal_flow: 580.0,
    length_km: 420,
    drainage_km2: 184852,
    ssi_score: 1.5,
    next_down: null,
    upstream_ids: ["firat_ana"],
    seasonal_profile: [480, 560, 780, 1300, 1420, 940, 590, 450, 490, 530, 580, 620],
    coords: [
      [38.40, 37.80], [38.00, 37.40], [38.05, 36.90]
    ]
  },
  {
    id: "karasu",
    name: "Karasu Çayı (Fırat Yukarı Kolu)",
    basin: "Fırat-Dicle Havzası",
    current_flow: 180.0,
    normal_flow: 195.0,
    length_km: 460,
    drainage_km2: 22000,
    ssi_score: -0.2,
    next_down: "firat_ana",
    upstream_ids: [],
    seasonal_profile: [90, 110, 190, 420, 480, 240, 130, 95, 100, 115, 130, 140],
    coords: [
      [41.30, 40.05], [40.70, 39.85], [39.80, 39.75], [38.80, 38.85]
    ]
  },
  {
    id: "murat",
    name: "Murat Nehri (Fırat Yukarı Kolu)",
    basin: "Fırat-Dicle Havzası",
    current_flow: 310.0,
    normal_flow: 290.0,
    length_km: 722,
    drainage_km2: 40000,
    ssi_score: 0.3,
    next_down: "firat_ana",
    upstream_ids: [],
    seasonal_profile: [160, 190, 340, 710, 790, 390, 210, 150, 160, 180, 210, 230],
    coords: [
      [43.80, 39.60], [42.50, 39.40], [41.50, 38.80], [40.00, 38.70], [38.80, 38.85]
    ]
  },
  {
    id: "dicle",
    name: "Dicle Nehri",
    basin: "Fırat-Dicle Havzası",
    current_flow: 295.0,
    normal_flow: 310.0,
    length_km: 1900,
    drainage_km2: 57600,
    ssi_score: -0.1,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [180, 220, 410, 780, 690, 310, 160, 120, 130, 160, 210, 240],
    coords: [
      [39.40, 38.50], [40.20, 37.90], [41.20, 37.75], [41.70, 37.50],
      [42.20, 37.20]
    ]
  },
  {
    id: "kizilirmak",
    name: "Kızılırmak Nehri",
    basin: "Kızılırmak Havzası",
    current_flow: 184.5,
    normal_flow: 195.0,
    length_km: 1355,
    drainage_km2: 78180,
    ssi_score: -0.3,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [120, 160, 280, 410, 360, 190, 95, 75, 80, 95, 130, 150],
    coords: [
      [38.80, 39.85], [37.90, 39.70], [36.80, 39.30], [35.90, 38.90],
      [34.80, 38.75], [33.80, 39.10], [33.40, 39.80], [33.70, 40.50],
      [34.50, 41.10], [35.20, 41.40], [35.95, 41.72]
    ]
  },
  {
    id: "sakarya",
    name: "Sakarya Nehri",
    basin: "Sakarya Havzası",
    current_flow: 55.0,
    normal_flow: 130.0,
    length_km: 824,
    drainage_km2: 58160,
    ssi_score: -1.7,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [90, 130, 210, 240, 170, 85, 45, 38, 42, 55, 70, 85],
    coords: [
      [31.20, 39.00], [31.50, 39.60], [32.00, 40.00], [31.80, 40.40],
      [30.40, 40.30], [30.50, 40.80], [30.65, 41.12]
    ]
  },
  {
    id: "yesilirmak",
    name: "Yeşilırmak Nehri",
    basin: "Yeşilırmak Havzası",
    current_flow: 110.0,
    normal_flow: 105.0,
    length_km: 519,
    drainage_km2: 36114,
    ssi_score: 0.2,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [65, 85, 170, 260, 210, 95, 50, 40, 45, 55, 70, 80],
    coords: [
      [37.50, 39.90], [36.60, 40.30], [35.80, 40.65], [36.20, 40.90],
      [36.65, 41.35]
    ]
  },
  {
    id: "seyhan",
    name: "Seyhan Nehri",
    basin: "Seyhan Havzası",
    current_flow: 48.0,
    normal_flow: 92.0,
    length_km: 560,
    drainage_km2: 20450,
    ssi_score: -1.4,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [60, 85, 160, 220, 180, 75, 40, 32, 36, 45, 55, 65],
    coords: [
      [36.20, 38.60], [35.80, 38.00], [35.35, 37.30], [35.33, 37.02],
      [34.90, 36.70]
    ]
  },
  {
    id: "ceyhan",
    name: "Ceyhan Nehri",
    basin: "Ceyhan Havzası",
    current_flow: 85.0,
    normal_flow: 95.0,
    length_km: 509,
    drainage_km2: 21980,
    ssi_score: -0.4,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [75, 100, 170, 210, 160, 80, 50, 42, 48, 58, 70, 80],
    coords: [
      [37.20, 38.20], [36.80, 37.70], [36.30, 37.30], [35.70, 36.90],
      [35.55, 36.60]
    ]
  },
  {
    id: "coruh",
    name: "Çoruh Nehri",
    basin: "Çoruh Havzası",
    current_flow: 215.0,
    normal_flow: 180.0,
    length_km: 431,
    drainage_km2: 19890,
    ssi_score: 1.2,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [70, 85, 160, 480, 610, 320, 140, 85, 90, 110, 130, 140],
    coords: [
      [40.20, 40.30], [41.00, 40.50], [41.70, 41.10], [41.85, 41.55]
    ]
  },
  {
    id: "aras",
    name: "Aras Nehri",
    basin: "Aras Havzası",
    current_flow: 135.0,
    normal_flow: 140.0,
    length_km: 1072,
    drainage_km2: 27500,
    ssi_score: -0.1,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [60, 75, 140, 390, 450, 210, 95, 65, 75, 90, 110, 120],
    coords: [
      [41.50, 40.00], [42.60, 40.10], [43.50, 40.05], [44.30, 39.80]
    ]
  },
  {
    id: "buyuk_menderes",
    name: "Büyük Menderes Nehri",
    basin: "Kuzey-Güney Ege Havzası",
    current_flow: 28.0,
    normal_flow: 75.0,
    length_km: 548,
    drainage_km2: 24976,
    ssi_score: -1.9,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [95, 140, 150, 110, 60, 28, 14, 10, 12, 22, 45, 75],
    coords: [
      [30.10, 38.30], [29.20, 38.10], [28.40, 37.90], [27.70, 37.85],
      [27.20, 37.55]
    ]
  },
  {
    id: "gediz",
    name: "Gediz Nehri",
    basin: "Gediz Havzası",
    current_flow: 19.5,
    normal_flow: 48.0,
    length_km: 401,
    drainage_km2: 18000,
    ssi_score: -1.8,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [65, 95, 110, 75, 40, 18, 9, 6, 8, 15, 30, 52],
    coords: [
      [29.50, 39.00], [28.60, 38.60], [27.70, 38.60], [26.95, 38.58]
    ]
  },
  {
    id: "meric",
    name: "Meriç Nehri",
    basin: "Meriç-Ergene Havzası",
    current_flow: 180.0,
    normal_flow: 155.0,
    length_km: 480,
    drainage_km2: 53000,
    ssi_score: 1.1,
    next_down: null,
    upstream_ids: [],
    seasonal_profile: [190, 260, 290, 240, 170, 95, 45, 35, 40, 65, 110, 160],
    coords: [
      [26.55, 41.75], [26.50, 41.50], [26.35, 41.10], [26.05, 40.75]
    ]
  }
];

export const DAMS_DATA = [
  // Fırat Kaskadı
  {
    id: "keban",
    name: "Keban Barajı",
    river: "Fırat Nehri",
    basin: "Fırat-Dicle",
    cascade_group: "Fırat Kaskadı",
    cascade_rank: 1,
    downstream_dam: "karakaya",
    upstream_dam: null,
    coords: [38.756, 38.802],
    head_m: 163,
    installed_power_mw: 1330,
    max_storage_hm3: 31000,
    current_volume_hm3: 19840,
    occupancy_pct: 64.0,
    purpose: "HES / Taşkın"
  },
  {
    id: "karakaya",
    name: "Karakaya Barajı",
    river: "Fırat Nehri",
    basin: "Fırat-Dicle",
    cascade_group: "Fırat Kaskadı",
    cascade_rank: 2,
    downstream_dam: "ataturk",
    upstream_dam: "keban",
    coords: [39.136, 38.223],
    head_m: 145,
    installed_power_mw: 1800,
    max_storage_hm3: 9580,
    current_volume_hm3: 6897,
    occupancy_pct: 72.0,
    purpose: "HES"
  },
  {
    id: "ataturk",
    name: "Atatürk Barajı",
    river: "Fırat Nehri",
    basin: "Fırat-Dicle",
    cascade_group: "Fırat Kaskadı",
    cascade_rank: 3,
    downstream_dam: "birecik",
    upstream_dam: "karakaya",
    coords: [38.318, 37.479],
    head_m: 151,
    installed_power_mw: 2400,
    max_storage_hm3: 48700,
    current_volume_hm3: 28246,
    occupancy_pct: 58.0,
    purpose: "HES / GAP Sulama"
  },
  {
    id: "birecik",
    name: "Birecik Barajı",
    river: "Fırat Nehri",
    basin: "Fırat-Dicle",
    cascade_group: "Fırat Kaskadı",
    cascade_rank: 4,
    downstream_dam: null,
    upstream_dam: "ataturk",
    coords: [37.940, 37.050],
    head_m: 55,
    installed_power_mw: 672,
    max_storage_hm3: 1220,
    current_volume_hm3: 980,
    occupancy_pct: 80.3,
    purpose: "HES / Sulama"
  },

  // Çoruh Kaskadı
  {
    id: "deriner",
    name: "Deriner Barajı",
    river: "Çoruh Nehri",
    basin: "Çoruh",
    cascade_group: "Çoruh Kaskadı",
    cascade_rank: 1,
    downstream_dam: "borcka",
    upstream_dam: null,
    coords: [41.871, 41.171],
    head_m: 207,
    installed_power_mw: 670,
    max_storage_hm3: 1970,
    current_volume_hm3: 1615,
    occupancy_pct: 82.0,
    purpose: "HES / Taşkın"
  },
  {
    id: "borcka",
    name: "Borçka Barajı",
    river: "Çoruh Nehri",
    basin: "Çoruh",
    cascade_group: "Çoruh Kaskadı",
    cascade_rank: 2,
    downstream_dam: null,
    upstream_dam: "deriner",
    coords: [41.670, 41.350],
    head_m: 86,
    installed_power_mw: 300,
    max_storage_hm3: 419,
    current_volume_hm3: 340,
    occupancy_pct: 81.1,
    purpose: "HES"
  },

  // Dicle Kaskadı
  {
    id: "ilisu",
    name: "Ilısu Prof. Dr. Veysel Eroğlu Barajı",
    river: "Dicle Nehri",
    basin: "Fırat-Dicle",
    cascade_group: "Dicle Kaskadı",
    cascade_rank: 1,
    downstream_dam: null,
    upstream_dam: null,
    coords: [41.828, 37.534],
    head_m: 115,
    installed_power_mw: 1200,
    max_storage_hm3: 10600,
    current_volume_hm3: 7950,
    occupancy_pct: 75.0,
    purpose: "HES / Taşkın"
  },

  // Kızılırmak Kaskadı
  {
    id: "hirfanli",
    name: "Hirfanlı Barajı",
    river: "Kızılırmak",
    basin: "Kızılırmak",
    cascade_group: "Kızılırmak Kaskadı",
    cascade_rank: 1,
    downstream_dam: "altinkaya",
    upstream_dam: null,
    coords: [33.518, 39.271],
    head_m: 65,
    installed_power_mw: 128,
    max_storage_hm3: 5980,
    current_volume_hm3: 2212,
    occupancy_pct: 37.0,
    purpose: "HES / Sulama"
  },
  {
    id: "altinkaya",
    name: "Altınkaya Barajı",
    river: "Kızılırmak",
    basin: "Kızılırmak",
    cascade_group: "Kızılırmak Kaskadı",
    cascade_rank: 2,
    downstream_dam: null,
    upstream_dam: "hirfanli",
    coords: [35.795, 41.343],
    head_m: 140,
    installed_power_mw: 700,
    max_storage_hm3: 5763,
    current_volume_hm3: 2766,
    occupancy_pct: 48.0,
    purpose: "HES / Taşkın"
  },

  // Münferit Stratejik Barajlar
  {
    id: "sariyar",
    name: "Sarıyar Hasan Polatkan Barajı",
    river: "Sakarya Nehri",
    basin: "Sakarya",
    cascade_group: "Sakarya Havzası",
    cascade_rank: 1,
    downstream_dam: null,
    upstream_dam: null,
    coords: [31.977, 40.045],
    head_m: 80,
    installed_power_mw: 160,
    max_storage_hm3: 1900,
    current_volume_hm3: 418,
    occupancy_pct: 22.0,
    purpose: "HES"
  },
  {
    id: "seyhan_baraji",
    name: "Seyhan Barajı",
    river: "Seyhan Nehri",
    basin: "Seyhan",
    cascade_group: "Seyhan Havzası",
    cascade_rank: 1,
    downstream_dam: null,
    upstream_dam: null,
    coords: [35.333, 37.037],
    head_m: 52,
    installed_power_mw: 60,
    max_storage_hm3: 1200,
    current_volume_hm3: 384,
    occupancy_pct: 32.0,
    purpose: "Sulama / HES"
  },
  {
    id: "berke",
    name: "Berke Barajı",
    river: "Ceyhan Nehri",
    basin: "Ceyhan",
    cascade_group: "Ceyhan Havzası",
    cascade_rank: 1,
    downstream_dam: null,
    upstream_dam: null,
    coords: [36.467, 37.365],
    head_m: 180,
    installed_power_mw: 510,
    max_storage_hm3: 427,
    current_volume_hm3: 286,
    occupancy_pct: 67.0,
    purpose: "HES"
  },
  {
    id: "oymapinar",
    name: "Oymapınar Barajı",
    river: "Manavgat Çayı",
    basin: "Antalya",
    cascade_group: "Antalya Havzası",
    cascade_rank: 1,
    downstream_dam: null,
    upstream_dam: null,
    coords: [31.531, 36.906],
    head_m: 155,
    installed_power_mw: 540,
    max_storage_hm3: 300,
    current_volume_hm3: 195,
    occupancy_pct: 65.0,
    purpose: "HES"
  }
];

export const LAKES_DATA = [
  {
    id: "lake-van",
    name: "Van Gölü",
    basin: "Van Gölü Kapalı Havzası",
    coords: [42.90, 38.65],
    ref_area_km2: 3755,
    current_area_km2: 3620,
    area_loss_pct: 3.6,
    altitude_m: 1648,
    salinity: "Sodalı / Yüksek Tuzlu",
    status: "Hafif Çekilme (Kıyılarda Gerileme)",
    color: "#f59e0b"
  },
  {
    id: "lake-tuz",
    name: "Tuz Gölü",
    basin: "Konya Kapalı Havzası",
    coords: [33.35, 38.78],
    ref_area_km2: 1300,
    current_area_km2: 380,
    area_loss_pct: 70.8,
    altitude_m: 905,
    salinity: "Aşırı Tuzlu",
    status: "Kritik Kuruma (%70+ Yüzey Kaybı)",
    color: "#e11d48"
  },
  {
    id: "lake-beysehir",
    name: "Beyşehir Gölü",
    basin: "Konya Kapalı Havzası",
    coords: [31.52, 37.75],
    ref_area_km2: 656,
    current_area_km2: 512,
    area_loss_pct: 21.9,
    altitude_m: 1123,
    salinity: "Tatlı Su",
    status: "Tarımsal Çekilme Alarmı",
    color: "#f97316"
  },
  {
    id: "lake-egirdir",
    name: "Eğirdir Gölü",
    basin: "Antalya Havzası",
    coords: [30.85, 38.10],
    ref_area_km2: 482,
    current_area_km2: 390,
    area_loss_pct: 19.1,
    altitude_m: 917,
    salinity: "Tatlı Su",
    status: "Kritik Kot Kaybı (Dip Noktası)",
    color: "#f97316"
  },
  {
    id: "lake-burdur",
    name: "Burdur Gölü",
    basin: "Batı Akdeniz",
    coords: [30.15, 37.75],
    ref_area_km2: 250,
    current_area_km2: 135,
    area_loss_pct: 46.0,
    altitude_m: 845,
    salinity: "Tuzlu",
    status: "Ağır Çekilme (%46 Kayıp)",
    color: "#e11d48"
  },
  {
    id: "lake-iznik",
    name: "İznik Gölü",
    basin: "Marmara Havzası",
    coords: [29.50, 40.43],
    ref_area_km2: 308,
    current_area_km2: 292,
    area_loss_pct: 5.2,
    altitude_m: 85,
    salinity: "Tatlı Su",
    status: "Stabil / İzleniyor",
    color: "#10b981"
  }
];

export const BASINS_DATA = [
  { id: "firat_dicle", name: "Fırat-Dicle Havzası", area_km2: 184852, yield_hm3: 52940, ssi: 1.4, coords: [40.2, 38.0], status: "Normal / Taşkın Dönemi" },
  { id: "kizilirmak_b", name: "Kızılırmak Havzası", area_km2: 78180, yield_hm3: 6480, ssi: -0.3, coords: [35.0, 40.0], status: "Hafif Kuraklık" },
  { id: "sakarya_b", name: "Sakarya Havzası", area_km2: 58160, yield_hm3: 6400, ssi: -1.7, coords: [31.5, 40.1], status: "Şiddetli Kuraklık Riski" },
  { id: "yesilirmak_b", name: "Yeşilırmak Havzası", area_km2: 36114, yield_hm3: 5800, ssi: 0.2, coords: [36.2, 40.5], status: "Mevsimsel Normal" },
  { id: "antalya_b", name: "Antalya Havzası", area_km2: 19577, yield_hm3: 11060, ssi: -0.1, coords: [31.2, 36.8], status: "Normal" },
  { id: "seyhan_b", name: "Seyhan Havzası", area_km2: 20450, yield_hm3: 8010, ssi: -1.4, coords: [35.5, 37.5], status: "Düşük Akış" },
  { id: "ceyhan_b", name: "Ceyhan Havzası", area_km2: 21980, yield_hm3: 7180, ssi: -0.4, coords: [36.5, 37.2], status: "Normal" },
  { id: "gediz_b", name: "Gediz Havzası", area_km2: 18000, yield_hm3: 1950, ssi: -1.8, coords: [28.2, 38.7], status: "Kritik Kuraklık" },
  { id: "buyuk_menderes_b", name: "Büyük Menderes Havzası", area_km2: 24976, yield_hm3: 3030, ssi: -1.9, coords: [28.5, 37.8], status: "Kritik Kuraklık" },
  { id: "coruh_b", name: "Çoruh Havzası", area_km2: 19890, yield_hm3: 6300, ssi: 1.2, coords: [41.2, 40.8], status: "Yüksek Akış / Taşkın" },
  { id: "konya_kapali", name: "Konya Kapalı Havzası", area_km2: 53850, yield_hm3: 4520, ssi: -2.3, coords: [32.8, 38.2], status: "Olağanüstü Kuraklık" }
];
