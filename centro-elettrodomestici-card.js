/*! Centro Elettrodomestici Card — card indipendente per lavastoviglie, forno,
 *  frigorifero o congelatore. Grafica realistica (SVG) diversa per tipo,
 *  rilevamento fase dal consumo, storico cicli e costo (per lavastoviglie/forno,
 *  che si usano a sessioni) oppure grafico consumo continuo (per frigo/congelatore,
 *  che girano sempre). Gira nel browser, indipendente dal server esterno.
 */
const CEC_VERSION = "1.1.0";
console.info(`%c CENTRO-ELETTRODOMESTICI-CARD %c v${CEC_VERSION} `,
  "color:#2b1a06;background:#ffb020;font-weight:700;border-radius:4px 0 0 4px",
  "color:#fff0d6;background:#1a1b21;border-radius:0 4px 4px 0");

const WD = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
// lavastoviglie/forno = uso a sessioni (mostra storico cicli); frigo/congelatore =
// funzionamento continuo (compressore che cicla tutto il giorno: la lista cicli non
// avrebbe senso, meglio solo il grafico consumo).
const SHOW_CYCLES = { lavastoviglie: true, forno: true, frigorifero: false, congelatore: false };
const CONTINUOUS = { frigorifero: true, congelatore: true };

const CEC_DEFAULTS = {
  lavastoviglie: { kind: "lavastoviglie", name: "Lavastoviglie", power: "sensor.shelly_lavastoviglie_power",
    energy: "sensor.shelly_lavastoviglie_energy", switch: "switch.shelly_lavastoviglie",
    soglia: 10, soglia_riscaldamento: 1200, prezzo_kwh: 0.30, storico_giorni: 14 },
  forno: { kind: "forno", name: "Forno", power: "sensor.presa_forno_power",
    energy: "sensor.presa_forno_energy", switch: "switch.presa_forno",
    soglia: 15, preriscaldo_min: 10, prezzo_kwh: 0.30, storico_giorni: 14 },
  frigorifero: { kind: "frigorifero", name: "Frigorifero", power: "sensor.frigo_power",
    energy: "sensor.frigo_energy", switch: "switch.frigo_outlet",
    soglia: 15, prezzo_kwh: 0.30, storico_giorni: 14 },
  congelatore: { kind: "congelatore", name: "Congelatore", power: "sensor.congelatore_potenza",
    energy: "sensor.congelatore_energia_kwh", switch: "switch.congelatore_presa_1",
    soglia: 15, prezzo_kwh: 0.30, storico_giorni: 14 },
};

// Impedisce a librerie tipo "hass-swipe-navigation" di leggere un tocco dentro la
// card come uno swipe di cambio-vista. Ferma la propagazione del gesto (senza
// preventDefault): scroll verticale e tap restano normali.
function stopSwipeNavHijack(el) {
  ["touchstart", "touchmove", "touchend", "pointerdown", "pointermove"].forEach(evt =>
    el.addEventListener(evt, e => e.stopPropagation(), { passive: true }));
}

// Classifica la fase dal consumo istantaneo (euristica a soglie, non legge il
// programma reale della macchina).
function classifyPhase(kind, p, cfg, runSince) {
  const soglia = parseFloat(cfg.soglia) || 10;
  if (p == null || p <= soglia) {
    if (CONTINUOUS[kind]) return { key: "off", label: "Compressore a riposo" };
    return { key: "off", label: kind === "forno" ? "Spento" : "Ferma" };
  }
  if (kind === "lavastoviglie") {
    const sr = parseFloat(cfg.soglia_riscaldamento) || 0;
    if (sr > 0 && p >= sr) return { key: "heat", label: "Riscaldamento acqua" };
    return { key: "wash", label: "Lavaggio / risciacquo" };
  }
  if (kind === "forno") {
    const preheatMin = parseFloat(cfg.preriscaldo_min) || 10;
    const elapsedMin = runSince ? (Date.now() - runSince) / 60000 : 0;
    if (elapsedMin < preheatMin) return { key: "preheat", label: "Preriscaldo" };
    return { key: "cook", label: "In cottura" };
  }
  return { key: "cool", label: "Compressore attivo" }; // frigorifero / congelatore
}

function dispLabelFor(key) {
  if (key === "wash") return "LAVAGGIO";
  if (key === "heat") return "RISCALDO";
  if (key === "preheat") return "PRERISCALDO";
  if (key === "cook") return "IN COTTURA";
  if (key === "cool") return "ATTIVO";
  return "IN CORSO";
}

