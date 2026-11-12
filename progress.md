# Progres — PopGuard

Terakhir diperbarui: 2026-11-12

Dokumen ini adalah titik masuk kalau sesi terputus. Baca **Status** dan
**Langkah berikutnya** dulu, baru sisanya.

## Status

| Milestone | Isi | Status |
| --- | --- | --- |
| M0 | Scaffold MV3, popup, arming per-host, database | Selesai |
| M1 | Guard halaman (`window.open` + anchor) | Selesai, **terbukti tidak cukup** |
| M2 | Pengawas tab di service worker (`tabs.onCreated`) | **Selesai — kini pertahanan utama** |
| M3 | UX database (pengecualian global, impor/ekspor) | Selesai (pengecualian + impor/ekspor) |
| M4 | Rekonsiliasi & verifikasi registrasi | Selesai (registrasi diverifikasi ulang) |

## Hasil uji lapangan 2026-11-12 (penting)

Diuji pada situs iklan dan sebuah situs berbagi tautan video:

- Host sudah ada di daftar terlindungi, tetapi **log blokir kosong** sementara
  tab baru tetap bermunculan.

Kesimpulan: log kosong bukan berarti guard "terlalu longgar" — guard yang longgar
tetap akan mencatat popup dari timer/autoplay. Nol entri berarti guard
**tidak pernah berjalan** di halaman itu, atau semua popup lahir di iframe
cross-origin. Tiga penyebab yang teridentifikasi:

1. Skrip MAIN world **tunduk pada CSP halaman**; situs bisa memblokirnya.
2. Iklan berjalan di **iframe cross-origin**, yang tidak pernah mendapat guard
   karena `matches` hanya host yang di-arm.
3. **Klik trusted selalu diloloskan**, padahal klik iklan juga klik trusted.

Perbaikan yang diterapkan ada di bagian **Arsitektur** di bawah.

## Keputusan yang sudah dikunci

- **Model:** daftar host permanen, arming manual per situs. Bukan `<all_urls>`
  untuk penyuntikan skrip — meski izin host kini diminta sekaligus saat instal
  (`host_permissions: *://*/*`) agar tidak ada dialog per situs. Skrip tetap
  hanya dipasang di host yang di-arm.
- **Pencocokan hostname persis** untuk entri database.
- **Perilaku saat hijack:** tutup diam-diam, tanpa toast; kompensasinya log.
- **Cakupan:** hanya tab baru. Redirect tab-sama di luar scope.
- **Seberapa ketat: per situs, bukan global.** Setiap host punya mode:
  - **Seimbang** (default) — tab lintas-domain yang dibuka klik nyata diizinkan;
    yang ditutup hanya tab tanpa interaksi, popup tanpa opener, tab kosong yang
    diisi iklan, dan tab yang berpindah domain.
  - **Ketat** — semua tab lintas-domain ditutup kecuali domain pengecualian.
    Dipakai untuk situs yang agresif membuka iklan (mis. situs video).
  Forum diskusi butuh Seimbang; situs video butuh Ketat.
- **Tooling:** vanilla JS, tanpa build.
- Fase observasi 1–2 hari dibatalkan; diganti diagnostik yang selalu aktif.

## Arsitektur (dua lapis, lapis kedua yang menentukan)

```
lapis 1  src/page/guard.js      MAIN world, document_start
         Menambal window.open + anchor _blank. Bisa gagal: CSP halaman,
         iframe cross-origin, dan halaman yang mengganti window.open.

lapis 2  src/background/sw.js   tabs.onCreated watchdog  ← SELALU jalan
         Tidak peduli CSP, iframe, maupun isTrusted.
```

Aturan lapis 2, untuk setiap tab baru:

