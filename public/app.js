/* voku paneli — vanilla, build adımı yok. */

const $ = (s, kok = document) => kok.querySelector(s);
const $$ = (s, kok = document) => [...kok.querySelectorAll(s)];

const state = {
  platformlar: [],
  joblar: [],
  promptlar: [],
  promptTaslak: [],
  seciliJob: null,
  varyant: 'uretim',
  arama: '',
  tarih: { tip: 'tumu', bas: '', bit: '' },
  oda: null,
  seciliSayfa: null,
  sayfaArama: '',
  sayfaSuzgec: 'tumu',
  isSuzgec: 'tumu',
  kaynakSuzgec: 'tumu',
  telegram: null,
  disErisim: null, // { acik, adres, paylasimLinki } — tünel açık mı
  kaydedilmedi: false,
  yeniFoto: null, // { base64, ad }
};

const VARYANTLAR = [
  { ad: 'uretim', etiket: 'Üretim', bos: 'Bu iş için henüz üretim yok.', ipucu: 'Ham üretim dosyaları.' },
  {
    ad: 'demo',
    etiket: 'Demo',
    bos: 'Damgalı demo hazırlanmadı. Üretim tamamlanınca otomatik oluşur.',
    ipucu: 'Çapraz DEMO damgalı, müşteriye gösterim için.',
  },
  {
    ad: 'baski',
    etiket: 'Baskı',
    bos: 'Baskı çıktısı henüz hazır değil.',
    ipucu: 'Şablonlu ve aynalı baskı hali — basılacakları buradan seç.',
  },
  // Print bir klasör değil, seçim görünümü: dosyalar baski/ klasöründen gelir.
  {
    ad: 'print',
    etiket: 'Print',
    kaynak: 'baski',
    bos: 'Seçili baskı yok. Baskı sekmesinden basılacakları seç.',
    ipucu: 'Basılacaklar listesi — basılanı işaretle.',
  },
];

const DURUM_ETIKET = {
  pending: 'bekliyor',
  running: 'çalışıyor',
  done: 'tamam',
  failed: 'hata',
  partial: 'kısmi',
};
const PLATFORM_ETIKET = { chatgpt: 'ChatGPT', gemini: 'Gemini' };

/** İş nereden geldi: panelden yüklenen fotoğraf mı, Telegram botundan mı. */
const KAYNAK = {
  panel: { etiket: 'Panel', isaret: '▣', ipucu: 'Panelden yüklendi' },
  telegram: { etiket: 'Telegram', isaret: '✈', ipucu: 'Telegram botundan geldi' },
};
const kaynakBilgisi = (job) => KAYNAK[job.kaynak] || KAYNAK.panel;

/**
 * Görsel adresi. `boy` verilirse önizleme gelir: kontak baskısı ve film
 * şeridi küçük ('k'), ışık kutusu orta ('o'). Ham PNG yalnız indirmede —
 * panel bir tünel üzerinden açıldığında kare başına birkaç MB kotayı yakar.
 */
function gorselYolu(jobId, varyant, dosya, boy) {
  const taban = `/api/jobs/${jobId}/file/${varyant}/${encodeURIComponent(dosya)}`;
  return boy ? `${taban}?b=${boy}` : taban;
}

/* ---------------- ağ ---------------- */
async function api(yol, secenek = {}) {
  const yanit = await fetch(yol, {
    headers: { 'content-type': 'application/json' },
    ...secenek,
    body: secenek.body ? JSON.stringify(secenek.body) : undefined,
  });
  const veri = yanit.headers.get('content-type')?.includes('json') ? await yanit.json() : null;
  if (!yanit.ok) throw new Error(veri?.hata || `İstek başarısız (${yanit.status})`);
  return veri;
}

/* ---------------- yardımcılar ---------------- */
function tarih(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Bar lambası için havuz özeti — çoklu hesaptaysa "2 hesap · 1 dinlenmede". */
function havuzTooltip(p) {
  const h = p.hesaplar || [];
  if (h.length < 2) return null;
  const dinlenen = h.filter((x) => x.dinlenmede).length;
  return `${h.length} hesap havuzu` + (dinlenen ? ` · ${dinlenen} limitte` : ' · hepsi hazır');
}

/** ms epoch → "14:30" (havuz reset saati). */
function saatKisa(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function el(etiket, ozellik = {}, ...cocuklar) {
  const n = document.createElement(etiket);
  for (const [k, v] of Object.entries(ozellik)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of cocuklar.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

/* ---------------- sekmeler ---------------- */
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$('.view').forEach((v) => v.classList.add('gizli'));
    $(`#view-${tab.dataset.view}`).classList.remove('gizli');
    // Baskı odası kuyruğu iş detayındaki seçimlere bağlı — her açılışta tazele.
    if (tab.dataset.view === 'baski-odasi') odayiYukle();
  });
});