class CentroElettrodomesticiCard extends HTMLElement {
  setConfig(config) {
    const kind = CEC_DEFAULTS[config && config.kind] ? config.kind : "lavastoviglie";
    const base = CEC_DEFAULTS[kind];
    this._cfg = Object.assign({}, base, config || {}, { kind });
    if (!config || !config.name) this._cfg.name = base.name;
    this._built = false;
    this._hist = null;
    this._histLoading = false;
    this._histTs = 0;
    this._runSince = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) { this._build(); this._built = true; this._loadHistory(); }
    this._update();
    if (!this._histLoading && Date.now() - this._histTs > 10 * 60 * 1000) this._loadHistory();
  }

  getCardSize() { return 6; }
  // Dashboard "sections": dichiara che la card è ridimensionabile — HA mostra la
  // scheda "Layout" nell'editor con le maniglie per allungarla/accorciarla.
  getLayoutOptions() {
    return { grid_rows: 6, grid_columns: 4, grid_min_rows: 3, grid_max_rows: 14, grid_min_columns: 2, grid_max_columns: 6 };
  }
  static getConfigElement() { return document.createElement("centro-elettrodomestici-card-editor"); }
  static getStubConfig() { return JSON.parse(JSON.stringify(CEC_DEFAULTS.lavastoviglie)); }

  _num(entity) {
    const s = this._hass && this._hass.states[entity];
    if (!s) return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }
  _fmt(x) { return (Math.round(x * 100) / 100).toLocaleString("it-IT", { minimumFractionDigits: x < 10 ? 2 : 1, maximumFractionDigits: 2 }); }
  _fmtE(k) { return "≈ " + (k * (parseFloat(this._cfg.prezzo_kwh) || 0)).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"; }
  _dkey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  _dlabel(d) { return `${WD[(d.getDay() + 6) % 7]} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; }
  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---- storico, ricostruito dallo storico energia (recorder statistics) ----
  async _loadHistory() {
    if (!this._hass || !this._cfg.energy) { this._hist = null; return; }
    this._histLoading = true;
    const days = parseInt(this._cfg.storico_giorni) || 14;
    const now = new Date();
    const start = new Date(now.getTime() - days * 86400000);
    try {
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(), end_time: now.toISOString(),
        statistic_ids: [this._cfg.energy], period: "hour", types: ["change"],
      });
      const rows = (res && res[this._cfg.energy]) || [];
      this._hist = this._computeStats(rows);
    } catch (e) {
      this._hist = null;
      console.warn("[centro-elettrodomestici-card] storico non disponibile:", e);
    }
    this._histLoading = false;
    this._histTs = Date.now();
    this._update();
  }

  _computeStats(rows) {
    const NOISE = 0.01;
    const GAP_MERGE_H = 1;
    const buckets = rows.map(r => ({ t: new Date(r.start), kwh: (r.change && r.change > 0) ? r.change : 0 }))
      .sort((a, b) => a.t - b.t);
    const daily = {};
    for (const b of buckets) { const k = this._dkey(b.t); daily[k] = (daily[k] || 0) + b.kwh; }
    let cycles = [];
    if (SHOW_CYCLES[this._cfg.kind]) {
      const runs = [];
      let cur = null;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const active = b.kwh > NOISE;
        if (active) {
          if (!cur) cur = { start: b.t, end: new Date(b.t.getTime() + 3600000), kwh: 0 };
          cur.end = new Date(b.t.getTime() + 3600000);
          cur.kwh += b.kwh;
        } else if (cur) {
          const bridged = buckets.slice(i + 1, i + 1 + GAP_MERGE_H).some(x => x.kwh > NOISE);
          if (!bridged) { runs.push(cur); cur = null; }
        }
      }
      if (cur) runs.push(cur);
      cycles = runs.filter(r => r.kwh > 0.02).map(r => ({
        start: r.start, end: r.end, kwh: Math.round(r.kwh * 1000) / 1000,
        hours: Math.max(1, Math.round((r.end - r.start) / 3600000)),
      })).sort((a, b) => b.start - a.start);
    }
    return { cycles, daily };
  }

  _isOngoing(cycle) { return (Date.now() - cycle.end.getTime()) < 2 * 3600000; }

  // Se è configurata una foto vera (photo_url), mostra quella; altrimenti il
  // disegno animato. Badge/LED restano identici in entrambi i casi.
  _visual() {
    if (this._cfg.photo_url) {
      return `<img src="${this._esc(this._cfg.photo_url)}" alt="${this._esc(this._cfg.name)}"
        style="width:100%;border-radius:16px;display:block;object-fit:cover;max-height:280px"
        onerror="this.style.display='none'">`;
    }
    return this._machineSVG();
  }

  // ---- grafica macchina (diversa per tipo) -----------------------------------
  _machineSVG() {
    const kind = this._cfg.kind;
    if (kind === "lavastoviglie") return this._svgLavastoviglie();
    if (kind === "forno") return this._svgForno();
    if (kind === "frigorifero") return this._svgFrigo2Ante();
    return this._svgCongelatore();
  }

  _svgLavastoviglie() {
    const accent = "#47b5ff";
    return `
    <svg viewBox="0 0 200 250" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="lv-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#eef4fa"/><stop offset="1" stop-color="#d7dee6"/>
        </linearGradient>
        <linearGradient id="lv-door" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f4f8fb"/><stop offset="1" stop-color="#c9d3dc"/>
        </linearGradient>
        <radialGradient id="lv-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="rgba(71,181,255,.55)"/><stop offset="1" stop-color="rgba(71,181,255,0)"/>
        </radialGradient>
      </defs>
      <rect x="20" y="14" width="160" height="216" rx="14" fill="url(#lv-body)" stroke="#c2cbd4" stroke-width="1.5"/>
      <!-- pannello LED superiore -->
      <rect x="30" y="24" width="140" height="20" rx="6" fill="#0f1720"/>
      <text x="42" y="38" text-anchor="middle" font-family="monospace" font-size="10" fill="${accent}" data-role="disp">--:--</text>
      <g data-role="cyclelights">
        <circle cx="120" cy="34" r="4" class="cec-cyc" data-c="wash" fill="#3a4552"/>
        <circle cx="138" cy="34" r="4" class="cec-cyc" data-c="heat" fill="#3a4552"/>
        <circle cx="156" cy="34" r="4" class="cec-cyc" data-c="ready" fill="#3a4552"/>
      </g>
      <!-- porta flat -->
      <rect x="26" y="50" width="148" height="174" rx="10" fill="url(#lv-door)" stroke="#c2cbd4" stroke-width="1"/>
      <rect x="26" y="50" width="148" height="174" rx="10" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1"/>
      <!-- maniglia incassata -->
      <rect x="40" y="58" width="120" height="10" rx="5" fill="#dfe6ec" stroke="#bfc9d2"/>
      <!-- vapore dal bordo superiore quando in funzione -->
      <g class="cec-steam" data-role="steam">
        ${[60, 100, 140].map((x, i) => `<path class="cec-vapor v${i}" d="M${x},58 q6,-10 0,-20 q-6,-10 0,-20" stroke="rgba(200,230,255,.6)" stroke-width="3" fill="none" stroke-linecap="round"/>`).join("")}
      </g>
      <!-- fascio luce a pavimento (alcuni modelli lo proiettano quando in funzione) -->
      <ellipse cx="100" cy="228" rx="46" ry="7" fill="url(#lv-glow)" class="cec-floorbeam" data-role="floorbeam"/>
      <!-- zoccolo -->
      <rect x="30" y="230" width="140" height="8" rx="3" fill="#c2cbd4"/>
    </svg>`;
  }

  _svgForno() {
    return `
    <svg viewBox="0 0 200 250" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="fo-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#3a3f47"/><stop offset="0.5" stop-color="#2b2f36"/><stop offset="1" stop-color="#1c1f24"/>
        </linearGradient>
        <radialGradient id="fo-glow" cx="0.5" cy="0.6" r="0.7">
          <stop offset="0" stop-color="#ffb020"/><stop offset="0.55" stop-color="#a3320f"/><stop offset="1" stop-color="#180a05"/>
        </radialGradient>
      </defs>
      <rect x="20" y="14" width="160" height="216" rx="12" fill="url(#fo-body)" stroke="#111316" stroke-width="1.5"/>
      <!-- cornice inox (bordo incasso) -->
      <rect x="20" y="14" width="160" height="216" rx="12" fill="none" stroke="rgba(200,210,220,.35)" stroke-width="1"/>
      <!-- pannello comandi -->
      <rect x="30" y="22" width="140" height="30" rx="6" fill="#15171b" stroke="#0a0b0d"/>
      <rect x="38" y="30" width="50" height="16" rx="3" fill="#0a0d10"/>
      <text x="63" y="42" text-anchor="middle" font-family="monospace" font-size="11" fill="#ff8a3d" data-role="disp">--:--</text>
      <circle cx="145" cy="37" r="10" fill="#2c3138" stroke="#484f58" stroke-width="1.5"/>
      <path d="M145,37 m-7,0 a7,7 0 0 1 7,-7" stroke="#8fd6ff" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M145,37 m7,0 a7,7 0 0 1 -3.5,6" stroke="#ff8a3d" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- porta con finestrella -->
      <rect x="28" y="60" width="144" height="158" rx="8" fill="#26292f" stroke="#111316"/>
      <rect x="38" y="70" width="124" height="100" rx="6" fill="#0c0d0f" stroke="#000"/>
      <rect x="38" y="70" width="124" height="100" rx="6" fill="url(#fo-glow)" class="cec-oven-glow" data-role="glow" opacity="0"/>
      <!-- griglie interne -->
      <g stroke="rgba(255,255,255,.10)" stroke-width="1.4">
        <line x1="44" y1="100" x2="156" y2="100"/><line x1="44" y1="130" x2="156" y2="130"/><line x1="44" y1="150" x2="156" y2="150"/>
      </g>
      <!-- calore che sale -->
      <g class="cec-heatwave" data-role="heat">
        ${[60, 100, 140].map((x, i) => `<path class="cec-vapor v${i}" d="M${x},130 q8,-14 0,-28 q-8,-14 0,-28" stroke="rgba(255,190,120,.55)" stroke-width="3" fill="none" stroke-linecap="round"/>`).join("")}
      </g>
      <!-- riflesso sul vetro -->
      <path d="M46,72 L70,72 L52,166 L44,166 Z" fill="rgba(255,255,255,.06)"/>
      <!-- maniglia a tutta larghezza (tipico incasso) -->
      <rect x="30" y="182" width="140" height="9" rx="4.5" fill="#5a616b" stroke="#2c3138"/>
      <rect x="30" y="182" width="140" height="3" rx="1.5" fill="rgba(255,255,255,.18)"/>
      <!-- sfiato -->
      <g stroke="#484f58" stroke-width="2"><line x1="70" y1="18" x2="130" y2="18"/></g>
      <!-- piedini -->
      <rect x="34" y="230" width="10" height="6" rx="2" fill="#111316"/><rect x="156" y="230" width="10" height="6" rx="2" fill="#111316"/>
    </svg>`;
  }

  // Frigorifero a 2 ante — combi classico europeo: piccolo vano freezer sopra,
  // grande vano frigo sotto, giunto/cerniera visibile a metà, maniglie vicine
  // al giunto (come nei frigo reali, es. Haier 2 porte).
  _svgFrigo2Ante() {
    const accent = "#47b5ff";
    const seamY = 95; // 10..95 = sportello superiore (freezer), 95..260 = sportello inferiore (frigo)
    return `
    <svg viewBox="0 0 170 270" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="fr-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#eef4fa"/><stop offset="1" stop-color="#ccd5de"/>
        </linearGradient>
        <linearGradient id="fr-doortop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fdfeff"/><stop offset="1" stop-color="#dde5ec"/>
        </linearGradient>
        <linearGradient id="fr-doorbot" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f6fafd"/><stop offset="1" stop-color="#ccd6de"/>
        </linearGradient>
        <radialGradient id="fr-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="${accent}" stop-opacity=".55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <!-- corpo esterno -->
      <rect x="14" y="8" width="142" height="254" rx="14" fill="url(#fr-body)" stroke="#b9c4cf" stroke-width="1.5"/>
      <!-- sportello superiore: freezer -->
      <rect x="21" y="14" width="128" height="${seamY - 14 - 4}" rx="9" fill="url(#fr-doortop)" stroke="#c2cbd4"/>
      <!-- display temperatura incassato nel freezer -->
      <rect x="30" y="20" width="58" height="17" rx="5" fill="#0f1720"/>
      <text x="59" y="33" text-anchor="middle" font-family="monospace" font-size="10" fill="${accent}" data-role="disp">--°</text>
      <text x="132" y="33" text-anchor="middle" font-size="14">❄️</text>
      <!-- maniglia freezer: vicina al giunto -->
      <rect x="30" y="${seamY - 16}" width="110" height="7" rx="3.5" fill="#dfe6ec" stroke="#bfc9d2"/>
      <!-- giunto tra le due ante -->
      <rect x="14" y="${seamY - 3}" width="142" height="6" fill="#aab6c1"/>
      <rect x="14" y="${seamY - 1}" width="142" height="1.5" fill="#8b98a6" opacity=".6"/>
      <!-- sportello inferiore: frigo -->
      <rect x="21" y="${seamY + 3}" width="128" height="${256 - seamY}" rx="9" fill="url(#fr-doorbot)" stroke="#c2cbd4"/>
      <!-- maniglia frigo: vicina al giunto -->
      <rect x="30" y="${seamY + 10}" width="110" height="7" rx="3.5" fill="#dfe6ec" stroke="#bfc9d2"/>
      <!-- riflesso leggero sull'anta grande -->
      <rect x="30" y="${seamY + 26}" width="35" height="${256 - seamY - 40}" rx="6" fill="rgba(255,255,255,.35)"/>
      <!-- vano/griglia compressore in basso -->
      <rect x="28" y="240" width="114" height="10" rx="4" fill="#c9d3dc" stroke="#b3bfc9"/>
      <g stroke="#8b98a6" stroke-width="1.4"><line x1="36" y1="245" x2="134" y2="245"/></g>
      <ellipse cx="85" cy="245" rx="62" ry="18" fill="url(#fr-glow)" class="cec-compglow" data-role="compglow" opacity="0"/>
    </svg>`;
  }

  // Congelatore verticale — sportello unico, brina nella parte bassa.
  _svgCongelatore() {
    const accent = "#8fd6ff";
    return `
    <svg viewBox="0 0 170 270" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="cg-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#f2fbff"/><stop offset="1" stop-color="#d7dee6"/>
        </linearGradient>
        <radialGradient id="cg-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="${accent}" stop-opacity=".55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect x="15" y="10" width="140" height="250" rx="16" fill="url(#cg-body)" stroke="#c2cbd4" stroke-width="1.5"/>
      <rect x="15" y="10" width="140" height="250" rx="16" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1" opacity=".6"/>
      <rect x="28" y="22" width="70" height="20" rx="6" fill="#0f1720"/>
      <text x="63" y="37" text-anchor="middle" font-family="monospace" font-size="11" fill="${accent}" data-role="disp">--°</text>
      <text x="122" y="37" text-anchor="middle" font-size="16">❄️</text>
      <rect x="122" y="60" width="9" height="150" rx="4.5" fill="#dfe6ec" stroke="#bfc9d2"/>
      <line x1="15" y1="250" x2="155" y2="250" stroke="#c2cbd4" stroke-width="1.5"/>
      <!-- brina: puntini/striature nella parte bassa -->
      <g opacity=".55">
        ${Array.from({ length: 14 }).map((_, i) => {
          const x = 26 + (i % 7) * 16 + (Math.floor(i / 7) * 6);
          const y = 190 + Math.floor(i / 7) * 22;
          return `<circle cx="${x}" cy="${y}" r="${1.4 + (i % 3) * 0.5}" fill="#ffffff"/>`;
        }).join("")}
      </g>
      <rect x="30" y="235" width="110" height="10" rx="4" fill="#c9d3dc" stroke="#b3bfc9"/>
      <g stroke="#8b98a6" stroke-width="1.4"><line x1="38" y1="240" x2="132" y2="240"/></g>
      <ellipse cx="85" cy="240" rx="60" ry="18" fill="url(#cg-glow)" class="cec-compglow" data-role="compglow" opacity="0"/>
    </svg>`;
  }

  _build() {
    this.innerHTML = `
    <style>
      .cec{--cec-panel:rgba(30,38,48,.72);--cec-stroke:rgba(255,255,255,.09);--cec-ink:#eaf1f8;--cec-muted:#93a1b0;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--cec-ink);padding:6px;
        height:100%;display:flex;flex-direction:column}
      .cec *{box-sizing:border-box}
      .cec-machine{background:var(--cec-panel);border:1px solid var(--cec-stroke);border-radius:22px;padding:16px 14px;
        flex:1;
        display:flex;flex-direction:column;align-items:center;gap:6px;backdrop-filter:blur(14px);
        box-shadow:0 10px 26px rgba(0,0,0,.35);position:relative;overflow:hidden;transition:background-color .6s ease,border-color .6s ease}
      .cec-machine::before{content:"";position:absolute;inset:0;border-radius:22px;pointer-events:none;
        background:radial-gradient(120% 60% at 50% -10%,rgba(255,255,255,.06),transparent 60%)}
      .cec-glass-wrap{position:relative;width:100%;max-width:190px;cursor:pointer}
      .cec-svg{width:100%;height:auto;display:block;filter:drop-shadow(0 6px 10px rgba(0,0,0,.35))}
      .cec-name{font-size:16px;font-weight:800;margin-top:4px}
      .cec-plugbadge{display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;margin-top:5px;
        font-size:10.5px;font-weight:800;letter-spacing:.3px;background:rgba(255,255,255,.06);border:1px solid var(--cec-stroke);
        color:var(--cec-muted);cursor:pointer;transition:transform .12s,filter .15s}
      .cec-plugbadge:hover{transform:translateY(-1px);filter:brightness(1.15)}
      .cec-plugbadge .dot{width:7px;height:7px;border-radius:50%;background:#5a6572;flex:0 0 auto}
      .cec-plugbadge[data-plug="on"]{background:rgba(56,224,138,.16);border-color:rgba(56,224,138,.45);color:#8ff0b4;
        animation:cec-plug-blink 3s ease-in-out infinite}
      .cec-plugbadge[data-plug="on"] .dot{background:#38e08a;box-shadow:0 0 6px #38e08a}
      .cec-plugbadge[data-plug="off"]{background:rgba(255,84,66,.10);border-color:rgba(255,84,66,.3);color:#ffb0a3}
      .cec-plugbadge[data-plug="off"] .dot{background:#ff5442}
      @keyframes cec-plug-blink{0%,100%{opacity:1}50%{opacity:.55}}
      .cec-machine.plug-on{background-color:rgba(56,224,138,.09);border-color:rgba(56,224,138,.28)}
      .cec-state{font-size:12.5px;font-weight:700;color:var(--cec-muted);transition:color .3s}
      .cec-machine[data-phase="wash"] .cec-state,.cec-machine[data-phase="cool"] .cec-state{color:#47b5ff}
      .cec-machine[data-phase="heat"] .cec-state,.cec-machine[data-phase="preheat"] .cec-state,.cec-machine[data-phase="cook"] .cec-state{color:#ff8a3d}
      .cec-metrics{display:flex;gap:14px;margin-top:2px}
      .cec-metric{font-size:22px;font-weight:850;font-variant-numeric:tabular-nums;line-height:1}
      .cec-metric small{font-size:10px;color:var(--cec-muted);font-weight:700;margin-left:2px}
      .cec-lastcycle{font-size:11.5px;color:var(--cec-muted);text-align:center;line-height:1.4;margin-top:4px}
      .cec-lastcycle b{color:var(--cec-ink);font-weight:800}
      .cec-lastcycle .eur{color:#ffb020;font-weight:800}
      .cec-actions{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:10px}
      .cec-btn{background:rgba(255,255,255,.06);border:1px solid var(--cec-stroke);color:var(--cec-ink);
        border-radius:12px;padding:10px 14px;font-size:13px;font-weight:700;cursor:pointer;width:100%;transition:filter .15s}
      .cec-btn:hover{filter:brightness(1.25)}
      /* animazioni lavastoviglie */
      .cec-steam,.cec-floorbeam{opacity:0;transition:opacity .5s}
      .cec-machine.running .cec-steam,.cec-machine.running .cec-floorbeam{opacity:1}
      .cec-vapor{opacity:0}
      .cec-machine.running .cec-vapor{animation:cec-vapor 2.6s ease-in-out infinite}
      .cec-machine.running .cec-vapor.v1{animation-delay:.6s}.cec-machine.running .cec-vapor.v2{animation-delay:1.2s}
      @keyframes cec-vapor{0%{opacity:0;transform:translateY(6px) scale(.9)}40%{opacity:.7}100%{opacity:0;transform:translateY(-16px) scale(1.1)}}
      .cec-cyc{transition:fill .3s}
      .cec-machine[data-phase="wash"] .cec-cyc[data-c="wash"]{fill:#47b5ff}
      .cec-machine[data-phase="heat"] .cec-cyc[data-c="heat"]{fill:#ff5442}
      .cec-machine[data-phase="off"] .cec-cyc[data-c="ready"]{fill:#38e08a}
      /* forno */
      .cec-oven-glow{transition:opacity .6s}
      .cec-machine.running .cec-oven-glow{opacity:.85}
      .cec-machine[data-phase="preheat"] .cec-oven-glow{opacity:1}
      .cec-heatwave{opacity:0;transition:opacity .5s}
      .cec-machine.running .cec-heatwave{opacity:1}
      /* frigo/congelatore */
      .cec-compglow{transition:opacity .6s}
      .cec-machine.running .cec-compglow{opacity:1;animation:cec-comp-pulse 2.4s ease-in-out infinite}
      @keyframes cec-comp-pulse{0%,100%{opacity:.5}50%{opacity:1}}
      .cec-scrim{position:fixed;inset:0;background:rgba(4,5,8,.62);backdrop-filter:blur(6px);display:flex;
        align-items:center;justify-content:center;padding:22px;z-index:9;opacity:0;pointer-events:none;transition:opacity .18s}
      .cec-scrim.on{opacity:1;pointer-events:auto}
      .cec-modal{width:100%;max-width:380px;max-height:80vh;overflow-y:auto;background:#1a1b21;border:1px solid rgba(255,255,255,.16);
        border-radius:24px;padding:20px 18px;box-shadow:0 24px 60px rgba(0,0,0,.6);transform:translateY(14px) scale(.97);transition:transform .2s}
      .cec-scrim.on .cec-modal{transform:none}
      .cec-mh{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
      .cec-mt{font-size:17px;font-weight:850}
      .cec-x{width:30px;height:30px;border-radius:50%;border:1px solid var(--cec-stroke);background:rgba(255,255,255,.05);color:var(--cec-ink);font-size:15px;cursor:pointer;flex:0 0 auto}
      .cec-tabs{display:flex;gap:8px;margin-bottom:12px}
      .cec-tab{flex:1;text-align:center;padding:8px;border-radius:10px;font-size:12px;font-weight:800;cursor:pointer;
        background:rgba(255,255,255,.05);border:1px solid var(--cec-stroke);color:var(--cec-muted)}
      .cec-tab.sel{background:linear-gradient(135deg,rgba(71,181,255,.25),rgba(71,181,255,.12));color:var(--cec-ink);border-color:transparent}
      .cec-mchart{display:flex;align-items:flex-end;gap:3px;height:80px;margin-bottom:16px}
      .cec-mcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:3px}
      .cec-mbar{width:100%;max-width:14px;border-radius:3px 3px 1px 1px;min-height:2px;background:linear-gradient(180deg,#47b5ff,#2a86c9)}
      .cec-mhl{font-size:7.5px;color:var(--cec-muted);font-weight:700}
      .cec-clist{display:flex;flex-direction:column;gap:8px}
      .cec-crow{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;
        background:rgba(255,255,255,.04);border-radius:12px;border:1px solid var(--cec-stroke)}
      .cec-crow .cd{font-size:12.5px;font-weight:700}
      .cec-crow .ch{font-size:10.5px;color:var(--cec-muted);margin-top:1px}
      .cec-crow .cv{text-align:right;font-size:13px;font-weight:850;font-variant-numeric:tabular-nums}
      .cec-crow .cv small{display:block;font-size:10px;color:#ffb020;font-weight:700}
      .cec-empty{color:var(--cec-muted);font-size:13px;text-align:center;padding:20px 0}
      .cec-avgrow{display:flex;justify-content:space-between;padding:12px 14px;background:rgba(255,255,255,.04);
        border-radius:12px;border:1px solid var(--cec-stroke);margin-bottom:8px;font-size:13px;font-weight:700}
      .cec-avgrow small{display:block;color:var(--cec-muted);font-weight:600;font-size:10.5px;margin-top:2px}
      @media(prefers-reduced-motion:reduce){.cec *{animation:none!important}}
    </style>
    <div class="cec">
      <div class="cec-machine" data-kind="${this._cfg.kind}">
        <div class="cec-glass-wrap" data-role="tap">${this._visual()}</div>
        <div class="cec-name">${this._esc(this._cfg.name)}</div>
        <div class="cec-plugbadge" data-role="plugbadge" hidden><span class="dot"></span><span class="lbl">—</span></div>
        <div class="cec-state" data-role="state">—</div>
        <div class="cec-metrics"><div class="cec-metric"><span data-role="power">–</span><small>W</small></div></div>
        <div class="cec-lastcycle" data-role="lastcycle" hidden></div>
        <div class="cec-actions"><button class="cec-btn" data-role="histbtn">📜 Storico e costi</button></div>
      </div>
    </div>`;
    stopSwipeNavHijack(this.querySelector(".cec"));
    this._el = this.querySelector(".cec-machine");
    this.querySelector('[data-role="tap"]').onclick = () => this._openHistory();
    this.querySelector('[data-role="histbtn"]').onclick = () => this._openHistory();
    const badge = this.querySelector('[data-role="plugbadge"]');
    badge.onclick = e => { e.stopPropagation(); this._togglePower(); };
  }

  _togglePower() {
    if (this._cfg.switch && this._hass.states[this._cfg.switch]) {
      this._hass.callService("switch", "toggle", { entity_id: this._cfg.switch });
    }
  }

  _update() {
    if (!this._el) return;
    const p = this._num(this._cfg.power);
    const soglia = parseFloat(this._cfg.soglia) || 10;
    const wasRunning = this._el.classList.contains("running");
    const nowRunning = p != null && p > soglia;
    if (this._cfg.kind === "forno") {
      if (nowRunning && !wasRunning) this._runSince = Date.now();
      if (!nowRunning) this._runSince = null;
    }
    const phase = classifyPhase(this._cfg.kind, p, this._cfg, this._runSince);
    const running = phase.key !== "off";
    this._el.classList.toggle("running", running);
    this._el.dataset.phase = phase.key;
    this._el.querySelector('[data-role="state"]').textContent = phase.label;
    this._el.querySelector('[data-role="power"]').textContent = p != null ? Math.round(p) : "–";
    const sw = this._cfg.switch && this._hass.states[this._cfg.switch];
    const badge = this._el.querySelector('[data-role="plugbadge"]');
    if (sw) {
      badge.hidden = false;
      const plugOn = sw.state === "on";
      badge.dataset.plug = plugOn ? "on" : "off";
      badge.querySelector(".lbl").textContent = plugOn ? "Presa accesa" : "Presa spenta";
      this._el.classList.toggle("plug-on", plugOn);
    } else { badge.hidden = true; this._el.classList.remove("plug-on"); }
    const disp = this._el.querySelector('[data-role="disp"]');
    if (disp) {
      if (sw && sw.state !== "on") disp.textContent = "SPENTA";
      else if (!running) disp.textContent = CONTINUOUS[this._cfg.kind] ? "A RIPOSO" : "PRONTA";
      else disp.textContent = dispLabelFor(phase.key);
    }
    const lc = this._el.querySelector('[data-role="lastcycle"]');
    const hist = this._hist;
    if (SHOW_CYCLES[this._cfg.kind] && hist && hist.cycles && hist.cycles.length) {
      const last = running ? hist.cycles.find(c => !this._isOngoing(c)) : hist.cycles[0];
      if (last) {
        lc.hidden = false;
        lc.innerHTML = `Ultimo ciclo: <b>~${last.hours}h</b> · <b>${this._fmt(last.kwh)} kWh</b> · <span class="eur">${this._fmtE(last.kwh)}</span>`;
      } else lc.hidden = true;
    } else lc.hidden = true;
  }

  _openHistory() {
    const hist = this._hist, cfg = this._cfg, continuous = CONTINUOUS[cfg.kind];
    let ov = this.querySelector(".cec-scrim");
    if (!ov) { ov = document.createElement("div"); ov.className = "cec-scrim"; this.querySelector(".cec").appendChild(ov); }
    if (!cfg.energy) {
      ov.innerHTML = `<div class="cec-modal"><div class="cec-mh"><div class="cec-mt">${this._esc(cfg.name)}</div><button class="cec-x">✕</button></div>
        <div class="cec-empty">Configura un sensore di energia (nell'editor della card) per vedere storico e grafico.</div></div>`;
      requestAnimationFrame(() => ov.classList.add("on"));
      ov.querySelector(".cec-x").onclick = () => ov.classList.remove("on");
      ov.onclick = e => { if (e.target === ov) ov.classList.remove("on"); };
      return;
    }
    let period = "7";
    const render = () => {
      const daily = (hist && hist.daily) || {};
      const days = parseInt(period);
      const today = new Date();
      const bars = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        bars.push({ label: this._dlabel(d), v: daily[this._dkey(d)] || 0 });
      }
      const mx = Math.max(...bars.map(b => b.v), 0.05);
      const totKwh = bars.reduce((a, b) => a + b.v, 0);
      const avgDay = totKwh / days;
      const chartHTML = bars.map((b, i) => {
        const hp = Math.max(2, Math.round(b.v / mx * 100));
        const showLbl = days <= 7 || i % Math.ceil(days / 7) === 0;
        return `<div class="cec-mcol"><div class="cec-mbar" style="height:${hp}%"></div>
          <div class="cec-mhl">${showLbl ? b.label.split(" ")[1] : ""}</div></div>`;
      }).join("");
      let bottomHTML;
      if (continuous) {
        bottomHTML = `<div class="cec-avgrow"><div>Media al giorno<small>stima su ${days} giorni</small></div>
          <div style="text-align:right">${this._fmt(avgDay)} kWh<small>${this._fmtE(avgDay)}/giorno</small></div></div>
          <div class="cec-empty" style="padding:6px 0 0">Funziona in continuo: qui vedi il consumo, non un elenco di cicli.</div>`;
      } else {
        const cycles = (hist && hist.cycles) || [];
        bottomHTML = `<div style="font-size:12px;font-weight:800;margin-bottom:8px;color:var(--cec-ink)">📜 Cicli recenti</div>
          <div class="cec-clist">${cycles.length ? cycles.slice(0, 10).map(c => `
            <div class="cec-crow"><div><div class="cd">${this._dlabel(c.start)}, ${String(c.start.getHours()).padStart(2, "0")}:00</div>
              <div class="ch">durata ~${c.hours}h</div></div>
              <div class="cv">${this._fmt(c.kwh)} kWh<small>${this._fmtE(c.kwh)}</small></div></div>`).join("")
            : `<div class="cec-empty">Nessun ciclo rilevato negli ultimi ${cfg.storico_giorni} giorni.</div>`}</div>`;
      }
      ov.innerHTML = `<div class="cec-modal">
        <div class="cec-mh"><div><div class="cec-mt">${this._esc(cfg.name)}</div>
          <div style="font-size:11.5px;color:var(--cec-muted);margin-top:2px">${this._fmt(totKwh)} kWh negli ultimi ${days} giorni · ${this._fmtE(totKwh)}</div></div>
          <button class="cec-x">✕</button></div>
        <div class="cec-tabs">
          <div class="cec-tab${period === "7" ? " sel" : ""}" data-p="7">7 giorni</div>
          <div class="cec-tab${period === "30" ? " sel" : ""}" data-p="30">30 giorni</div>
        </div>
        <div class="cec-mchart">${chartHTML}</div>
        ${bottomHTML}
      </div>`;
      ov.querySelector(".cec-x").onclick = () => ov.classList.remove("on");
      ov.querySelectorAll(".cec-tab").forEach(t => t.onclick = () => { period = t.dataset.p; render(); });
    };
    render();
    requestAnimationFrame(() => ov.classList.add("on"));
    ov.onclick = e => { if (e.target === ov) ov.classList.remove("on"); };
  }
}
customElements.define("centro-elettrodomestici-card", CentroElettrodomesticiCard);

// ===========================================================================
// Editor
// ===========================================================================
class CentroElettrodomesticiCardEditor extends HTMLElement {
  setConfig(config) {
    const kind = CEC_DEFAULTS[config && config.kind] ? config.kind : "lavastoviglie";
    this._config = Object.assign({}, CEC_DEFAULTS[kind], config || {}, { kind });
    this._render();
  }
  // NB: HA non garantisce l'ordine hass/setConfig — se hass arriva prima, non c'è
  // ancora una config da disegnare: aspettiamo che setConfig() faccia il primo render.
  set hass(h) { this._hass = h; if (h && this._config) this._render(); }

  _emit() { this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })); }
  _set(key, val) { this._config = Object.assign({}, this._config, { [key]: val }); this._emit(); }

  _opts(domainPrefixes, sel) {
    const hs = this._hass ? this._hass.states : {};
    const ids = Object.keys(hs).filter(id => domainPrefixes.some(p => id.startsWith(p))).sort();
    let out = `<option value=""${!sel ? " selected" : ""}>— nessuno —</option>`;
    for (const id of ids) {
      const fn = (hs[id].attributes && hs[id].attributes.friendly_name) || id;
      out += `<option value="${id}"${id === sel ? " selected" : ""}>${fn}</option>`;
    }
    if (sel && !ids.includes(sel)) out += `<option value="${sel}" selected>${sel}</option>`;
    return out;
  }

  _render() {
    if (!this._config) return;
    const c = this._config;
    this.innerHTML = `<style>
      .cee{display:flex;flex-direction:column;gap:14px;padding:6px 2px;font-family:inherit}
      .cee .fld{display:flex;flex-direction:column;gap:6px;margin-top:8px}
      .cee label{font-size:13px;font-weight:600;color:var(--primary-text-color)}
      .cee .h{font-size:11px;color:var(--secondary-text-color)}
      .cee input,.cee select{padding:10px 11px;border-radius:8px;font-size:15px;font-family:inherit;
        border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color)}
      .cee .row{display:flex;gap:12px}.cee .row>.fld{flex:1}
      .cee .note{font-size:11.5px;color:var(--secondary-text-color);line-height:1.5;margin-top:4px}
    </style>
    <div class="cee">
      <div class="fld"><label>Tipo elettrodomestico</label>
        <select id="f_kind">
          <option value="lavastoviglie"${c.kind === "lavastoviglie" ? " selected" : ""}>🍽️ Lavastoviglie</option>
          <option value="forno"${c.kind === "forno" ? " selected" : ""}>🔥 Forno</option>
          <option value="frigorifero"${c.kind === "frigorifero" ? " selected" : ""}>❄️ Frigorifero</option>
          <option value="congelatore"${c.kind === "congelatore" ? " selected" : ""}>🧊 Congelatore</option>
        </select></div>
      <div class="fld"><label>Nome</label><input type="text" id="f_name" value="${(c.name || "").replace(/"/g, "&quot;")}"></div>
      <div class="fld"><label>Sensore potenza (W)</label><select id="f_power">${this._opts(["sensor."], c.power)}</select></div>
      <div class="fld"><label>Sensore energia (kWh) — per storico/costo</label><select id="f_energy">${this._opts(["sensor."], c.energy)}</select></div>
      <div class="fld"><label>Presa/interruttore — opzionale</label><select id="f_switch">${this._opts(["switch.", "input_boolean."], c.switch)}</select></div>
      <div class="fld"><label>Soglia "in funzione" (W)</label><input type="number" min="1" max="500" id="f_soglia" value="${c.soglia || 10}"></div>
      ${c.kind === "lavastoviglie" ? `
      <div class="fld"><label>Soglia riscaldamento (W)</label><span class="h">0 = disattiva</span>
        <input type="number" min="0" max="3000" id="f_sr" value="${c.soglia_riscaldamento || 0}"></div>` : ""}
      ${c.kind === "forno" ? `
      <div class="fld"><label>Minuti di preriscaldo stimati</label><span class="h">sotto questo tempo dall'accensione mostra "Preriscaldo"</span>
        <input type="number" min="1" max="60" id="f_preheat" value="${c.preriscaldo_min || 10}"></div>` : ""}
      <div class="row">
        <div class="fld"><label>Prezzo energia (€/kWh)</label>
          <input type="number" step="0.01" min="0" max="5" id="f_price" value="${c.prezzo_kwh}"></div>
        <div class="fld"><label>Storico (giorni)</label>
          <select id="f_days"><option value="7"${c.storico_giorni == 7 ? " selected" : ""}>7 giorni</option>
            <option value="14"${c.storico_giorni == 14 ? " selected" : ""}>14 giorni</option>
            <option value="30"${c.storico_giorni == 30 ? " selected" : ""}>30 giorni</option></select></div>
      </div>
      <div class="fld"><label>Foto (URL) — opzionale</label>
        <span class="h">Incolla il link di una foto vera del tuo elettrodomestico per usarla al posto del disegno</span>
        <input type="text" id="f_photo" placeholder="https://..." value="${(c.photo_url || "").replace(/"/g, "&quot;")}"></div>
      <div class="note">💡 Le soglie sono una STIMA dal consumo istantaneo (non leggono il programma reale). Frigorifero e congelatore mostrano solo il grafico consumi (funzionano in continuo, non a cicli).</div>
    </div>`;
    const on = (id, ev, fn) => { const el = this.querySelector(id); if (el) el.addEventListener(ev, fn); };
    on("#f_kind", "change", e => this._set("kind", e.target.value));
    on("#f_name", "input", e => this._set("name", e.target.value));
    on("#f_power", "change", e => this._set("power", e.target.value));
    on("#f_energy", "change", e => this._set("energy", e.target.value));
    on("#f_switch", "change", e => this._set("switch", e.target.value));
    on("#f_soglia", "change", e => this._set("soglia", parseInt(e.target.value) || 10));
    on("#f_sr", "change", e => this._set("soglia_riscaldamento", parseInt(e.target.value) || 0));
    on("#f_preheat", "change", e => this._set("preriscaldo_min", parseInt(e.target.value) || 10));
    on("#f_price", "change", e => this._set("prezzo_kwh", parseFloat(String(e.target.value).replace(",", ".")) || 0.30));
    on("#f_days", "change", e => this._set("storico_giorni", parseInt(e.target.value) || 14));
    on("#f_photo", "change", e => this._set("photo_url", e.target.value.trim()));
  }
}
customElements.define("centro-elettrodomestici-card-editor", CentroElettrodomesticiCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "centro-elettrodomestici-card",
  name: "Centro Elettrodomestici Card",
  description: "Card indipendente per lavastoviglie, forno, frigorifero o congelatore: fase dal consumo, storico e costo.",
  preview: true,
  documentationURL: "https://github.com/cristianwebonline/ha-centro-elettrodomestici-card",
});