| Kondisi | Keputusan |
| --- | --- |
| URL kosong (`about:blank`) | **ditahan 8 detik** menunggu URL nyata, lalu dinilai |
| Tab yang diizinkan berpindah lintas-domain ≤6 detik (**hanya mode Ketat**, dan **bukan** tab yang dibuka manual/klik kanan) | **`chrome.tabs.remove` + catat** (`blocked-redirect`) |
| Klik kanan pada tautan, tab tujuan = href yang sama ≤5 detik | diizinkan (`allowed-context-menu`) |
| Tab mulai kosong lalu diisi setelah >1,5 detik, **tanpa opener terlindungi dan bukan jendela popup** | diizinkan (`allowed-manual-navigation`) |
| Tab kosong beropener atau berada di jendela popup, lalu diisi belakangan | **ditutup** (`blocked-late-popup`) |
| Opener bukan tab terlindungi, tab di jendela yang sama dengan tab terlindungi | diabaikan (aman untuk Ctrl+T / menu konteks) |
| Tanpa opener, tetapi ada di jendela berbeda dari tab terlindungi yang sedang fokus | **`chrome.tabs.remove` + catat** |
| Opener bukan tab terlindungi | diabaikan |
| Ada allow-token dari guard halaman ≤2 detik | diizinkan |
| Host tujuan sama dengan host opener | diizinkan |
| Host tujuan adalah host terlindungi lain | diizinkan |
| Host tujuan ada di daftar pengecualian | diizinkan |
| Selain itu | **`chrome.tabs.remove` + catat** |

Dua baris pertama ditambahkan setelah uji lapangan 2026-11-12 (2). Bukti dari
tabel Diagnostik menunjukkan pola yang khas:

```
about:blank                          → diabaikan — URL kosong
situs-forum → domain-iklan.example   → diizinkan — guard halaman
```

Situs memanggil `window.open('about:blank')` (lolos karena target kosong tidak
melanggar apa pun), lalu menulis alamat iklan ke tab itu. Guard mengirim
allow-token untuk tab kosong tersebut, dan pengawas menghapus tab itu dari daftar
pantau karena URL-nya kosong — sehingga navigasi berikutnya tidak dinilai sama
sekali. Perbaikannya: **jangan pernah memberi token untuk target kosong**, dan
**jangan berhenti memantau tab kosong** sampai URL nyata muncul.

Baris "tanpa opener" ditambahkan 2026-11-12 karena iklan situs video membuka
popup window dengan `noopener`, sehingga tidak punya `openerTabId` dan lolos dari
aturan berbasis opener. Atribusinya memakai **tab terlindungi yang terakhir
fokus**: kalau sebuah jendela baru muncul di jendela berbeda saat kamu sedang di
situs terlindungi, itu bukan aksi di jendela yang sama — jadi aman untuk ditutup.
Ctrl+T dan "buka tautan di tab baru" selalu tetap di jendela yang sama, sehingga
tidak tersentuh aturan ini.

Guard halaman mengirim allow-token ketika popup memang sah, sehingga tab dari
OAuth/anchor yang diizinkan tidak ikut ditutup.

## Peta file

| Berkas | Peran |
| --- | --- |
| `manifest.json` | MV3. `activeTab`, `scripting`, `storage`, `tabs` |
| `src/page/guard.js` | MAIN world: `window.open`, anchor `_blank`, aturan lintas-domain |
| `src/content/bridge.js` | ISOLATED world: relay pesan, ping liveness, ambil config |
| `src/background/sw.js` | Watchdog tab, database host, pengecualian, registrasi, log, diagnostik |
| `src/ui/popup.*` | Host aktif, status guard, aktif/nonaktif, log singkat |
| `src/ui/options.*` | Daftar host, pengecualian, log, diagnostik tab, impor/ekspor |
| `test/fixtures/` | 6 fixture + `opened.html` + `common.js` |
| `test/serve.ps1` | Server statis localhost:8123 |

## Langkah berikutnya

1. `brave://extensions` → **Reload** ekstensi (kode berubah).
2. Muat ulang tab situs yang sudah di-arm.
3. Buka popup ekstensi. Baris **"Penjaga terdeteksi…"** harus muncul. Kalau
   tertulis "belum terdeteksi", skrip halaman memang diblokir CSP — lapis 2
   tetap bekerja, dan itu bukan kegagalan.