/* ================= İŞLER ================= */
/** Arama kutusu: kod, telefon, not ve prompt metinlerinde eşleşme arar. */
function jobEsliyorMu(job, terim) {
  if (!terim) return true;
  const havuz = [
    job.id,
    job.phone,
    job.fakeId,
    job.note,
    kaynakBilgisi(job).etiket,
    job.kaynakBilgi?.kullanici,
    ...job.tasks.map((t) => `${t.promptId} ${t.prompt}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('tr');
  return terim
    .toLocaleLowerCase('tr')
    .split(/\s+/)
    .filter(Boolean)
    .every((parca) => havuz.includes(parca));
}

/** YYYY-MM-DD (yerel gün) — tarih karşılaştırmaları gün bazında yapılır. */
function gunAnahtari(d) {
  const t = new Date(d);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function tarihEsliyorMu(job) {
  const { tip, bas, bit } = state.tarih;
  if (tip === 'tumu') return true;
  const gun = gunAnahtari(job.createdAt);
  const bugun = new Date();
  if (tip === 'bugun') return gun === gunAnahtari(bugun);
  if (tip === 'dun') {
    const dun = new Date(bugun);
    dun.setDate(dun.getDate() - 1);
    return gun === gunAnahtari(dun);
  }
  // aralık: uçlar dahil, biri boşsa o yön sınırsız
  if (bas && gun < bas) return false;
  if (bit && gun > bit) return false;
  return true;
}

/**
 * İş durumu süzgeci — üretim ve baskı aşamalarını tek eksende birleştirir:
 * üretimde → basılıyor (kısmi) → basıldı.
 */
function isDurumuEsliyorMu(job) {
  if (state.isSuzgec === 'tumu') return true;
  const oz = job.baskiOzet || { secili: 0, kopya: 0, basiliKopya: 0 };
  const uretimBitti = job.tasks.every((t) => t.status === 'done');
  if (state.isSuzgec === 'uretimde') return !uretimBitti;
  if (state.isSuzgec === 'basiliyor') return oz.secili > 0 && oz.basiliKopya < oz.kopya;
  if (state.isSuzgec === 'basildi') return oz.kopya > 0 && oz.basiliKopya >= oz.kopya;
  return true;
}

/** Kaynak süzgeci: işi panel mi telegram mı getirdi. */
function kaynakEsliyorMu(job) {
  if (state.kaynakSuzgec === 'tumu') return true;
  return (job.kaynak || 'panel') === state.kaynakSuzgec;
}

function jobListesiCiz() {
  const kap = $('#jobListesi');
  kap.replaceChildren();
  const cokluIs = state.joblar.length > 1;
  $('#kuyrukAra').classList.toggle('gizli', !cokluIs);
  $('#tarihSuzgec').classList.toggle('gizli', !cokluIs);
  $('#isSuzgec').classList.toggle('gizli', !cokluIs);
  // Kaynak süzgeci ancak iki kaynak da kuyrukta varsa anlamlı.
  const kaynakCesidi = new Set(state.joblar.map((j) => j.kaynak || 'panel')).size;
  $('#kaynakSuzgec').classList.toggle('gizli', kaynakCesidi < 2);

  if (!state.joblar.length) {
    kap.append(
      el('div', { class: 'bos' },
        el('p', { text: 'Kuyruk boş. Bir fotoğraf ver, hat çalışsın.' }),
        el('button', { class: 'btn btn-birincil btn-kucuk', onclick: yeniIsAc, text: 'Yeni iş' })
      )
    );
    return;
  }

  const gorunen = state.joblar.filter(
    (j) =>
      jobEsliyorMu(j, state.arama) && tarihEsliyorMu(j) && isDurumuEsliyorMu(j) && kaynakEsliyorMu(j)
  );
  if (!gorunen.length) {
    const nedenler = [
      state.arama ? `"${state.arama}"` : null,
      state.tarih.tip !== 'tumu' ? TARIH_ETIKET[state.tarih.tip] : null,
      state.isSuzgec !== 'tumu' ? state.isSuzgec.replace('-', ' ') : null,
      state.kaynakSuzgec !== 'tumu' ? KAYNAK[state.kaynakSuzgec].etiket : null,
    ].filter(Boolean);
    kap.append(
      el('div', { class: 'bos' },
        el('p', { text: `${nedenler.join(' + ')} için eşleşen iş yok.` }),
        el('button', {
          class: 'btn btn-ikincil btn-kucuk',
          text: 'Süzgeçleri temizle',
          onclick: suzgecleriTemizle,
        })
      )
    );
    return;
  }

  for (const job of gorunen) {
    const tamam = job.tasks.filter((t) => t.status === 'done').length;
    const durum = job.kosuyor ? 'running' : job.status;
    const oz = job.baskiOzet || { secili: 0, kopya: 0, basiliKopya: 0 };
    const satir = el('button', {
      class: `job-satir d-${durum}`,
      'aria-current': String(state.seciliJob === job.id),
      onclick: () => jobSec(job.id),
    },
      job.inputFile
        ? el('img', {
            class: 'job-foto',
            src: gorselYolu(job.id, 'kok', job.inputFile, 'k'),
            alt: '',
            loading: 'lazy',
          })
        : null,
      el('span', { class: 'job-bilgi' },
        el('span', { class: 'kod-satir' },
          el('span', { class: 'kod', text: job.id }),
          el('span', {
            class: `kaynak-rozet k-${job.kaynak || 'panel'}`,
            title: job.kaynakBilgi?.kullanici
              ? `${kaynakBilgisi(job).ipucu} — ${job.kaynakBilgi.kullanici}`
              : kaynakBilgisi(job).ipucu,
          }, kaynakBilgisi(job).isaret, kaynakBilgisi(job).etiket)
        ),
        el('span', { class: 'satir-alt' },
          el('span', { text: job.note || (job.phone ? 'telefonlu' : 'kod üretildi') }),
          el('span', { class: 'job-gostergeler' },
            // Üretim: kaç task tamamlandı
            el('span', {
              class: `gosterge${tamam === job.tasks.length ? ' tam' : ''}`,
              title: `Üretim: ${tamam}/${job.tasks.length} görsel tamamlandı`,
            }, '▦', `${tamam}/${job.tasks.length}`),
            // Baskı: kaç kopya basıldı / kaç kopya seçildi
            el('span', {
              class: `gosterge${oz.kopya && oz.basiliKopya >= oz.kopya ? ' tam' : ''}${oz.kopya ? '' : ' sonuk'}`,
              title: oz.kopya
                ? `Baskı: ${oz.basiliKopya}/${oz.kopya} kopya basıldı (${oz.secili} görsel seçili)`
                : 'Baskı için seçim yapılmadı',
            }, '⎙', `${oz.basiliKopya}/${oz.kopya}`)
          )
        )
      )
    );
    kap.append(satir);
  }
}

/**
 * Job'ı listeye ekler veya günceller. Hem SSE hem HTTP yanıtı aynı job'ı
 * bildirdiği için körlemesine eklemek aynı işi iki kart olarak gösterir.
 */
function jobUpsert(veri) {
  const i = state.joblar.findIndex((j) => j.id === veri.id);
  if (i >= 0) state.joblar[i] = { ...state.joblar[i], ...veri };
  else state.joblar.unshift(veri);
}

function jobSec(id) {
  state.seciliJob = id;
  jobListesiCiz();
  jobDetayCiz();
}

/**
 * Seçili baskı için adet kontrolü: aynı görselden birden fazla kopya
 * istenebiliyor. 1'in altına inmek seçimi kaldırır (ayrı "kaldır" düğmesi
 * gerekmesin diye).
 */
function adetKontrolu(jobId, bilgi) {
  const degistir = (yeniAdet) => baskiSecimi(jobId, bilgi.dosya, { adet: yeniAdet });
  return el('span', { class: 'kare-adet' },
    el('button', {
      type: 'button',
      title: bilgi.adet > 1 ? 'Adedi azalt' : 'Print listesinden çıkar',
      text: '−',
      onclick: () => degistir(bilgi.adet - 1),
    }),
    el('span', { class: 'adet-sayi', text: String(bilgi.adet) }),
    el('button', {
      type: 'button',
      title: 'Adedi artır',
      text: '+',
      disabled: bilgi.adet >= 99,
      onclick: () => degistir(bilgi.adet + 1),
    })
  );
}

function kareSinifi(t) {
  return { done: 'tamam', failed: 'hata', running: 'calisiyor', pending: 'bekliyor' }[t.status] || 'bekliyor';
}

/* ---------------- ışık kutusu (büyütülmüş kare) ---------------- */
/**
 * Bir kare büyütüldüğünde aynı işin diğer kareleri arasında gezinilir:
 * ok tuşları / kenardaki oklar / alttaki film şeridi. Gezinme kümesi
 * açıldığı sekmenin dosyalarıdır (üretim, demo, baskı ya da print seçimi).
 */
const isik = { jobId: null, varyant: 'uretim', liste: [], i: 0 };

function isikKutusuAc(job, varyant, liste, indeks) {
  if (!liste?.length) return;
  isik.jobId = job.id;
  isik.varyant = varyant;
  isik.liste = liste;
  isik.i = Math.max(0, indeks);
  isikKutusuCiz();
  const pencere = $('#isikKutusu');
  if (!pencere.open) pencere.showModal();
}

function isikKaydir(adim) {
  if (!isik.liste.length) return;
  // Döngüsel: son kareden sağa basınca başa döner — seride sıkışıp kalmasın.
  isik.i = (isik.i + adim + isik.liste.length) % isik.liste.length;
  isikKutusuCiz();
}

function isikKutusuCiz() {
  const govde = $('#isikGovde');
  const kare = isik.liste[isik.i];
  if (!kare) return;
  const varyantEtiket = VARYANTLAR.find((v) => (v.kaynak || v.ad) === isik.varyant)?.etiket || isik.varyant;
  const yol = (d, boy) => gorselYolu(isik.jobId, isik.varyant, d, boy);
  const cokluMu = isik.liste.length > 1;

  govde.replaceChildren(
    el('div', { class: 'isik-basi' },
      el('span', { class: 'isik-kod', text: `${isik.jobId} · ${varyantEtiket}` }),
      el('span', { class: 'isik-sayac', text: `${isik.i + 1}/${isik.liste.length}` }),
      el('button', {
        class: 'btn-kapat',
        'aria-label': 'Kapat',
        text: '×',
        onclick: () => $('#isikKutusu').close(),
      })
    ),
    el('div', { class: 'isik-sahne' },
      cokluMu
        ? el('button', {
            class: 'isik-ok sol',
            'aria-label': 'Önceki kare',
            text: '‹',
            onclick: () => isikKaydir(-1),
          })
        : null,
      el('img', { src: yol(kare.dosya, 'o'), alt: kare.prompt || kare.dosya }),
      cokluMu
        ? el('button', {
            class: 'isik-ok sag',
            'aria-label': 'Sonraki kare',
            text: '›',
            onclick: () => isikKaydir(1),
          })
        : null
    ),
    el('div', { class: 'isik-kunye' },
      el('span', { class: 'isik-no', text: String(kare.no).padStart(2, '0') }),
      el('span', { class: 'isik-platform', text: PLATFORM_ETIKET[kare.platform] || kare.platform }),
      el('span', { class: 'isik-prompt', text: kare.prompt || '' })
    ),
    cokluMu
      ? el('div', { class: 'isik-serit' },
          ...isik.liste.map((k, n) =>
            el('button', {
              class: `isik-serit-kare${n === isik.i ? ' etkin' : ''}`,
              'aria-label': `${n + 1}. kare`,
              onclick: () => {
                isik.i = n;
                isikKutusuCiz();
              },
            }, el('img', { src: yol(k.dosya, 'k'), alt: '', loading: 'lazy' }))
          )
        )
      : null
  );
}

const isikPenceresi = $('#isikKutusu');
// Dinleyici belgede: kutu her gezinmede yeniden çizildiği için odak
// düğmeden düşüyor, dialog'a bağlı listener o anda tuşu kaçırıyordu.
document.addEventListener('keydown', (e) => {
  if (!isikPenceresi.open) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    isikKaydir(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    isikKaydir(-1);
  }
});
// Görselin dışına tıklamak kapatır (dialog'un kendisi arka plandır).
isikPenceresi.addEventListener('click', (e) => {
  if (e.target === isikPenceresi) isikPenceresi.close();
});

function jobDetayCiz() {
  const kap = $('#jobDetay');
  const job = state.joblar.find((j) => j.id === state.seciliJob);
  kap.replaceChildren();

  if (!job) {
    kap.append(
      el('div', { class: 'bos' },
        el('h3', { text: 'Kontak baskısı' }),
        el('p', { text: 'Soldan bir iş seç; her prompt burada bir kare olarak basılır. Biten kareler görselini gösterir, düşenler kırmızı çarpı alır.' })
      )
    );
    return;
  }

  const tamam = job.tasks.filter((t) => t.status === 'done').length;
  const hatali = job.tasks.filter((t) => t.status === 'failed').length;
  const durum = job.kosuyor ? 'running' : job.status;

  const bas = el('div', { class: 'tabaka-basi' },
    job.inputFile
      ? el('img', { class: 'input-onizleme', src: gorselYolu(job.id, 'kok', job.inputFile, 'k'), alt: 'İş fotoğrafı' })
      : null,
    el('div', { class: 'tabaka-bilgi' },
      el('div', { class: 'kod-satir' },
        el('div', { class: 'kod', text: job.id }),
        el('span', {
          class: `kaynak-rozet k-${job.kaynak || 'panel'}`,
          title: kaynakBilgisi(job).ipucu,
        }, kaynakBilgisi(job).isaret, kaynakBilgisi(job).etiket)
      ),
      el('div', { class: 'kunye' },
        el('span', { text: job.phone ? `tel ${job.phone}` : 'numara verilmedi' }),
        job.kaynak === 'telegram' && job.kaynakBilgi?.kullanici
          ? el('span', { text: job.kaynakBilgi.kullanici })
          : null,
        job.kaynak === 'telegram'
          ? (() => {
              // Hangi hal gönderilir/gönderildi: mesajda "demo" geçtiyse damgalı.
              const v = job.kaynakBilgi?.teslimVaryanti === 'uretim' ? 'üretim' : 'demo';
              return el('span', {
                class: job.kaynakBilgi?.teslimAt ? 'kunye-tamam' : 'kunye-bekler',
                title: job.kaynakBilgi?.teslimAt
                  ? `${v === 'demo' ? 'Damgalı demo' : 'Damgasız üretim'} kareleri ${tarih(job.kaynakBilgi.teslimAt)} tarihinde sohbete gönderildi`
                  : `Üretim bitince ${v} kareleri sohbete gönderilecek`,
                text: job.kaynakBilgi?.teslimAt
                  ? `↩ ${job.kaynakBilgi.teslimAdet ?? ''} ${v} karesi teslim edildi`.replace('  ', ' ')
                  : `↩ ${v} teslimi bekliyor`,
              });
            })()
          : null,
        el('span', { text: tarih(job.createdAt) }),
        el('span', { text: `${tamam}/${job.tasks.length} tamam${hatali ? ` · ${hatali} hata` : ''}` }),
        el('span', { text: DURUM_ETIKET[durum] }),
        job.inputBoyut
          ? el('span', {
              text: `${job.inputBoyut.genislik}×${job.inputBoyut.yukseklik}${job.inputDonduruldu ? ' ↻ döndürüldü' : ''}`,
            })
          : null,
        job.note ? el('span', { text: job.note }) : null
      )
    ),
    el('div', { class: 'tabaka-eylem' },
      job.kosuyor
        ? el('button', {
            class: 'btn btn-kucuk btn-durdur',
            text: 'Durdur',
            onclick: () => jobDurdur(job.id),
          })
        : el('button', {
            class: 'btn btn-birincil btn-kucuk',
            disabled: !job.tasks.some((t) => t.status === 'pending'),
            text: 'Başlat',
            onclick: () => jobCalistir(job.id),
          }),
      hatali
        ? el('button', {
            class: 'btn btn-ikincil btn-kucuk',
            disabled: job.kosuyor,
            text: `${hatali} kareyi yenile`,
            onclick: () => jobTekrar(job.id, {}),
          })
        : null,
      el('button', { class: 'btn btn-ikincil btn-kucuk', text: 'Klasörü aç', onclick: () => api(`/api/jobs/${job.id}/reveal`, { method: 'POST' }) }),
      job.waLink
        ? el('a', {
            class: 'btn btn-ikincil btn-kucuk btn-wa',
            href: job.waLink,
            target: '_blank',
            rel: 'noopener',
            title: `WhatsApp: ${job.phone}`,
            text: 'Sohbeti aç',
          })
        : null,
      el('button', { class: 'btn btn-ikincil btn-kucuk btn-tehlike', text: 'Sil', disabled: job.kosuyor, onclick: () => jobSil(job.id) })
    )
  );

  const oran = job.tasks.length ? (tamam / job.tasks.length) * 100 : 0;
  const ilerleme = el('div', { class: 'ilerleme' }, el('span', { style: `width:${oran}%` }));

  // Varyant seçici: üretim / demo / baskı hali + print seçim listesi.
  const secili = VARYANTLAR.find((v) => v.ad === state.varyant) || VARYANTLAR[0];
  const dosyaVaryanti = secili.kaynak || secili.ad;
  const ozet = job.baskiOzet || { toplam: 0, secili: 0, basildi: 0 };
  const sekmeSayisi = (v) => (v.ad === 'print' ? ozet.secili : job.varyantlar?.[v.ad] ?? 0);
  const varyantCubugu = el('div', { class: 'varyant-cubugu' },
    el('div', { class: 'segment segment-varyant' },
      ...VARYANTLAR.map((v) =>
        el('button', {
          type: 'button',
          'aria-pressed': String(state.varyant === v.ad),
          onclick: () => {
            state.varyant = v.ad;
            jobDetayCiz();
          },
        },
          v.etiket,
          el('span', { class: 'segment-sayi', text: String(sekmeSayisi(v)) })
        )
      )
    ),
    el('span', {
      class: 'alt-metin',
      text:
        secili.ad === 'print' && ozet.secili
          ? `${ozet.basildi}/${ozet.secili} görsel basıldı · ${ozet.basiliKopya}/${ozet.kopya} kopya`
          : secili.ipucu,
    })
  );

  // Print sekmesi bir klasör değil, seçim listesi: yalnız seçili dosyalar.
  const gorunenTasklar =
    state.varyant === 'print'
      ? job.tasks.filter((t) => (t.baski || []).some((b) => b.secili))
      : job.tasks;

  // Kontak baskısı task DURUMUNU taşır — üretim/demo/baskı sekmelerinde dosya
  // olmasa da çizilir (bekleyen ve çalışan kareler görünmeli).
  if (state.varyant === 'print' && !gorunenTasklar.length) {
    kap.append(bas, ilerleme, varyantCubugu, el('div', { class: 'bos' }, el('p', { text: secili.bos })));
    return;
  }

  const kontak = el('div', { class: 'kontak' });
  // Sunucu varyant bilgisini vermiyorsa (eski sürüm) üretim sekmesinde
  // görseli yine de göster — panel boş kalmasın.
  const dosyaHazirMi = (t) => (t.varyantVar ? t.varyantVar[dosyaVaryanti] : dosyaVaryanti === 'uretim');

  // Işık kutusunun gezineceği set: bu sekmede görüntüsü hazır olan kareler.
  // Sırası kontak baskısıyla aynı — okla ilerlerken ekrandaki düzeni izler.
  const acilabilir = gorunenTasklar
    .map((t, i) => ({ t, no: i + 1 }))
    .filter(({ t }) => t.status === 'done' && t.files?.length && dosyaHazirMi(t))
    .map(({ t, no }) => ({ dosya: t.files[0], platform: t.platform, prompt: t.prompt, no }));

  gorunenTasklar.forEach((t, i) => {
    const bilgi = (t.baski || [])[0] || { dosya: t.files?.[0], secili: false, basildi: false };
    const isaretli = state.varyant === 'print' && bilgi.basildi;
    const kare = el('div', { class: `kare ${kareSinifi(t)}${isaretli ? ' basildi' : ''}${bilgi.secili && state.varyant === 'baski' ? ' secili' : ''}` },
      el('div', { class: 'kare-ust' },
        el('span', { class: 'no', text: String(i + 1).padStart(2, '0') }),
        el('span', { class: 'platform', text: PLATFORM_ETIKET[t.platform] || t.platform })
      ),
      el('div', { class: 'kare-alan' },
        t.status === 'done' && t.files.length && dosyaHazirMi(t)
          ? el('img', {
              src: gorselYolu(job.id, dosyaVaryanti, t.files[0], 'k'),
              alt: t.prompt.slice(0, 80),
              loading: 'lazy',
              title: 'Büyüt — aynı işin kareleri arasında ok tuşlarıyla gezinilir',
              onclick: () =>
                isikKutusuAc(
                  job,
                  dosyaVaryanti,
                  acilabilir,
                  acilabilir.findIndex((k) => k.dosya === t.files[0])
                ),
            })
          : null,
        isaretli ? el('span', { class: 'basildi-rozet', text: '✓ basıldı' }) : null
      ),
      el('div', { class: 'kare-durum' },
        el('span', {
          text:
            t.status === 'done' && !dosyaHazirMi(t)
              // Demo/baskı üretimden sonra basılır (bir an gecikebilir); ham
              // üretimde ise ara durum yoktur — dosya yoksa gelmeyecek demektir.
              ? dosyaVaryanti === 'uretim'
                ? 'dosya bulunamadı — yenile'
                : `${secili.etiket.toLocaleLowerCase('tr')} hazırlanıyor`
              : `${DURUM_ETIKET[t.status]}${t.attempts > 1 ? ` · ${t.attempts}. deneme` : ''}`,
        }),
        state.varyant === 'baski' && t.status === 'done' && dosyaHazirMi(t)
          ? bilgi.secili
            ? adetKontrolu(job.id, bilgi)
            : el('button', {
                class: 'kare-secim',
                text: 'seç',
                title: 'Print listesine ekle',
                onclick: () => baskiSecimi(job.id, bilgi.dosya, { secili: true }),
              })
          : state.varyant === 'print'
            ? el('span', { class: 'kare-print-eylem' },
                el('span', {
                  class: 'adet-rozet',
                  // Kısmi basım olabilir: kopyalar farklı sayfalara düşer.
                  text: bilgi.basiliAdet > 0 && !bilgi.basildi
                    ? `${bilgi.basiliAdet}/${bilgi.adet}`
                    : `×${bilgi.adet}`,
                }),
                el('button', {
                  class: `kare-secim${bilgi.basildi ? ' acik' : ''}`,
                  text: bilgi.basildi ? '✓ basıldı' : 'basılmadı',
                  title: bilgi.basildi ? 'Tümünü basılmadı yap' : 'Tümünü basıldı yap',
                  onclick: () => baskiSecimi(job.id, bilgi.dosya, { basildi: !bilgi.basildi }),
                })
              )
            : t.status === 'failed' || t.status === 'done'
              ? el('button', {
                  class: 'kare-tekrar',
                  text: 'yenile',
                  disabled: job.kosuyor,
                  onclick: () => jobTekrar(job.id, { taskId: t.id }),
                })
              : null
      ),
      el('div', { class: 'kare-prompt', title: t.prompt },
        el('span', { class: 'pid', text: t.promptId }),
        el('span', { class: 'ptext', text: t.prompt })
      ),
      state.varyant === 'print' && bilgi.dosya
        ? el('button', {
            class: 'kare-tekrar kare-sayfa-git',
            text: 'sayfaya git →',
            onclick: () => sayfayaGit(job.id, bilgi.dosya),
          })
        : null,
      t.error ? el('div', { class: 'kare-hata-metni', text: t.error }) : null
    );
    kontak.append(kare);
  });

  kap.append(bas, ilerleme, varyantCubugu, kontak);
}

async function jobCalistir(id) {
  try {
    await api(`/api/jobs/${id}/run`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
}

/** Baskı seçimi / basıldı işareti — sunucu güncel job'ı geri döner. */
async function baskiSecimi(jobId, dosya, degisim) {
  try {
    const guncel = await api(`/api/jobs/${jobId}/secim`, {
      method: 'POST',
      body: { dosya, ...degisim },
    });
    jobUpsert(guncel);
    jobListesiCiz();
    jobDetayCiz();
  } catch (e) {
    alert(e.message);
  }
}

async function jobDurdur(id) {
  try {
    await api(`/api/jobs/${id}/stop`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
}

async function jobTekrar(id, secenek) {
  try {
    await api(`/api/jobs/${id}/retry`, { method: 'POST', body: { ...secenek, run: true } });
  } catch (e) {
    alert(e.message);
  }
}

async function jobSil(id) {
  if (!confirm(`${id} silinsin mi? Üretilen görseller de gider.`)) return;
  await api(`/api/jobs/${id}`, { method: 'DELETE' });
  state.joblar = state.joblar.filter((j) => j.id !== id);
  if (state.seciliJob === id) state.seciliJob = state.joblar[0]?.id || null;
  jobListesiCiz();
  jobDetayCiz();
}

/* ================= YENİ İŞ ================= */
const dialog = $('#yeniIsDialog');

function yeniIsAc() {
  state.yeniFoto = null;
  $('#birakIc').replaceChildren(
    el('span', { class: 'birak-baslik', text: 'Fotoğrafı buraya bırak' }),
    el('span', { class: 'alt-metin', text: 'veya tıkla, dosya seç — jpg, png, webp' })
  );
  $('#birakAlani').classList.remove('dolu');
  $('#telefonInput').value = '';
  $('#notInput').value = '';
  $('#yeniIsHata').classList.add('gizli');
  const uretim = state.promptlar.reduce((n, p) => n + (p.count || 1), 0);
  $('#uretimOzeti').textContent = uretim
    ? `${state.promptlar.length} prompt → ${uretim} üretim`
    : 'Önce prompt listesi gerekiyor.';
  dialog.showModal();
}

$('#yeniIsAc').addEventListener('click', yeniIsAc);

$('#kuyrukAra').addEventListener('input', (e) => {
  state.arama = e.target.value.trim();
  jobListesiCiz();
});

const TARIH_ETIKET = { tumu: 'Tümü', bugun: 'Bugün', dun: 'Dün', aralik: 'seçili aralık' };

$('#isSuzgec').addEventListener('click', (e) => {
  const d = e.target.closest('button[data-durum]');
  if (!d) return;
  state.isSuzgec = d.dataset.durum;
  for (const b of $$('#isSuzgec button')) {
    b.setAttribute('aria-pressed', String(b.dataset.durum === state.isSuzgec));
  }
  jobListesiCiz();
});

$('#kaynakSuzgec').addEventListener('click', (e) => {
  const d = e.target.closest('button[data-kaynak]');
  if (!d) return;
  state.kaynakSuzgec = d.dataset.kaynak;
  for (const b of $$('#kaynakSuzgec button')) {
    b.setAttribute('aria-pressed', String(b.dataset.kaynak === state.kaynakSuzgec));
  }
  jobListesiCiz();
});

function suzgecleriTemizle() {
  state.arama = '';
  state.tarih = { tip: 'tumu', bas: '', bit: '' };
  state.isSuzgec = 'tumu';
  state.kaynakSuzgec = 'tumu';
  $('#kuyrukAra').value = '';
  $('#tarihBas').value = '';
  $('#tarihBit').value = '';
  for (const b of $$('#isSuzgec button')) {
    b.setAttribute('aria-pressed', String(b.dataset.durum === 'tumu'));
  }
  for (const b of $$('#kaynakSuzgec button')) {
    b.setAttribute('aria-pressed', String(b.dataset.kaynak === 'tumu'));
  }
  tarihSegmentiCiz();
  jobListesiCiz();
}

function tarihSegmentiCiz() {
  for (const b of $$('#tarihSegment button')) {
    b.setAttribute('aria-pressed', String(b.dataset.tarih === state.tarih.tip));
  }
  $('#tarihAralik').classList.toggle('gizli', state.tarih.tip !== 'aralik');
}

$('#tarihSegment').addEventListener('click', (e) => {
  const dugme = e.target.closest('button[data-tarih]');
  if (!dugme) return;
  state.tarih.tip = dugme.dataset.tarih;
  // Aralık ilk kez seçilirken bugünle başlat — boş iki kutu yerine çalışan bir varsayılan.
  if (state.tarih.tip === 'aralik' && !state.tarih.bas && !state.tarih.bit) {
    const bugun = gunAnahtari(new Date());
    state.tarih.bas = bugun;
    state.tarih.bit = bugun;
    $('#tarihBas').value = bugun;
    $('#tarihBit').value = bugun;
  }
  tarihSegmentiCiz();
  jobListesiCiz();
});

for (const [id, alan] of [['#tarihBas', 'bas'], ['#tarihBit', 'bit']]) {
  $(id).addEventListener('change', (e) => {
    state.tarih[alan] = e.target.value;
    state.tarih.tip = 'aralik';
    tarihSegmentiCiz();
    jobListesiCiz();
  });
}

function fotoAl(dosya) {
  if (!dosya || !dosya.type.startsWith('image/')) return;
  const okuyucu = new FileReader();
  okuyucu.onload = () => {
    state.yeniFoto = { base64: okuyucu.result, ad: dosya.name };
    $('#birakAlani').classList.add('dolu');
    $('#birakIc').replaceChildren(
      el('img', { src: okuyucu.result, alt: '' }),
      el('div', {},
        el('span', { class: 'birak-baslik', text: dosya.name }),
        el('span', { class: 'alt-metin', text: `${Math.round(dosya.size / 1024)} KB — değiştirmek için tıkla` })
      )
    );
  };
  okuyucu.readAsDataURL(dosya);
}

$('#fotoInput').addEventListener('change', (e) => fotoAl(e.target.files[0]));

const birak = $('#birakAlani');
['dragenter', 'dragover'].forEach((olay) =>
  birak.addEventListener(olay, (e) => {
    e.preventDefault();
    birak.classList.add('uzerinde');
  })
);
['dragleave', 'drop'].forEach((olay) =>
  birak.addEventListener(olay, (e) => {
    e.preventDefault();
    birak.classList.remove('uzerinde');
  })
);
birak.addEventListener('drop', (e) => fotoAl(e.dataTransfer.files[0]));

$('#yeniIsForm').addEventListener('submit', async (e) => {
  const eylem = e.submitter?.value;
  if (eylem === 'iptal' || !eylem) return;
  e.preventDefault();

  const hata = $('#yeniIsHata');
  if (!state.yeniFoto) {
    hata.textContent = 'Önce bir fotoğraf seç.';
    hata.classList.remove('gizli');
    return;
  }
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: {
        imageBase64: state.yeniFoto.base64,
        imageName: state.yeniFoto.ad,
        phone: $('#telefonInput').value.trim() || null,
        note: $('#notInput').value.trim() || null,
        runNow: eylem === 'baslat',
      },
    });
    jobUpsert(job);
    state.seciliJob = job.id;
    dialog.close();
    jobListesiCiz();
    jobDetayCiz();
  } catch (err) {
    hata.textContent = err.message;
    hata.classList.remove('gizli');
  }
});

/* ================= PROMPTLAR ================= */
function promptlariCiz() {
  const kap = $('#promptListesi');
  kap.replaceChildren();

  if (!state.promptTaslak.length) {
    kap.append(
      el('div', { class: 'bos' },
        el('h3', { text: 'Liste boş' }),
        el('p', { text: 'Her prompt bir üretim demek. İlk promptu ekle, platformunu seç, sırayı belirle.' })
      )
    );
  }

  state.promptTaslak.forEach((p, i) => {
    const satir = el('div', { class: 'prompt-satir' },
      el('div', { class: 'prompt-sira', text: String(i + 1).padStart(2, '0') }),
      el('div', { class: 'prompt-govde' },
        el('div', { class: 'prompt-ust' },
          el('input', {
            class: 'prompt-id', type: 'text', value: p.id, placeholder: 'prompt-kodu',
            'aria-label': 'Prompt kodu',
            oninput: (e) => { p.id = e.target.value.trim(); kirlet(); },
          }),
          el('div', { class: 'segment' },
            ...state.platformlar.map((plt) =>
              el('button', {
                type: 'button',
                'aria-pressed': String(p.platform === plt.ad),
                text: PLATFORM_ETIKET[plt.ad] || plt.ad,
                onclick: () => { p.platform = plt.ad; kirlet(); promptlariCiz(); },
              })
            )
          ),
          el('input', {
            class: 'prompt-adet', type: 'number', min: '1', max: '20', value: String(p.count || 1),
            'aria-label': 'Kaç görsel',
            oninput: (e) => { p.count = Math.max(1, Number(e.target.value) || 1); kirlet(); },
          }),
          el('span', { class: 'alt-metin', text: (p.count || 1) > 1 ? `${p.count} görsel` : 'tek görsel' }),
          el('div', { class: 'prompt-arac' },
            el('button', { class: 'ikon-btn', type: 'button', title: 'Yukarı taşı', text: '↑', disabled: i === 0, onclick: () => tasi(i, -1) }),
            el('button', { class: 'ikon-btn', type: 'button', title: 'Aşağı taşı', text: '↓', disabled: i === state.promptTaslak.length - 1, onclick: () => tasi(i, 1) }),
            el('button', { class: 'ikon-btn', type: 'button', title: 'Kopyala', text: '⧉', onclick: () => kopyala(i) }),
            el('button', { class: 'ikon-btn sil', type: 'button', title: 'Sil', text: '×', onclick: () => sil(i) })
          )
        ),
        el('textarea', {
          placeholder: 'Bu fotoğrafı kullanarak…',
          rows: '2',
          'aria-label': 'Prompt metni',
          oninput: (e) => { p.prompt = e.target.value; kirlet(); },
        }, p.prompt)
      )
    );
    kap.append(satir);
  });

  const uretim = state.promptTaslak.reduce((n, p) => n + (p.count || 1), 0);
  $('#promptDosyaAdi').textContent = `${state.promptTaslak.length} prompt · ${uretim} üretim`;
}

function kirlet() {
  state.kaydedilmedi = true;
  $('#promptRozet').classList.remove('gizli');
}

function tasi(i, yon) {
  const j = i + yon;
  if (j < 0 || j >= state.promptTaslak.length) return;
  [state.promptTaslak[i], state.promptTaslak[j]] = [state.promptTaslak[j], state.promptTaslak[i]];
  kirlet();
  promptlariCiz();
}

function kopyala(i) {
  const p = state.promptTaslak[i];
  state.promptTaslak.splice(i + 1, 0, { ...p, id: `${p.id}-kopya` });
  kirlet();
  promptlariCiz();
}

function sil(i) {
  state.promptTaslak.splice(i, 1);
  kirlet();
  promptlariCiz();
}

$('#promptEkle').addEventListener('click', () => {
  const n = state.promptTaslak.length + 1;
  state.promptTaslak.push({
    id: `prompt-${String(n).padStart(2, '0')}`,
    platform: state.platformlar[0]?.ad || 'chatgpt',
    count: 1,
    prompt: '',
  });
  kirlet();
  promptlariCiz();
});

$('#promptKaydet').addEventListener('click', async () => {
  const hata = $('#promptHata');
  try {
    const yanit = await api('/api/prompts', { method: 'PUT', body: { prompts: state.promptTaslak } });
    state.promptlar = yanit.prompts;
    state.promptTaslak = yanit.prompts.map((p) => ({ ...p }));
    state.kaydedilmedi = false;
    $('#promptRozet').classList.add('gizli');
    hata.classList.add('gizli');
    promptlariCiz();
  } catch (e) {
    hata.textContent = e.message;
    hata.classList.remove('gizli');
  }
});

$('#promptGeriAl').addEventListener('click', async () => {
  await promptlariYukle();
  state.kaydedilmedi = false;
  $('#promptRozet').classList.add('gizli');
  $('#promptHata').classList.add('gizli');
});

async function promptlariYukle() {
  const yanit = await api('/api/prompts');
  state.promptlar = yanit.prompts || [];
  state.promptTaslak = state.promptlar.map((p) => ({ ...p }));
  if (yanit.hata) {
    $('#promptHata').textContent = yanit.hata;
    $('#promptHata').classList.remove('gizli');
  }
  promptlariCiz();
}

window.addEventListener('beforeunload', (e) => {
  if (state.kaydedilmedi) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ================= OTURUMLAR ================= */
function oturumSinifi(p) {
  if (p.pencereAcik || p.girisSuruyor) return 'bekliyor';
  if (p.dogrulama) return p.dogrulama.hazir ? 'acik' : 'kapali';
  return p.profilVar ? 'acik' : '';
}

function oturumRozeti(p) {
  if (p.girisSuruyor) return 'giriş sürüyor';
  if (p.pencereAcik) return 'giriş açık';
  if (p.dogrulama) return p.dogrulama.hazir ? 'hazır' : 'sorunlu';
  return p.profilVar ? 'profil var' : 'giriş yok';
}

/** Süreçli giriş (Codex): canlı çıktı + varsa giriş bağlantısı. */
function surecliGirisGovdesi(platformAd, o) {
  return el('div', { class: 'giris-akis' },
    el('div', { class: 'oturum-satir', text: o.ipucu || 'Giriş süreci çalışıyor…' }),
    o.girisUrl
      ? el('a', { class: 'btn btn-birincil btn-kucuk', href: o.girisUrl, target: '_blank', rel: 'noopener', text: 'Giriş sayfasını aç' })
      : null,
    el('pre', { class: 'giris-cikti', id: `girisCikti-${platformAd}-${o.hesap}`, text: o.girisCikti || 'çıktı bekleniyor…' })
  );
}

/** Tek bir hesabın oturum satırı (giriş + havuz durumu + eylemler). */
function hesapKarti(p, o) {
  const dinlenme = o.dinlenmede ? `limitte · ${saatKisa(o.dinlenmeSonu)}'e kadar` : null;
  return el('div', { class: `hesap-kart ${oturumSinifi(o)}${o.dinlenmede ? ' dinlenmede' : ''}` },
    el('div', { class: 'hesap-ust' },
      el('span', { class: 'hesap-ad' }, el('span', { class: 'hesap-nokta' }), o.hesap),
      el('span', { class: 'oturum-rozet', text: dinlenme || oturumRozeti(o) })
    ),
    o.dogrulama ? el('div', { class: 'oturum-satir', text: o.dogrulama.mesaj }) : null,
    !o.dogrulama && o.sonGiris ? el('div', { class: 'oturum-satir', text: `son giriş: ${tarih(o.sonGiris)}` }) : null,
    !o.dinlenmede && o.aktifSlot > 0
      ? el('div', { class: 'oturum-satir', text: `çalışıyor (${o.aktifSlot}/${o.kapasite})` })
      : null,
    el('div', { class: 'oturum-eylem' },
      o.girisSuruyor
        ? el('button', { class: 'btn btn-ikincil btn-kucuk btn-tehlike', text: 'Vazgeç', onclick: () => girisIptal(p.ad, o.hesap) })
        : o.pencereAcik
          ? el('button', { class: 'btn btn-birincil btn-kucuk', text: 'Girişi tamamladım', onclick: () => loginBitir(p.ad, o.hesap) })
          : el('button', { class: 'btn btn-ikincil btn-kucuk', text: o.profilVar ? 'Yeniden giriş' : 'Giriş yap', onclick: () => loginBaslat(p.ad, o.hesap) }),
      el('button', { class: 'btn btn-ikincil btn-kucuk', text: 'Sına', disabled: o.pencereAcik || o.girisSuruyor, onclick: (e) => oturumSina(p.ad, o.hesap, e.target) }),
      // Son hesap silinemez.
      p.cokluHesap
        ? el('button', { class: 'btn btn-ikincil btn-kucuk btn-tehlike', text: 'Sil', onclick: () => hesapSil(p.ad, o.hesap) })
        : null
    ),
    o.girisSuruyor ? surecliGirisGovdesi(p.ad, o) : null,
    o.pencereAcik
      ? el('p', { class: 'alt-metin', text: 'Tarayıcı penceresi açıldı. Girişi orada tamamla, sonra "Girişi tamamladım"a bas.' })
      : null
  );
}

function oturumlariCiz() {
  const kap = $('#oturumKartlari');
  kap.replaceChildren();

  for (const p of state.platformlar) {
    const oturumlar = p.oturumlar || [p];
    const kart = el('div', { class: 'oturum-kart' },
      el('div', { class: 'oturum-ust' },
        el('h3', { text: PLATFORM_ETIKET[p.ad] || p.ad }),
        el('span', {
          class: 'oturum-rozet',
          text: p.girisTipi === 'surec' ? `${p.adapter} · codex` : (p.adapter || p.ad),
        })
      ),
      el('div', { class: 'hesap-listesi' }, ...oturumlar.map((o) => hesapKarti(p, o))),
      el('button', {
        class: 'btn btn-ekle btn-kucuk',
        text: '+ Hesap ekle',
        title: 'Bu platforma yeni bir hesap ekle (havuza katılır)',
        onclick: () => hesapEkle(p.ad),
      })
    );
    kap.append(kart);
  }

  // Telegram botu bir "oturum" değil ama aynı yerde durur: hat açık mı,
  // kim iş açabiliyor, bugüne kadar kaç iş geldi.
  const tg = state.telegram;
  if (tg) {
    kap.append(
      el('div', { class: `oturum-kart ${tg.acik ? 'acik' : 'kapali'}` },
        el('div', { class: 'oturum-ust' },
          el('h3', { text: 'Telegram' }),
          el('span', { class: 'oturum-rozet', text: tg.acik ? 'dinliyor' : 'kapalı' })
        ),
        el('div', { class: 'oturum-satir', text: tg.bot ? `@${tg.bot.username}` : 'bot bilgisi yok' }),
        el('div', {
          class: 'oturum-satir',
          text: tg.ayar?.izinliChatler?.length
            ? `izinli sohbet: ${tg.ayar.izinliChatler.join(', ')}`
            : 'herkese açık — /id komutu chat kimliğini söyler',
        }),
        el('div', {
          class: 'oturum-satir',
          text: `${tg.acilanIs || 0} iş açıldı · ${tg.teslimEdilen || 0} teslim · son mesaj ${tarih(tg.sonMesaj)}`,
        }),
        tg.hata ? el('div', { class: 'oturum-satir', text: tg.hata }) : null,
        el('p', {
          class: 'alt-metin',
          text: 'Bota gelen her fotoğraf bir iş açar; yanındaki telefon/isim künyeye yazılır. Üretim bitince demo kareler tek albüm halinde sohbete döner.',
        })
      )
    );
  }

  // Bar sağındaki bağlantı lambaları: üretim platformları + Telegram hattı.
  const lambalar = $('#barLambalar');
  lambalar.replaceChildren(
    ...state.platformlar.map((p) =>
      el('span', {
        class: `oturum-lamba ${oturumSinifi(p) === 'acik' ? 'acik' : oturumSinifi(p) === 'kapali' ? 'kapali' : ''}`,
        title: havuzTooltip(p) || p.dogrulama?.mesaj || (p.profilVar ? 'Profil var, henüz sınanmadı' : 'Giriş yapılmadı'),
      },
        el('i'),
        PLATFORM_ETIKET[p.ad] || p.ad
      )
    ),
    el('span', {
      class: `oturum-lamba ${tg ? (tg.acik ? 'acik' : 'kapali') : ''}`,
      title: tg
        ? tg.acik
          ? `${tg.bot ? '@' + tg.bot.username : 'Bot'} dinliyor · ${tg.acilanIs || 0} iş · ${tg.teslimEdilen || 0} teslim`
          : tg.hata || 'Bot kapalı'
        : 'Telegram botu bu panelde açık değil',
    },
      el('i'),
      'Telegram'
    ),
    // Dış erişim: panel internete açık mı, açıksa bağlantıyı tek tıkla aç.
    el('span', {
      class: `oturum-lamba ${state.disErisim?.acik ? 'acik' : ''}`,
      title: state.disErisim?.acik
        ? `Panel dışarı açık: ${state.disErisim.adres}`
        : 'Dış erişim kapalı — VOKU kontrol panelinden "Dışarıya aç" ile açılır',
    },
      el('i'),
      'Dış erişim',
      state.disErisim?.acik && state.disErisim.paylasimLinki
        ? el('a', {
            class: 'lamba-link',
            href: state.disErisim.paylasimLinki,
            target: '_blank',
            rel: 'noopener',
            title: 'Paylaşım bağlantısını yeni sekmede aç',
            onclick: (e) => e.stopPropagation(),
          }, '↗')
        : null
    )
  );
}

/** Bir platform+hesap için oturum objesini state'te bulur. */
function oturumBul(ad, hesap) {
  const p = state.platformlar.find((x) => x.ad === ad);
  if (!p) return null;
  return (p.oturumlar || []).find((o) => o.hesap === hesap) || null;
}

const hesapQuery = (hesap) => (hesap ? `?hesap=${encodeURIComponent(hesap)}` : '');

async function loginBaslat(ad, hesap) {
  try {
    const yanit = await api(`/api/login/${ad}/start${hesapQuery(hesap)}`, { method: 'POST' });
    const o = oturumBul(ad, hesap);
    if (o) {
      if (yanit.surecli) { o.girisSuruyor = true; o.girisCikti = ''; }
      else o.pencereAcik = true;
    }
    oturumlariCiz();
  } catch (e) {
    alert(e.message);
  }
}

async function girisIptal(ad, hesap) {
  try {
    await api(`/api/login/${ad}/cancel${hesapQuery(hesap)}`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  const o = oturumBul(ad, hesap);
  if (o) o.girisSuruyor = false;
  oturumlariCiz();
}

async function loginBitir(ad, hesap) {
  try {
    const yanit = await api(`/api/login/${ad}/finish${hesapQuery(hesap)}`, { method: 'POST' });
    const i = state.platformlar.findIndex((x) => x.ad === ad);
    if (i >= 0) state.platformlar[i] = yanit.platform;
    oturumlariCiz();
    oturumSina(ad, hesap);
  } catch (e) {
    alert(e.message);
  }
}

async function oturumSina(ad, hesap, dugme) {
  if (dugme) { dugme.disabled = true; dugme.textContent = 'Sınanıyor…'; }
  try {
    const sonuc = await api(`/api/login/${ad}/verify${hesapQuery(hesap)}`, { method: 'POST' });
    const o = oturumBul(ad, hesap);
    if (o) o.dogrulama = sonuc;
  } catch (e) {
    const o = oturumBul(ad, hesap);
    if (o) o.dogrulama = { hazir: false, mesaj: e.message, kontrol: new Date().toISOString() };
  }
  oturumlariCiz();
}

async function hesapEkle(ad) {
  const isim = prompt('Yeni hesap adı (örn: onur):');
  if (!isim || !isim.trim()) return;
  try {
    const yanit = await api(`/api/hesap/${ad}`, { method: 'POST', body: { ad: isim.trim() } });
    const i = state.platformlar.findIndex((x) => x.ad === ad);
    if (i >= 0) state.platformlar[i] = yanit.platform;
    oturumlariCiz();
  } catch (e) {
    alert(e.message);
  }
}

async function hesapSil(ad, hesap) {
  if (!confirm(`"${hesap}" hesabı havuzdan çıkarılsın mı? (oturum dosyaları kalır)`)) return;
  try {
    const yanit = await api(`/api/hesap/${ad}/${encodeURIComponent(hesap)}`, { method: 'DELETE' });
    const i = state.platformlar.findIndex((x) => x.ad === ad);
    if (i >= 0) state.platformlar[i] = yanit.platform;
    oturumlariCiz();
  } catch (e) {
    alert(e.message);
  }
}

/* ================= BASKI ODASI ================= */
async function odayiYukle(seciliKoru = true) {
  try {
    state.oda = await api('/api/baski-odasi');
    if (!seciliKoru || !state.oda.sayfalar.some((s) => s.id === state.seciliSayfa)) {
      state.seciliSayfa = state.oda.sayfalar.at(-1)?.id || null;
    }
  } catch (e) {
    state.oda = { sayfalar: [], hata: e.message };
  }
  odayiCiz();
}

function odaRozetiGuncelle() {
  const rozet = $('#odaRozet');
  const n = state.oda?.bekleyenKopya || 0;
  rozet.textContent = String(n);
  rozet.classList.toggle('gizli', n === 0);
}

function sayfaEsliyorMu(s, terim) {
  if (!terim) return true;
  const havuz = [s.id, `sayfa ${s.no}`, ...s.kalemler.map((k) => `${k.jobId} ${k.jobEtiket} ${k.promptId}`)]
    .join(' ')
    .toLocaleLowerCase('tr');
  return terim.toLocaleLowerCase('tr').split(/\s+/).filter(Boolean).every((p) => havuz.includes(p));
}

function odayiCiz() {
  odaRozetiGuncelle();
  const oda = state.oda || {};
  const liste = $('#sayfaListesi');
  liste.replaceChildren();

  if (oda.hata) {
    liste.append(el('p', { class: 'uyari', text: oda.hata }));
    return;
  }

  const gorunen = (oda.sayfalar || [])
    .filter((s) =>
      state.sayfaSuzgec === 'basildi' ? s.basildi : state.sayfaSuzgec === 'bekliyor' ? !s.basildi : true
    )
    .filter((s) => sayfaEsliyorMu(s, state.sayfaArama))
    .reverse(); // en yeni üstte

  if (!gorunen.length) {
    liste.append(
      el('div', { class: 'bos' },
        el('p', {
          text: (oda.sayfalar || []).length
            ? 'Bu süzgeçle eşleşen sayfa yok.'
            : 'Sayfa yok. İşlerin Baskı sekmesinden basılacakları seç.',
        })
      )
    );
  }

  for (const s of gorunen) {
    const isAdlari = [...new Set(s.kalemler.map((k) => k.jobEtiket))];
    liste.append(
      el('button', {
        class: `job-satir sayfa-satir ${s.basildi ? 'd-done' : s.kilitli ? 'd-running' : 'd-pending'}`,
        'aria-current': String(state.seciliSayfa === s.id),
        onclick: () => {
          state.seciliSayfa = s.id;
          odayiCiz();
        },
      },
        el('span', { class: `sayfa-ibare ${s.basildi ? 'basildi' : s.kilitli ? 'hazir' : 'dolmadi'}` }),
        el('span', { class: 'job-bilgi' },
          el('span', { class: 'kod', text: `Sayfa ${s.no}` }),
          el('span', { class: 'satir-alt' },
            el('span', { text: isAdlari.join(', ').slice(0, 24) }),
            el('span', { text: `${s.kalemler.length}/${oda.grupBoyutu}` })
          )
        )
      )
    );
  }

  sayfaDetayCiz();
}

function sayfaDetayCiz() {
  const kap = $('#sayfaDetay');
  kap.replaceChildren();
  const oda = state.oda || {};
  const s = (oda.sayfalar || []).find((x) => x.id === state.seciliSayfa);

  if (!s) {
    kap.append(
      el('div', { class: 'bos' },
        el('h3', { text: 'Baskı odası' }),
        el('p', { text: 'Soldan bir sayfa seç. Sayfalar 6 kopya dolunca kilitlenir; basıldığında tarihi damgalanır.' })
      )
    );
    return;
  }

  const isAdlari = [...new Set(s.kalemler.map((k) => k.jobEtiket))];
  kap.append(
    el('div', { class: 'tabaka-basi' },
      el('div', { class: 'tabaka-bilgi' },
        el('div', { class: 'kod', text: `Sayfa ${s.no}` }),
        el('div', { class: 'kunye' },
          el('span', { text: `${s.kalemler.length}/${oda.grupBoyutu} kopya` }),
          el('span', { text: s.doldu ? `doldu ${tarih(s.doldu)}` : 'henüz dolmadı' }),
          el('span', { class: s.basildi ? 'kunye-basildi' : '', text: s.basildi ? `basıldı ${tarih(s.basildi)}` : 'basılmadı' }),
          el('span', { text: isAdlari.join(', ') })
        )
      ),
      el('div', { class: 'tabaka-eylem' },
        s.basildi
          ? el('button', { class: 'btn btn-ikincil btn-kucuk', text: 'Basımı geri al', onclick: (e) => sayfaEylem(s.id, 'geri-al', e.target) })
          : el('button', { class: 'btn btn-birincil btn-kucuk', text: 'Basıldı olarak işaretle', onclick: (e) => sayfaEylem(s.id, 'bas', e.target) }),
        // Tek düğme: dosya yoksa önce üretir, sonra indirir — her adımda
        // düğme ne olduğunu yazar (sessiz bekleme olmasın).
        el('button', {
          class: 'btn btn-ikincil btn-kucuk',
          text: s.etdx ? `.etdx indir${s.etdxBoyut ? ` (${Math.round(s.etdxBoyut / 1048576)} MB)` : ''}` : '.etdx hazırla ve indir',
          onclick: (e) => etdxIndir(s, e.target),
        }),
        s.etdx
          ? el('button', {
              class: 'btn btn-ikincil btn-kucuk',
              title: 'Görseller değiştiyse dosyayı baştan üret',
              text: 'yenile',
              onclick: (e) => sayfaEylem(s.id, 'etdx', e.target),
            })
          : null
      )
    ),
    el('div', { class: 'oda-kareler' },
      ...s.kalemler.map((k) =>
        el('button', {
          class: 'oda-kare',
          title: `${k.jobId} · ${k.dosya} — işe git`,
          onclick: () => isegit(k.jobId),
        },
          el('img', {
            src: gorselYolu(k.jobId, 'baski', k.dosya, 'k'),
            alt: k.promptId,
            loading: 'lazy',
          }),
          el('span', { class: 'oda-kare-etiket' },
            el('span', { class: 'pid', text: k.promptId }),
            k.toplamAdet > 1 ? el('span', { class: 'adet-rozet', text: `×${k.toplamAdet}` }) : null
          )
        )
      )
    )
  );
}

/** Baskı odasından iş detayına geç (kare tıklaması). */
function isegit(jobId) {
  state.seciliJob = jobId;
  state.varyant = 'baski';
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === 'isler')));
  $$('.view').forEach((v) => v.classList.add('gizli'));
  $('#view-isler').classList.remove('gizli');
  jobListesiCiz();
  jobDetayCiz();
}

/** İş detayından, o dosyanın bulunduğu sayfaya geç. */
async function sayfayaGit(jobId, dosya) {
  if (!state.oda) await odayiYukle(false);
  const sayfa = (state.oda?.sayfalar || []).find((s) =>
    s.kalemler.some((k) => k.jobId === jobId && k.dosya === dosya)
  );
  if (!sayfa) return alert('Bu kopya henüz bir sayfaya yerleşmedi.');
  state.seciliSayfa = sayfa.id;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === 'baski-odasi')));
  $$('.view').forEach((v) => v.classList.add('gizli'));
  $('#view-baski-odasi').classList.remove('gizli');
  odayiCiz();
}