4. Mainkan video dan klik iklan. Tab lintas-domain seharusnya langsung tertutup.
5. Periksa **halaman opsi → Diagnostik tab**. Setiap tab baru tercatat dengan
   keputusan dan opener-nya. Ini bukti untuk menentukan langkah selanjutnya.

## Checklist verifikasi

- [ ] Ekstensi termuat tanpa error.
- [ ] Fixture 01 diblokir (`no-activation`).
- [ ] Fixture 02 diblokir (`keyboard`).
- [ ] Fixture 03 diblokir (`hidden-anchor`).
- [ ] Fixture 04 diblokir (`no-activation`) setelah jeda 3 detik.
- [ ] Fixture 05 **membuka tab** ke `opened.html` (situs sama).
- [ ] Fixture 06 diblokir (`cross-domain`).
- [ ] Popup menampilkan "Penjaga terdeteksi di halaman".
- [ ] Diagnostik mencatat `same-site` untuk fixture 05.
- [ ] Host yang tidak di-arm: tidak ada perubahan perilaku.
- [ ] Entri host bertahan setelah browser restart.
- [ ] Mencabut izin lewat `brave://extensions` menghapus entri (rekonsiliasi).

## Kalau masih bocor

Periksa **Diagnostik tab** lebih dulu, jangan mengubah kode:

- **Tidak ada baris sama sekali untuk tab yang bocor** → kode lama masih aktif
  (ekstensi belum di-reload) atau tab itu tidak memicu `onCreated` yang bisa
  dievaluasi. Reload ekstensi lebih dulu, lalu uji lagi.
- **Baris `no-protected-opener`** → belum ada tab terlindungi yang tercatat
  fokus (mis. service worker baru bangun). Pindah tab lalu kembali, atau muat
  ulang halaman, agar `lastFocusedProtected` terisi.
- **Baris `skipped-same-window` pada tab yang bocor** → popup membuka tab di
  jendela yang sama, di luar cakupan aturan orphan.
- **Baris `same-site` pada tab yang bocor** → popup menuju domain sendiri lalu
  berpindah ke iklan. Kini ditangani **pemantauan redirect** (≤6 detik); kalau
  tetap lolos, berarti perpindahannya terjadi lebih lambat dari jendela pantau.
- **Baris `DITUTUP — berpindah lintas-domain`** → bekerja sesuai rancangan.
- **Baris `allowed-by-page-guard`** → guard halaman meloloskan; tambahkan domain
  tujuan ke pengecualian atau perketat aturan.
- **Baris `exception`** → domain ada di daftar pengecualian; hapus bila salah.

## Jebakan yang sudah ditemukan (jangan diulang)

- **`permissions.request()` bukan lagi cara memberi akses.** Sejak
  2026-11-12 (6), izin host dideklarasikan di manifest (`host_permissions`), jadi
  aktivasi situs tidak memunculkan dialog. Jangan kembalikan
  `optional_host_permissions`: itu yang dulu memaksa prompt per situs.
- **`permissions.getAll()` melaporkan `*://*/*`**, bukan pola per host. Setiap
  pemeriksaan origin harus menerima pola luas itu juga — kalau tidak,
  `reconcile()` akan menghapus seluruh entri host. Lihat `hasOriginGranted`.
- **MAIN world tunduk pada CSP halaman.** Ini penyebab paling mungkin dari
  "log kosong". Jangan mengandalkan guard halaman sebagai satu-satunya pertahanan.
- **Arming tidak berlaku surut**; guard hanya aktif setelah reload halaman.
- **MAIN world tidak punya `chrome.*`**; semua lewat `postMessage` + bridge.
- **`window.open` harus mengembalikan stub**, bukan `null`.
- **Fixture tidak boleh dibuka via `file://`**; pakai `test/serve.ps1`.
- **`storage.sync` ~8KB per item**; log blokir di `storage.local`.
- **Load unpacked memakai folder root**, bukan `dist`.
- **Log kosong adalah sinyal diagnostik**, bukan bukti bahwa semuanya aman.
  Sejak 2026-11-12 ada ping liveness per host untuk membedakan "guard longgar"
  dari "guard tidak terpasang".