/**
 * .etdx indir: gerekirse önce üretir. Her aşamada düğme metnini günceller —
 * dosya 15 MB civarı olduğu için sessiz bekleme "tıkladım, bir şey olmadı"
 * hissi veriyordu.
 */
async function etdxIndir(sayfa, dugme) {
  dugme.disabled = true;
  try {
    let guncel = sayfa;
    if (!guncel.etdx) {
      dugme.textContent = 'hazırlanıyor…';
      state.oda = await api(`/api/sayfa/${sayfa.id}/etdx`, { method: 'POST' });
      guncel = state.oda.sayfalar.find((s) => s.id === sayfa.id) || guncel;
    }

    dugme.textContent = 'indiriliyor…';
    const yanit = await fetch(`/api/sayfa/${guncel.id}/etdx`);
    if (!yanit.ok) throw new Error(`İndirilemedi (${yanit.status})`);
    const veri = await yanit.blob();

    const url = URL.createObjectURL(veri);
    const bag = document.createElement('a');
    bag.href = url;
    bag.download = `${guncel.id}.etdx`;
    document.body.append(bag);
    bag.click();
    bag.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    dugme.textContent = `✓ indirildi (${Math.round(veri.size / 1048576)} MB)`;
    setTimeout(odayiCiz, 2500);
  } catch (e) {
    alert(e.message);
    odayiCiz();
  }
}

async function sayfaEylem(sayfaId, eylem, dugme) {
  const eskiMetin = dugme?.textContent;
  if (dugme) {
    dugme.disabled = true;
    dugme.textContent = eylem === 'etdx' ? 'üretiliyor…' : 'işleniyor…';
  }
  try {
    state.oda = await api(`/api/sayfa/${sayfaId}/${eylem}`, { method: 'POST' });
    const durum = await api('/api/state');
    state.joblar = durum.joblar;
    jobListesiCiz();
    if (state.seciliJob) jobDetayCiz();
  } catch (e) {
    alert(e.message);
    if (dugme) {
      dugme.disabled = false;
      dugme.textContent = eskiMetin;
    }
  }
  odayiCiz();
}

$('#odaYenile').addEventListener('click', () => odayiYukle());
$('#sayfaAra').addEventListener('input', (e) => {
  state.sayfaArama = e.target.value.trim();
  odayiCiz();
});
$('#sayfaSuzgec').addEventListener('click', (e) => {
  const d = e.target.closest('button[data-suzgec]');
  if (!d) return;
  state.sayfaSuzgec = d.dataset.suzgec;
  for (const b of $$('#sayfaSuzgec button')) {
    b.setAttribute('aria-pressed', String(b.dataset.suzgec === state.sayfaSuzgec));
  }
  odayiCiz();
});