## Batasan yang diketahui

- **Tab tanpa `openerTabId`** ditangani lewat atribusi fokus, tetapi hanya bila
  jendelanya berbeda dari jendela tab terlindungi. Tab latar di jendela yang
  sama tidak ditutup (risiko false positive terlalu tinggi).
- **Pemantauan redirect hanya 6 detik** dan hanya untuk tab baru. Redirect tab
  yang sama (navigasi halaman aktif) tetap di luar scope.
- **Redirect DNS/CDN yang sah** (mis. tombol unduh yang mengarah ke CDN lain)
  akan ikut ditutup. Tambahkan domainnya ke pengecualian bila itu memang
  diinginkan.
- **Popup ke domain lain yang sah** (login) harus ditambahkan manual ke
  pengecualian. Default sudah memuat beberapa penyedia login.
- **Guard halaman bisa di-bypass** halaman canggih yang mengambil `open` asli
  dari iframe segar.
- **Izin `tabs`** tidak memberi akses isi halaman, tetapi tetap izin luas.

## Perintah

```powershell
powershell -ExecutionPolicy Bypass -File test/serve.ps1

node --check src/background/sw.js
node --check src/page/guard.js
node --check src/content/bridge.js
node --check src/ui/popup.js
node --check src/ui/options.js
```

## Riwayat

- 2026-11-12 (13) — Tombol besar "Enable/Disable on this site" dihapus karena
  duplikat dari toggle `Enabled` di panel statistik: keduanya memanggil
  `arm()`/`disarm()` yang sama. Toggle kini satu-satunya kontrol aktif/nonaktif;
  popup jadi ±48 px lebih pendek. Aturan CSS `.primary` ikut dibuang.
- 2026-11-12 (12) — Popup disederhanakan mengikuti mockup terbaru: header logo +
  gear, shield status, satu panel berisi "Blocked Today" dan toggle, pemilih mode
  berikon (Balanced/Strict), dan satu tombol aksi besar (Enable/Disable on this
  site). Chip hostname, daftar blokir, baris deteksi guard, dan footer dihapus;
  peringatan guard hanya muncul bila injeksi gagal, dan tombol reload hanya
  muncul saat diperlukan. Ditambahkan `[hidden] { display: none !important }`
  karena aturan `display:flex` milik `.mode`/`.reload` menimpa atribut `hidden`.
- 2026-11-12 (11) — Sebagian iklan tetap terbuka di mode Ketat dengan verdict
  "allowed — page guard". Dua penyebab: (1) **race saat service worker bangun** —
  `thg:config` dijawab dari cache `hosts` yang masih kosong sehingga situs Ketat
  menerima konfigurasi `balanced`; (2) token izin tidak terikat URL, jadi token
  dari popup sah bisa dipakai iklan dalam jendela 2 detik yang sama. Perbaikan:
  semua handler menunggu `ensureBoot()`, dan token menyimpan
  `origin+path+search` yang harus cocok dengan URL tab.
- 2026-11-12 (10) — **DIBATALKAN / DI-REVERT.** Sempat ditambahkan audit popup
  kosong (`runBlankAudit`) untuk menutup tab yang selamanya `about:blank`.
  Ternyata laporan kebocoran saat itu terjadi karena ekstensi belum diaktifkan di
  situs tersebut, jadi mekanisme ini dicabut kembali agar tidak menutup popup
  sah yang membuka `about:blank` lalu mengirim form. Verdict `blocked-blank-popup`
  dan alasan `blank-popup` sudah dihapus dari kedua UI.
- 2026-11-12 (9) — Kebocoran: popup window `about:blank` yang *menunggu* lalu
  diisi iklan tetap lolos di mode Ketat, karena aturan "kosong >1,5 detik"
  dianggap navigasi manusia. Aturan itu dipersempit: hanya berlaku bila tab
  **tidak punya opener terlindungi** dan **bukan jendela popup** (`humanShaped`).
  Kasus lain dicatat sebagai `blocked-late-popup`.