/* ================= CANLI LOG ================= */
const logGovde = $('#logGovde');
const logSerit = $('#logSerit');
let canliZamanlayici;

$('#logAcKapa').addEventListener('click', () => {
  const kapali = logSerit.classList.toggle('kapali');
  $('#logAcKapa').setAttribute('aria-expanded', String(!kapali));
  if (!kapali) logGovde.scrollTop = logGovde.scrollHeight;
});

function logEkle({ ts, seviye, mesaj }) {
  const saat = ts ? ts.slice(11, 19) : '';
  logGovde.append(
    el('div', { class: `log-satir ${seviye}` },
      el('span', { class: 'zaman', text: saat }),
      el('span', { class: 'metin', text: mesaj })
    )
  );
  while (logGovde.children.length > 300) logGovde.firstChild.remove();
  logGovde.scrollTop = logGovde.scrollHeight;
  $('#logSon').textContent = mesaj;

  logSerit.classList.add('canli');
  clearTimeout(canliZamanlayici);
  canliZamanlayici = setTimeout(() => logSerit.classList.remove('canli'), 4000);
}

/* ================= AKIŞ ================= */
function akisiBagla() {
  const kaynak = new EventSource('/api/events');
  kaynak.onmessage = (olay) => {
    const { tip, veri } = JSON.parse(olay.data);
    if (tip === 'log') return logEkle(veri);
    if (tip === 'job') {
      jobUpsert(veri);
      jobListesiCiz();
      if (state.seciliJob === veri.id) jobDetayCiz();
    }
    if (tip === 'giris') {
      const o = oturumBul(veri.platform, veri.hesap || 'varsayılan');
      if (!o) return;
      if (veri.bitti) {
        o.girisSuruyor = false;
        o.girisCikti = null;
        o.girisUrl = null;
        oturumlariCiz();
        return;
      }
      o.girisSuruyor = true;
      o.girisCikti = ((o.girisCikti || '') + veri.metin).slice(-1200);
      const yeniUrl = veri.url && veri.url !== o.girisUrl;
      o.girisUrl = veri.url || o.girisUrl;
      // Sadece çıktı akıyorsa kutuyu güncelle; URL gelince kartı yeniden çiz.
      const kutu = document.getElementById(`girisCikti-${veri.platform}-${o.hesap}`);
      if (kutu && !yeniUrl) {
        kutu.textContent = o.girisCikti;
        kutu.scrollTop = kutu.scrollHeight;
      } else {
        oturumlariCiz();
      }
      return;
    }
    if (tip === 'platform') {
      const i = state.platformlar.findIndex((x) => x.ad === veri.ad);
      if (i >= 0) state.platformlar[i] = { ...state.platformlar[i], ...veri };
      oturumlariCiz();
      return;
    }
    if (tip === 'telegram') {
      state.telegram = veri;
      oturumlariCiz(); // bar lambası + oturum kartı buradan besleniyor
      return;
    }
    if (tip === 'kosu') {
      const job = state.joblar.find((j) => j.id === veri.id);
      if (job) job.kosuyor = veri.kosuyor;
      jobListesiCiz();
      if (state.seciliJob === veri.id) jobDetayCiz();
    }
  };
  // Akış koptuğunda EventSource kendiliğinden yeniden bağlanır ama arada olan
  // biteni kaçırır — her bağlanışta durum sunucudan tazelenir, böylece panel
  // elle yenilenmeden güncel kalır (açık sekme, seçili iş, süzgeçler korunur).
  kaynak.onopen = () => {
    if (akisKopmustu) {
      $('#logSon').textContent = 'akış geri geldi';
      akisKopmustu = false;
    }
    durumuTazele();
  };
  kaynak.onerror = () => {
    akisKopmustu = true;
    $('#logSon').textContent = 'akış koptu — yeniden bağlanılıyor…';
  };
}

let akisKopmustu = false;

/**
 * Sunucu durumunu sessizce tazeler: joblar, platformlar, Telegram hattı.
 * Sayfa yenilemenin aksine açık sekme, seçili iş, varyant sekmesi ve
 * süzgeçler yerinde kalır. Prompt taslağına dokunulmaz (kaydedilmemiş
 * düzenleme ezilmesin).
 */
let sonTazeleme = 0;

async function durumuTazele() {
  let durum;
  try {
    durum = await api('/api/state');
    sonTazeleme = Date.now();
  } catch {
    return; // sunucu kapalıysa akış hatası zaten görünüyor
  }
  state.platformlar = durum.platformlar;
  state.telegram = durum.telegram || null;
  state.disErisim = durum.disErisim || null;
  state.joblar = durum.joblar;
  // Seçili iş silinmişse ilk işe düş; duruyorsa seçim korunur.
  if (state.seciliJob && !durum.joblar.some((j) => j.id === state.seciliJob)) {
    state.seciliJob = durum.joblar[0]?.id || null;
  }
  jobListesiCiz();
  jobDetayCiz();
  oturumlariCiz();
  // Baskı odası gizliyken de tazelenir: sekme rozeti (bekleyen kopya) güncel kalsın.
  odayiYukle();
}

async function baslat() {
  const durum = await api('/api/state');
  state.platformlar = durum.platformlar;
  state.joblar = durum.joblar;
  state.telegram = durum.telegram || null;
  state.disErisim = durum.disErisim || null;
  state.seciliJob = durum.joblar[0]?.id || null;

  await promptlariYukle();
  jobListesiCiz();
  jobDetayCiz();
  oturumlariCiz();
  akisiBagla();
  odayiYukle(); // rozet ilk açılışta da dolsun

  // Emniyet ağı: SSE canlı akışı taşır ama bir paket kaçarsa panel sessizce
  // bayatlar. Sekme görünürken 45 sn'de bir, sekmeye dönüldüğünde hemen
  // senkronlanır — kullanıcının F5'e basması gerekmesin.
  setInterval(() => {
    if (document.visibilityState === 'visible') durumuTazele();
  }, 45000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') durumuTazele();
  });
}

baslat().catch((e) => {
  document.body.prepend(el('p', { class: 'uyari', text: `Panel açılamadı: ${e.message}` }));
});