- 2026-11-12 (8) — Rebranding: nama aplikasi menjadi **PopGuard**, logo pengguna
  dipasang sebagai ikon 16/32/48/128 (`icons/`, diturunkan dari `icons/logo.png`).
  Seluruh UI (popup, options, manifest) diterjemahkan ke bahasa Inggris dan popup
  didesain ulang mengikuti mockup: header logo + gear, shield status, statistik
  "Blocked Today"/"Since", toggle Enabled, daftar blokir terbaru, footer.
  `progress.md` tetap berbahasa Indonesia.
- 2026-11-12 (7) — Bug false positive: tautan lewat host perantara di forum
  langsung tertutup setelah terbuka, karena host itu me-redirect ke host video
  dan pemantauan redirect menutupnya. Pemantauan redirect kini
  **hanya berjalan di mode Ketat** dan **tidak berlaku** untuk tab yang dibuka
  manual (`allowed-manual-navigation`) atau lewat klik kanan
  (`allowed-context-menu`). Opsi A dipilih; Opsi B (hapus total) tidak diambil
  agar situs Ketat tetap terlindungi dari `site/out?to=ad`.
- 2026-11-12 (6) — Izin host dipindahkan dari `optional_host_permissions` +
  `permissions.request` ke `host_permissions: *://*/*`. Aktivasi situs kini
  instan tanpa dialog. `reconcile()` diperbaiki agar menerima pola luas; tanpa
  itu seluruh entri host akan terhapus saat boot.
- 2026-11-12 (5) — Bug false positive: tautan ke situs berbagi gambar dari
  sebuah forum selalu ditutup, termasuk lewat copy-paste manual. Penyebabnya
  kebijakan lintas-domain yang seragam: di forum, hampir semua tautan memang
  keluar situs. Ditambahkan **mode per-situs** (`balanced` / `strict`). Entri
  lama dimigrasikan ke `balanced`, jadi situs Ketat perlu disetel ulang ke
  **Ketat**.
- 2026-11-12 (4) — Bug false positive: klik kanan → "Open link in new tab" pada
  sebuah forum langsung ditutup. Penyebabnya, klik kanan tidak menghasilkan
  event `click`, jadi guard tidak pernah melihat niat pengguna. Ditambahkan
  **isyarat intent**: klik kanan pada tautan mencatat href-nya, dan tab yang
  dibuka ke href yang sama ≤5 detik diizinkan (`allowed-context-menu`). Juga
  ditambahkan aturan **navigasi manual**: tab yang dibiarkan kosong >1,5 detik
  lalu diisi dianggap dibuka manusia (`allowed-manual-navigation`).
- 2026-11-12 (3) — Ditutup celah **`about:blank`**: target kosong tidak lagi
  dikirimi allow-token, tab kosong tetap dipantau hingga 8 detik sampai URL nyata
  muncul, dan ditambahkan **pemantauan redirect** 6 detik untuk tab yang sudah
  diizinkan. Bukti: tabel Diagnostik menunjukkan `about:blank` diabaikan lalu
  domain iklan lolos sebagai "diizinkan guard halaman".
- 2026-11-12 (2) — Ditambahkan aturan **orphan popup**: tab/jendela baru tanpa
  `openerTabId` yang muncul di jendela berbeda saat tab terlindungi sedang fokus
  ikut ditutup. Ini menangkap popup `noopener` dari iklan situs video. Anchor
  `_blank` yang sah kini mengirim allow-token agar tidak ikut tertutup.
- 2026-11-12 — M2 watchdog menjadi pertahanan utama. Ditambahkan aturan
  lintas-domain, pengecualian global, ping liveness, dan diagnostik tab.
  Fixture 05 diubah (situs sama) dan fixture 06 ditambahkan.
- 2026-11-11 — M0 + M1 ditulis dari folder kosong.
