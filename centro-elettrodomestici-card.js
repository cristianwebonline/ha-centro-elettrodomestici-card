/*! Centro Elettrodomestici Card — card indipendente per lavastoviglie, forno,
 *  frigorifero o congelatore. Grafica realistica (SVG) diversa per tipo,
 *  rilevamento fase dal consumo, storico cicli e costo (per lavastoviglie/forno,
 *  che si usano a sessioni) oppure grafico consumo continuo (per frigo/congelatore,
 *  che girano sempre). Gira nel browser, indipendente dal server esterno.
 */
const CEC_VERSION = "2.2.0";
console.info(`%c CENTRO-ELETTRODOMESTICI-CARD %c v${CEC_VERSION} `,
  "color:#2b1a06;background:#ffb020;font-weight:700;border-radius:4px 0 0 4px",
  "color:#fff0d6;background:#1a1b21;border-radius:0 4px 4px 0");

const WD = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
// lavastoviglie/forno/piano_induzione = uso a sessioni (mostra storico cicli);
// frigo/congelatore = funzionamento continuo (compressore che cicla tutto il
// giorno: la lista cicli non avrebbe senso, meglio solo il grafico consumo).
const SHOW_CYCLES = { lavastoviglie: true, forno: true, piano_induzione: true, frigorifero: false, congelatore: false };
const CONTINUOUS = { frigorifero: true, congelatore: true };

const CEC_DEFAULTS = {
  lavastoviglie: { kind: "lavastoviglie", name: "Lavastoviglie", power: "sensor.shelly_lavastoviglie_power",
    energy: "sensor.shelly_lavastoviglie_energy", switch: "switch.shelly_lavastoviglie",
    soglia: 10, soglia_riscaldamento: 1200, prezzo_kwh: 0.30, storico_giorni: 14 },
  forno: { kind: "forno", name: "Forno", power: "sensor.presa_forno_power",
    energy: "sensor.presa_forno_energy", switch: "switch.presa_forno",
    soglia: 15, preriscaldo_min: 10, prezzo_kwh: 0.30, storico_giorni: 14 },
  piano_induzione: { kind: "piano_induzione", name: "Piano induzione", power: "sensor.cucina_induzione_potenza",
    energy: "sensor.cucina_induzione_energia", switch: "switch.cucina_induzione",
    soglia: 15, prezzo_kwh: 0.30, storico_giorni: 14 },
  frigorifero: { kind: "frigorifero", name: "Frigorifero", power: "sensor.frigo_power",
    energy: "sensor.frigo_energy", switch: "switch.frigo_outlet",
    soglia: 15, prezzo_kwh: 0.30, storico_giorni: 14 },
  congelatore: { kind: "congelatore", name: "Congelatore", power: "sensor.congelatore_potenza",
    energy: "sensor.congelatore_energia_kwh", switch: "switch.congelatore_presa_1",
    soglia: 15, prezzo_kwh: 0.30, storico_giorni: 14 },
  stanza: { kind: "stanza", name: "Stanza", icon_type: "generic",
    power: "", energy: "", switch: "", temp: "", humidity: "",
    soglia: 10, soglia_freddo: 18, soglia_caldo: 26, prezzo_kwh: 0.30, storico_giorni: 14 },
};
// "Stanza" (generico, non un elettrodomestico a cicli/compressore): usa la vista
// grafico+media invece della lista cicli, ma NON deve mai perdere il comando
// on/off — quel blocco è una sicurezza specifica per frigo/congelatore, non va
// esteso qui. Vedi uso separato più sotto (CHART_VIEW vs CONTINUOUS).
const CHART_VIEW = Object.assign({}, CONTINUOUS, { stanza: true });

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
  if (kind === "piano_induzione") return { key: "cook", label: "In uso" };
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

  getCardSize() { return 8; }
  // Dashboard "sections": dichiara che la card è ridimensionabile — HA mostra la
  // scheda "Layout" nell'editor con le maniglie per allungarla/accorciarla.
  getLayoutOptions() {
    return { grid_rows: 8, grid_columns: 4, grid_min_rows: 4, grid_max_rows: 14, grid_min_columns: 2, grid_max_columns: 6 };
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

  // ---- storico ------------------------------------------------------------
  // Lavastoviglie/forno/piano induzione: dallo storico energia (recorder
  // statistics) — sensori normalmente affidabili per un uso a sessioni.
  // Frigo/congelatore: NON ci fidiamo dei loro contatori "energia totale" —
  // su questo impianto uno è risultato rotto (salti falsi di migliaia di kWh)
  // e l'altro senza storico salvato affatto. Calcoliamo invece i kWh
  // integrando nel tempo il sensore di POTENZA (sempre disponibile e
  // affidabile), che aggira il problema alla radice.
  async _loadHistory() {
    if (!this._hass) { this._hist = null; return; }
    this._histLoading = true;
    const days = parseInt(this._cfg.storico_giorni) || 14;
    const now = new Date();
    const start = new Date(now.getTime() - days * 86400000);
    try {
      if (CHART_VIEW[this._cfg.kind]) {
        if (!this._cfg.power) { this._hist = null; }
        else {
          const res = await this._hass.callWS({
            type: "history/history_during_period",
            start_time: start.toISOString(), end_time: now.toISOString(),
            entity_ids: [this._cfg.power], minimal_response: true, no_attributes: true,
          });
          const rows = (res && res[this._cfg.power]) || [];
          this._hist = { cycles: [], daily: this._integratePower(rows) };
        }
      } else {
        if (!this._cfg.energy) { this._hist = null; }
        else {
          const res = await this._hass.callWS({
            type: "recorder/statistics_during_period",
            start_time: start.toISOString(), end_time: now.toISOString(),
            statistic_ids: [this._cfg.energy], period: "hour", types: ["change"],
          });
          const rows = (res && res[this._cfg.energy]) || [];
          this._hist = this._computeStats(rows);
        }
      }
    } catch (e) {
      this._hist = null;
      console.warn("[centro-elettrodomestici-card] storico non disponibile:", e);
    }
    this._histLoading = false;
    this._histTs = Date.now();
    this._update();
  }

  // Integra P(t)*dt sui campioni raw dello storico potenza → kWh per giorno.
  // Ceiling di sicurezza sui watt e sul gap tra due campioni: un sensore che
  // impazzisce per un istante, o resta offline a lungo, non deve falsare il totale.
  _integratePower(rows) {
    const MAX_W = 2500;
    const MAX_GAP_S = 2 * 3600;
    const norm = r => r.s !== undefined
      ? { t: r.lu * 1000, w: parseFloat(r.s) }
      : { t: new Date(r.last_updated || r.lu).getTime(), w: parseFloat(r.state) };
    const pts = rows.map(norm).filter(p => !isNaN(p.w) && !isNaN(p.t))
      .map(p => ({ t: p.t, w: Math.min(MAX_W, Math.max(0, p.w)) }))
      .sort((a, b) => a.t - b.t);
    const daily = {};
    for (let i = 0; i < pts.length - 1; i++) {
      const dtS = Math.min(MAX_GAP_S, (pts[i + 1].t - pts[i].t) / 1000);
      if (dtS <= 0) continue;
      const kwh = (pts[i].w * dtS) / 3600 / 1000;
      const k = this._dkey(new Date(pts[i].t));
      daily[k] = (daily[k] || 0) + kwh;
    }
    return daily;
  }

  _computeStats(rows) {
    const NOISE = 0.01;
    const CEIL = 5; // kWh in una sola ora: oltre è quasi certo un glitch del sensore
    const GAP_MERGE_H = 1;
    const buckets = rows.map(r => {
      let kwh = (r.change && r.change > 0) ? r.change : 0;
      if (kwh > CEIL) kwh = 0; // scarta il bucket: dato non plausibile
      return { t: new Date(r.start), kwh };
    }).sort((a, b) => a.t - b.t);
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
    if (kind === "piano_induzione") return this._svgPianoInduzione();
    if (kind === "frigorifero") return this._svgFrigoHaier();
    if (kind === "congelatore") return this._svgCongelatoreChest();
    return this._iconStanza();
  }

  // Icone "Stanza": non elettrodomestici a fasi, ma dispositivi/ambienti generici
  // (luce, presa, TV, clima di una stanza). 4 stili curati a mano invece di
  // un'icona mdi piatta — vedi anteprima approvata da Cristian.
  _iconStanza() {
    const t = this._cfg.icon_type;
    if (t === "climate") return this._iconClimate();
    if (t === "livingroom") return this._iconLivingroom();
    if (t === "bedroom") return this._iconBedroom();
    return this._iconGeneric();
  }

  // Termometro: sempre visibile (una stanza non si "spegne"), colore e livello
  // del mercurio legati al sensore di temperatura reale — non decorativo.
  _iconClimate() {
    return `
    <svg viewBox="0 0 100 100" class="cec-svg stz-icon" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="stzThermStem" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#2a3040"/><stop offset=".45" stop-color="#3a4150"/><stop offset="1" stop-color="#232833"/>
        </linearGradient>
        <linearGradient id="stzThermGlass" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity=".4"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="stzMercuryComfy" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ffd166"/></linearGradient>
        <linearGradient id="stzMercuryCold" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2f8fd6"/><stop offset="1" stop-color="#7ecbff"/></linearGradient>
        <linearGradient id="stzMercuryHot" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#e6432b"/><stop offset="1" stop-color="#ff8a63"/></linearGradient>
        <radialGradient id="stzBulbComfy" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffd166"/><stop offset=".55" stop-color="#ff8a3d"/><stop offset="1" stop-color="#e8662a"/></radialGradient>
        <radialGradient id="stzBulbCold" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#bfe4ff"/><stop offset=".55" stop-color="#4aa8e6"/><stop offset="1" stop-color="#2f7fc2"/></radialGradient>
        <radialGradient id="stzBulbHot" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffb199"/><stop offset=".55" stop-color="#ef4b30"/><stop offset="1" stop-color="#c1341e"/></radialGradient>
        <radialGradient id="stzThermGlow" cx="50%" cy="55%" r="52%"><stop offset="0" stop-color="#ff9a4d" stop-opacity=".28"/><stop offset="1" stop-color="#ff9a4d" stop-opacity="0"/></radialGradient>
        <radialGradient id="stzShadow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse data-role="thermglow" cx="50" cy="60" rx="34" ry="30" fill="url(#stzThermGlow)"/>
      <ellipse cx="50" cy="90" rx="19" ry="4.5" fill="url(#stzShadow)"/>
      <rect x="41" y="14" width="18" height="50" rx="9" fill="url(#stzThermStem)" stroke="#4a5261" stroke-width="1.4"/>
      <rect x="43" y="15" width="4" height="46" rx="2" fill="url(#stzThermGlass)"/>
      <circle cx="50" cy="72" r="17" fill="url(#stzThermStem)" stroke="#4a5261" stroke-width="1.4"/>
      <rect data-role="mercury" x="46.3" y="30" width="7.4" height="46" rx="3.7" fill="url(#stzMercuryComfy)"/>
      <circle data-role="bulb" cx="50" cy="72" r="11" fill="url(#stzBulbComfy)"/>
      <ellipse cx="45.5" cy="66.5" rx="3" ry="4.5" fill="#fff" opacity=".35"/>
      <g stroke="#5a6472" stroke-width="1.6" stroke-linecap="round">
        <line x1="61" y1="24" x2="65" y2="24"/><line x1="61" y1="32" x2="68" y2="32"/>
        <line x1="61" y1="40" x2="65" y2="40"/><line x1="61" y1="48" x2="68" y2="48"/><line x1="61" y1="56" x2="65" y2="56"/>
      </g>
    </svg>`;
  }

  // Divano+TV: usato per soggiorno/salotto. Il bagliore e lo schermo si
  // accendono quando il dispositivo collegato (luce/presa/TV) è acceso.
  _iconLivingroom() {
    return `
    <svg viewBox="0 0 100 100" class="cec-svg stz-icon" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="stzSofaBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b6472"/><stop offset=".5" stop-color="#454d5a"/><stop offset="1" stop-color="#343b46"/></linearGradient>
        <linearGradient id="stzSofaArm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5b6472"/><stop offset="1" stop-color="#3a4150"/></linearGradient>
        <linearGradient id="stzSofaCush" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#636c79"/><stop offset="1" stop-color="#454d5a"/></linearGradient>
        <linearGradient id="stzTvBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2e38"/><stop offset="1" stop-color="#12141a"/></linearGradient>
        <radialGradient id="stzScreen" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#8fd6ff"/><stop offset=".55" stop-color="#47b5ff"/><stop offset="1" stop-color="#1e7fd6"/></radialGradient>
        <radialGradient id="stzSofaGlow" cx="50%" cy="55%" r="52%"><stop offset="0" stop-color="#47b5ff" stop-opacity=".28"/><stop offset="1" stop-color="#47b5ff" stop-opacity="0"/></radialGradient>
        <radialGradient id="stzShadow2" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".4"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse class="stz-glow" cx="50" cy="55" rx="42" ry="30" fill="url(#stzSofaGlow)"/>
      <ellipse cx="50" cy="86" rx="35" ry="5" fill="url(#stzShadow2)"/>
      <rect x="30" y="12" width="40" height="27" rx="4" fill="url(#stzTvBody)" stroke="#050608" stroke-width="1.5"/>
      <rect class="stz-screen" x="33.5" y="15.5" width="33" height="20" rx="2" fill="url(#stzScreen)"/>
      <rect class="stz-screen" x="37" y="19" width="18" height="2.6" rx="1.3" fill="#fff" opacity=".55"/>
      <rect class="stz-screen" x="37" y="24" width="24" height="2.6" rx="1.3" fill="#fff" opacity=".35"/>
      <rect x="46" y="39" width="8" height="4" fill="#12141a"/>
      <rect x="38" y="42" width="24" height="3" rx="1.5" fill="#12141a"/>
      <path d="M16 58 a8 8 0 0 1 8 -8 h52 a8 8 0 0 1 8 8 v10 h-68 z" fill="url(#stzSofaBack)"/>
      <rect x="16" y="36" width="13" height="34" rx="6.5" fill="url(#stzSofaArm)"/>
      <rect x="71" y="36" width="13" height="34" rx="6.5" fill="url(#stzSofaArm)"/>
      <rect x="20" y="58" width="60" height="16" rx="7" fill="url(#stzSofaCush)"/>
      <line x1="40" y1="60" x2="40" y2="72" stroke="#343b46" stroke-width="1.3" opacity=".6"/>
      <line x1="60" y1="60" x2="60" y2="72" stroke="#343b46" stroke-width="1.3" opacity=".6"/>
      <rect x="20" y="70" width="60" height="7" rx="3.5" fill="#3a4150"/>
    </svg>`;
  }

  // Presa/dispositivo generico: LED e simbolo lampo si accendono quando è on.
  _iconGeneric() {
    return `
    <svg viewBox="0 0 100 100" class="cec-svg stz-icon" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="stzPlugBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4150"/><stop offset=".5" stop-color="#2a3040"/><stop offset="1" stop-color="#1c212b"/></linearGradient>
        <linearGradient id="stzPlugFace" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5261"/><stop offset="1" stop-color="#333a46"/></linearGradient>
        <radialGradient id="stzLed" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#ffe29a"/><stop offset=".5" stop-color="#ffb020"/><stop offset="1" stop-color="#e6890a"/></radialGradient>
        <radialGradient id="stzPlugGlow" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#ffb020" stop-opacity=".4"/><stop offset="1" stop-color="#ffb020" stop-opacity="0"/></radialGradient>
        <radialGradient id="stzShadow3" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".4"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse class="stz-glow" cx="50" cy="55" rx="30" ry="26" fill="url(#stzPlugGlow)"/>
      <ellipse cx="50" cy="88" rx="21" ry="4.5" fill="url(#stzShadow3)"/>
      <rect x="26" y="16" width="48" height="60" rx="16" fill="url(#stzPlugBody)" stroke="#0f1319" stroke-width="1.5"/>
      <rect x="30" y="19" width="40" height="8" rx="4" fill="#fff" opacity=".08"/>
      <rect x="32" y="22" width="36" height="38" rx="12" fill="url(#stzPlugFace)"/>
      <circle cx="42" cy="35" r="4" fill="#1c212b"/><circle cx="58" cy="35" r="4" fill="#1c212b"/>
      <rect x="45" y="46" width="10" height="12" rx="3" fill="#1c212b"/>
      <circle class="stz-bolt" cx="50" cy="67" r="9" fill="url(#stzLed)"/>
      <path class="stz-bolt" d="M52 61.5 L46.5 68.5 L49.5 68.5 L48 74.5 L54 66.8 L50.8 66.8 Z" fill="#7a4a00"/>
    </svg>`;
  }

  // Letto: usato per camere da letto. Bagliore caldo quando il dispositivo
  // collegato (luce/presa) è acceso.
  _iconBedroom() {
    return `
    <svg viewBox="0 0 100 100" class="cec-svg stz-icon" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="stzBedHead" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6b5643"/><stop offset=".5" stop-color="#4a3b2e"/><stop offset="1" stop-color="#382c22"/></linearGradient>
        <linearGradient id="stzBedFrame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b6472"/><stop offset="1" stop-color="#3a4150"/></linearGradient>
        <radialGradient id="stzPillow" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff"/><stop offset=".6" stop-color="#eef1f5"/><stop offset="1" stop-color="#ccd3db"/></radialGradient>
        <linearGradient id="stzDuvet" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fc9f5"/><stop offset=".5" stop-color="#7dbcf5"/><stop offset="1" stop-color="#5a9de0"/></linearGradient>
        <radialGradient id="stzBedGlow" cx="50%" cy="55%" r="55%"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".3"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient>
        <radialGradient id="stzShadow4" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".4"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse class="stz-glow" cx="50" cy="58" rx="40" ry="28" fill="url(#stzBedGlow)"/>
      <ellipse cx="50" cy="86" rx="37" ry="5" fill="url(#stzShadow4)"/>
      <rect x="15" y="26" width="12" height="46" rx="4" fill="url(#stzBedHead)" stroke="#2b2119" stroke-width="1.3"/>
      <rect x="18" y="30" width="6" height="38" rx="2" fill="#000" opacity=".15"/>
      <rect x="20" y="46" width="62" height="24" rx="7" fill="url(#stzBedFrame)"/>
      <rect x="20" y="46" width="62" height="6" rx="3" fill="#fff" opacity=".12"/>
      <ellipse cx="34" cy="50" rx="13" ry="8.5" fill="url(#stzPillow)"/>
      <path d="M23 50 q11 -5 22 0" stroke="#c7cfd8" stroke-width="1.2" fill="none" opacity=".7"/>
      <rect x="46" y="52" width="34" height="18" rx="7" fill="url(#stzDuvet)"/>
      <path d="M50 58 q14 4 28 0" stroke="#4d7fb8" stroke-width="1.2" fill="none" opacity=".5"/>
      <path d="M50 64 q14 4 28 0" stroke="#4d7fb8" stroke-width="1.2" fill="none" opacity=".35"/>
      <rect x="24" y="70" width="4" height="8" rx="1.5" fill="#2f3542"/>
      <rect x="74" y="70" width="4" height="8" rx="1.5" fill="#2f3542"/>
    </svg>`;
  }

  // Disegni "smart" forniti da Cristian (stile SmartThings/Bespoke, coerente con
  // lavatrice/asciugatrice del Centro Bucato). Display con dati veri dove sensato
  // (lavastoviglie/forno/piano induzione: fase reale, non un timer finto); frigo e
  // congelatore mostrano una temperatura statica decorativa (non tracciamo un
  // sensore di temperatura reale) — lo stato compressore resta leggibile sotto
  // l'immagine (.cec-state), non serve duplicarlo dentro il disegno.

  _svgLavastoviglie() {
    return `
    <svg viewBox="0 0 400 500" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .lv-led{opacity:.3}
          .cec-machine.plug-on .lv-led{animation:lv-led-pulse 2s ease-in-out infinite}
          @keyframes lv-led-pulse{0%,100%{filter:drop-shadow(0 0 2px #38bdf8);opacity:.85}50%{filter:drop-shadow(0 0 6px #38bdf8);opacity:1}}
          .lv-progress{width:0}
          .cec-machine.running .lv-progress{animation:lv-progress-grow 4s linear infinite}
          @keyframes lv-progress-grow{0%{width:0px}100%{width:160px}}
        </style>
        <linearGradient id="lv-steel" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#e4e9ee"/><stop offset="25%" stop-color="#f4f6f8"/>
          <stop offset="50%" stop-color="#ffffff"/><stop offset="75%" stop-color="#f4f6f8"/><stop offset="100%" stop-color="#c9d1d9"/>
        </linearGradient>
        <linearGradient id="lv-panel" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/>
        </linearGradient>
      </defs>
      <rect x="65" y="455" width="270" height="15" fill="#000000" opacity="0.6"/>
      <rect x="60" y="60" width="280" height="390" rx="16" fill="url(#lv-steel)" stroke="#334155" stroke-width="3"/>
      <rect x="65" y="65" width="270" height="55" rx="10" fill="url(#lv-panel)" stroke="#1e293b" stroke-width="2"/>
      <text x="200" y="82" fill="#f8fafc" font-family="-apple-system,sans-serif" font-size="12" font-weight="bold" letter-spacing="2" text-anchor="middle">LAVASTOVIGLIE</text>
      <rect x="145" y="93" width="110" height="20" rx="4" fill="#020617" stroke="#0284c7" stroke-width="1.2"/>
      <text x="200" y="107" fill="#38bdf8" font-family="'Courier New',monospace" font-size="10" font-weight="bold" text-anchor="middle"
        textLength="100" lengthAdjust="spacingAndGlyphs" data-role="disp">PRONTA</text>
      <rect x="65" y="123" width="270" height="312" fill="url(#lv-steel)"/>
      <path d="M 75 130 L 160 130 L 325 435 L 240 435 Z" fill="#ffffff" opacity="0.04"/>
      <rect x="110" y="133" width="180" height="14" rx="6" fill="#020617" stroke="#475569" stroke-width="1"/>
      <rect x="120" y="138" width="160" height="4" rx="2" fill="#1e293b"/>
      <rect x="120" y="138" height="4" rx="2" fill="#38bdf8" class="lv-led lv-progress"/>
      <rect x="65" y="435" width="270" height="15" fill="#0f172a"/>
      <rect x="80" y="450" width="30" height="8" fill="#0f172a"/>
      <rect x="290" y="450" width="30" height="8" fill="#0f172a"/>
    </svg>`;
  }

  _svgForno() {
    return `
    <svg viewBox="0 0 500 500" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .fo-fan{transform-origin:250px 305px}
          .cec-machine.running .fo-fan{animation:fo-fan-spin 2s linear infinite}
          @keyframes fo-fan-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
          .fo-heat{opacity:0;transition:opacity .5s}
          .cec-machine.running .fo-heat{opacity:1;animation:fo-heat-glow 3s ease-in-out infinite}
          @keyframes fo-heat-glow{0%,100%{opacity:.25}50%{opacity:.55}}
          .fo-led{opacity:.5}
          .cec-machine.plug-on .fo-led{animation:fo-led-blink 2s infinite}
          @keyframes fo-led-blink{0%,100%{opacity:.9}50%{opacity:1;filter:drop-shadow(0 0 4px #38bdf8)}}
        </style>
        <linearGradient id="fo-inox" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#475569"/><stop offset="25%" stop-color="#94a3b8"/>
          <stop offset="50%" stop-color="#cbd5e1"/><stop offset="75%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#334155"/>
        </linearGradient>
        <linearGradient id="fo-handle" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#f8fafc"/><stop offset="50%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#475569"/>
        </linearGradient>
        <radialGradient id="fo-light" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#f97316" stop-opacity="0.8"/><stop offset="70%" stop-color="#7c2d12" stop-opacity="0.4"/>
          <stop offset="100%" stop-color="#1c1917" stop-opacity="0.1"/>
        </radialGradient>
      </defs>
      <rect x="20" y="20" width="460" height="460" rx="4" fill="#1e293b" stroke="#0f172a" stroke-width="4"/>
      <rect x="40" y="40" width="420" height="420" rx="12" fill="url(#fo-inox)" stroke="#1e293b" stroke-width="3"/>
      <rect x="50" y="50" width="400" height="85" fill="#0f172a" stroke="#334155" stroke-width="2"/>
      <text x="250" y="70" fill="#f8fafc" font-family="-apple-system,sans-serif" font-size="15" font-weight="bold" letter-spacing="2" text-anchor="middle">Hisense</text>
      <circle cx="90" cy="92" r="22" fill="url(#fo-inox)" stroke="#1e293b" stroke-width="2"/>
      <circle cx="90" cy="92" r="18" fill="#0f172a"/><rect x="88" y="76" width="4" height="16" rx="1" fill="#f8fafc"/>
      <circle cx="410" cy="92" r="22" fill="url(#fo-inox)" stroke="#1e293b" stroke-width="2"/>
      <circle cx="410" cy="92" r="18" fill="#0f172a"/><rect x="408" y="76" width="4" height="16" rx="1" fill="#f8fafc"/>
      <rect x="160" y="73" width="180" height="40" rx="6" fill="#020617" stroke="#1e293b" stroke-width="1.5"/>
      <text x="250" y="98" fill="#38bdf8" font-family="'Courier New',monospace" font-size="14" font-weight="bold" text-anchor="middle"
        textLength="168" lengthAdjust="spacingAndGlyphs" class="fo-led" data-role="disp">PRONTA</text>
      <rect x="50" y="140" width="400" height="310" fill="#020617" stroke="#334155" stroke-width="3"/>
      <rect x="85" y="185" width="330" height="245" rx="8" fill="#1c1917" stroke="#334155" stroke-width="2"/>
      <rect x="85" y="185" width="330" height="245" rx="8" fill="url(#fo-light)" class="fo-heat"/>
      <g class="fo-fan">
        <circle cx="250" cy="305" r="32" fill="#27272a" opacity="0.6"/>
        <path d="M 250 305 Q 260 275 250 270 Q 240 275 250 305 Z" fill="#71717a"/>
        <path d="M 250 305 Q 280 315 285 305 Q 280 295 250 305 Z" fill="#71717a"/>
        <path d="M 250 305 Q 240 335 250 340 Q 260 335 250 305 Z" fill="#71717a"/>
        <path d="M 250 305 Q 220 295 215 305 Q 220 315 250 305 Z" fill="#71717a"/>
        <circle cx="250" cy="305" r="7" fill="#e4e4e7"/>
      </g>
      <line x1="95" y1="320" x2="405" y2="320" stroke="#e4e4e7" stroke-width="2.5" opacity="0.8"/>
      <line x1="95" y1="380" x2="405" y2="380" stroke="#52525b" stroke-width="5"/>
      <path d="M 90 185 L 220 185 L 120 430 L 90 430 Z" fill="#ffffff" opacity="0.06"/>
      <rect x="70" y="150" width="360" height="18" rx="6" fill="url(#fo-handle)" stroke="#334155" stroke-width="1"/>
    </svg>`;
  }

  _svgPianoInduzione() {
    return `
    <svg viewBox="0 0 500 400" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .pi-zone{opacity:.4}
          .cec-machine.running .pi-zone{animation:pi-zone-glow 2.5s ease-in-out infinite;opacity:1}
          @keyframes pi-zone-glow{0%,100%{filter:drop-shadow(0 0 2px #38bdf8);opacity:.8}50%{filter:drop-shadow(0 0 6px #0284c7);opacity:1}}
          .pi-slider{opacity:.4}
          .cec-machine.running .pi-slider{animation:pi-slider-pulse 1.8s ease-in-out infinite;opacity:1}
          @keyframes pi-slider-pulse{0%,100%{opacity:.85}50%{opacity:1;filter:drop-shadow(0 0 4px #38bdf8)}}
        </style>
        <linearGradient id="pi-glass" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#111827"/><stop offset="50%" stop-color="#090d16"/><stop offset="100%" stop-color="#030712"/>
        </linearGradient>
        <linearGradient id="pi-frame" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#334155"/><stop offset="50%" stop-color="#64748b"/><stop offset="100%" stop-color="#1e293b"/>
        </linearGradient>
      </defs>
      <!-- piano cucina chiaro attorno al vetro nero, così il piano risalta sullo sfondo scuro della card -->
      <rect x="0" y="0" width="500" height="400" fill="#d7dce1"/>
      <rect x="45" y="45" width="410" height="310" rx="12" fill="#000000" opacity="0.6"/>
      <rect x="50" y="50" width="400" height="300" rx="10" fill="url(#pi-glass)" stroke="url(#pi-frame)" stroke-width="2.5"/>
      <rect x="52" y="52" width="396" height="296" rx="8" fill="none" stroke="#334155" stroke-width="1"/>
      <text x="250" y="75" fill="#f8fafc" font-family="-apple-system,sans-serif" font-size="12" font-weight="bold" letter-spacing="3" text-anchor="middle">SAMSUNG</text>
      <g class="pi-zone">
        <rect x="80" y="100" width="120" height="180" rx="8" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="6 4"/>
        <text x="140" y="190" fill="#0284c7" font-family="-apple-system,sans-serif" font-size="8" font-weight="bold" letter-spacing="1" text-anchor="middle">FLEX ZONE</text>
        <line x1="140" y1="120" x2="140" y2="140" stroke="#38bdf8" stroke-width="1.5"/><line x1="130" y1="130" x2="150" y2="130" stroke="#38bdf8" stroke-width="1.5"/>
        <line x1="140" y1="240" x2="140" y2="260" stroke="#38bdf8" stroke-width="1.5"/><line x1="130" y1="250" x2="150" y2="250" stroke="#38bdf8" stroke-width="1.5"/>
      </g>
      <g class="pi-zone">
        <circle cx="320" cy="220" r="55" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="6 4"/>
        <circle cx="320" cy="220" r="25" fill="none" stroke="#0284c7" stroke-width="1"/>
        <line x1="320" y1="210" x2="320" y2="230" stroke="#38bdf8" stroke-width="1.5"/><line x1="310" y1="220" x2="330" y2="220" stroke="#38bdf8" stroke-width="1.5"/>
      </g>
      <circle cx="320" cy="130" r="35" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="6 4" class="pi-zone"/>
      <line x1="320" y1="123" x2="320" y2="137" stroke="#38bdf8" stroke-width="1.5"/><line x1="313" y1="130" x2="327" y2="130" stroke="#38bdf8" stroke-width="1.5"/>
      <path d="M 60 60 L 150 60 L 440 340 L 350 340 Z" fill="#ffffff" opacity="0.03"/>
      <rect x="70" y="305" width="360" height="30" fill="#020617" opacity="0.8"/>
      <circle cx="90" cy="320" r="8" fill="none" stroke="#ef4444" stroke-width="1.5"/><line x1="90" y1="315" x2="90" y2="321" stroke="#ef4444" stroke-width="1.5"/>
      <line x1="130" y1="320" x2="230" y2="320" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>
      <line x1="130" y1="320" x2="190" y2="320" stroke="#38bdf8" stroke-width="4" stroke-linecap="round" class="pi-slider"/>
      <text x="250" y="324" fill="#38bdf8" font-family="'Courier New',monospace" font-size="11" font-weight="bold" text-anchor="middle"
        textLength="70" lengthAdjust="spacingAndGlyphs" class="pi-slider" data-role="disp">PRONTA</text>
    </svg>`;
  }

  // Frigorifero Haier a 4 ante: 2 sportelli frigo (con dispenser acqua incassato
  // sulla destra) + 2 cassetti congelatore sotto. La temperatura mostrata è
  // decorativa (non tracciamo un sensore di temperatura reale).
  _svgFrigoHaier() {
    return `
    <svg viewBox="0 0 400 650" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .fr-drop{opacity:0}
          .cec-machine.plug-on .fr-drop{animation:fr-drop-flow 1.8s cubic-bezier(.4,0,.6,1) infinite}
          @keyframes fr-drop-flow{0%{transform:translateY(0) scaleY(1);opacity:0}30%{opacity:1}70%{opacity:1}100%{transform:translateY(32px) scaleY(1.4);opacity:0}}
          .fr-disp{opacity:.5}
          .cec-machine.plug-on .fr-disp{animation:fr-led-glow 2.5s ease-in-out infinite}
          @keyframes fr-led-glow{0%,100%{filter:drop-shadow(0 0 2px #38bdf8);opacity:.9}50%{filter:drop-shadow(0 0 6px #38bdf8);opacity:1}}
          .fr-fresh{opacity:.15}
          .cec-machine.running .fr-fresh{animation:fr-cool-pulse 3s ease-in-out infinite}
          @keyframes fr-cool-pulse{0%,100%{opacity:.3}50%{opacity:.8}}
        </style>
        <linearGradient id="fr-steel" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#dfe4e9"/><stop offset="20%" stop-color="#eef1f4"/><stop offset="50%" stop-color="#ffffff"/>
          <stop offset="80%" stop-color="#eef1f4"/><stop offset="100%" stop-color="#c3cbd3"/>
        </linearGradient>
        <linearGradient id="fr-niche" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#020617"/><stop offset="100%" stop-color="#1e293b"/>
        </linearGradient>
        <linearGradient id="fr-stream" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.8"/><stop offset="100%" stop-color="#0284c7" stop-opacity="0.2"/>
        </linearGradient>
      </defs>
      <rect x="40" y="20" width="320" height="610" rx="16" fill="url(#fr-steel)" stroke="#0f172a" stroke-width="4"/>
      <text x="200" y="42" fill="#475569" font-family="-apple-system,sans-serif" font-size="14" font-weight="bold" letter-spacing="4" text-anchor="middle">Haier</text>
      <path d="M 46 52 L 197 52 L 197 402 L 46 402 Z" fill="url(#fr-steel)" stroke="#0f172a" stroke-width="2"/>
      <path d="M 203 52 L 354 52 L 354 402 L 203 402 Z" fill="url(#fr-steel)" stroke="#0f172a" stroke-width="2"/>
      <line x1="200" y1="52" x2="200" y2="402" stroke="#020617" stroke-width="3"/>
      <rect x="190" y="160" width="6" height="150" rx="3" fill="#020617"/><rect x="204" y="160" width="6" height="150" rx="3" fill="#020617"/>
      <rect x="242" y="125" width="90" height="135" rx="10" fill="url(#fr-niche)" stroke="#334155" stroke-width="2"/>
      <rect x="248" y="131" width="78" height="123" rx="6" fill="#090d16"/>
      <g class="fr-disp">
        <text x="287" y="149" fill="#38bdf8" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">4°C | -18°C</text>
        <path d="M 279 160 Q 287 152 295 160 Q 287 168 279 160 Z" fill="#38bdf8"/>
      </g>
      <rect x="281" y="175" width="12" height="8" rx="2" fill="#64748b"/>
      <line x1="287" y1="183" x2="287" y2="233" stroke="url(#fr-stream)" stroke-width="3" stroke-linecap="round"/>
      <circle cx="287" cy="187" r="3" fill="#7dd3fc" class="fr-drop"/>
      <circle cx="287" cy="195" r="2.5" fill="#38bdf8" class="fr-drop" style="animation-delay:.6s"/>
      <rect x="254" y="237" width="66" height="10" rx="2" fill="#1e293b" stroke="#334155"/>
      <line x1="260" y1="242" x2="314" y2="242" stroke="#475569" stroke-width="2" stroke-dasharray="4 2"/>
      <rect x="46" y="410" width="308" height="95" rx="6" fill="url(#fr-steel)" stroke="#0f172a" stroke-width="2"/>
      <rect x="120" y="420" width="160" height="10" rx="5" fill="#020617"/>
      <rect x="122" y="422" width="156" height="3" rx="1.5" fill="#475569" opacity="0.6"/>
      <rect x="65" y="423" width="30" height="4" rx="2" fill="#38bdf8" class="fr-fresh"/>
      <rect x="46" y="513" width="308" height="102" rx="6" fill="url(#fr-steel)" stroke="#0f172a" stroke-width="2"/>
      <rect x="120" y="523" width="160" height="10" rx="5" fill="#020617"/>
      <rect x="122" y="525" width="156" height="3" rx="1.5" fill="#475569" opacity="0.6"/>
      <rect x="60" y="618" width="30" height="8" rx="2" fill="#0f172a"/><rect x="310" y="618" width="30" height="8" rx="2" fill="#0f172a"/>
    </svg>`;
  }

  // Congelatore a pozzetto: coperchio superiore che "respira" quando il
  // compressore è attivo, display touch con temperatura decorativa.
  _svgCongelatoreChest() {
    return `
    <svg viewBox="0 0 400 500" class="cec-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .cg-lid{transform:translateY(0)}
          .cec-machine.running .cg-lid{animation:cg-lid-lift 3.5s ease-in-out infinite}
          @keyframes cg-lid-lift{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
          .cg-led{opacity:.5}
          .cec-machine.plug-on .cg-led{animation:cg-led-pulse 2s ease-in-out infinite}
          @keyframes cg-led-pulse{0%,100%{filter:drop-shadow(0 0 2px #38bdf8);opacity:.85}50%{filter:drop-shadow(0 0 6px #38bdf8);opacity:1}}
        </style>
        <linearGradient id="cg-steel" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#e0e5ea"/><stop offset="25%" stop-color="#f0f3f5"/><stop offset="50%" stop-color="#ffffff"/>
          <stop offset="75%" stop-color="#f0f3f5"/><stop offset="100%" stop-color="#c5cdd5"/>
        </linearGradient>
        <linearGradient id="cg-lid-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#dfe4e9"/><stop offset="50%" stop-color="#eef1f4"/><stop offset="100%" stop-color="#c9d1d9"/>
        </linearGradient>
      </defs>
      <rect x="65" y="455" width="270" height="15" fill="#000000" opacity="0.6"/>
      <rect x="60" y="60" width="280" height="390" rx="16" fill="url(#cg-steel)" stroke="#334155" stroke-width="3"/>
      <rect x="65" y="113" width="270" height="332" fill="url(#cg-steel)"/>
      <text x="200" y="145" fill="#475569" font-family="-apple-system,sans-serif" font-size="13" font-weight="bold" letter-spacing="2.5" text-anchor="middle">CONGELATORE</text>
      <rect x="150" y="170" width="100" height="32" rx="6" fill="#020617" stroke="#0284c7" stroke-width="1.5"/>
      <text x="200" y="191" fill="#38bdf8" font-family="'Courier New',monospace" font-size="12" font-weight="bold" text-anchor="middle" class="cg-led">-20°C</text>
      <path d="M 75 120 L 160 120 L 325 430 L 240 430 Z" fill="#ffffff" opacity="0.04"/>
      <g class="cg-lid">
        <rect x="65" y="65" width="270" height="45" rx="10" fill="url(#cg-lid-grad)" stroke="#475569" stroke-width="2"/>
        <rect x="120" y="80" width="160" height="14" rx="6" fill="#020617" stroke="#475569" stroke-width="1"/>
        <rect x="125" y="83" width="150" height="3" rx="1.5" fill="#38bdf8" class="cg-led"/>
      </g>
      <line x1="60" y1="110" x2="340" y2="110" stroke="#020617" stroke-width="3"/>
      <rect x="80" y="450" width="30" height="8" fill="#0f172a"/><rect x="290" y="450" width="30" height="8" fill="#0f172a"/>
    </svg>`;
  }

  _build() {
    this.innerHTML = `
    <style>
      .cec{--cec-panel:rgba(30,38,48,.72);--cec-stroke:rgba(255,255,255,.09);--cec-ink:#eaf1f8;--cec-muted:#93a1b0;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--cec-ink);padding:6px;
        min-height:100%;display:flex;flex-direction:column}
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
      .cec-plugbadge-readonly{cursor:default!important}
      .cec-plugbadge-readonly:hover{transform:none!important;filter:none!important}
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
      /* stanza — icone generiche stanza/dispositivo */
      .cec-machine[data-kind="stanza"] .cec-glass-wrap{max-width:112px}
      .stz-icon [data-role="mercury"]{transition:height .6s ease,y .6s ease}
      .stz-glow{opacity:.12;transition:opacity .5s}
      .cec-machine.running .stz-glow{opacity:1;animation:stz-pulse 2.6s ease-in-out infinite}
      @keyframes stz-pulse{0%,100%{opacity:.6}50%{opacity:1}}
      .stz-screen,.stz-bolt{opacity:.25;transition:opacity .4s}
      .cec-machine.running .stz-screen{opacity:1;animation:stz-pulse-fast 2s ease-in-out infinite}
      .cec-machine.running .stz-bolt{opacity:1;filter:drop-shadow(0 0 5px #ffb020);animation:stz-pulse-fast 1.8s ease-in-out infinite}
      @keyframes stz-pulse-fast{0%,100%{opacity:.75}50%{opacity:1}}
      .cec-sub{font-size:11.5px;color:var(--cec-muted);margin-top:-2px;text-align:center}
      .cec-machine[data-phase="on"] .cec-state{color:#8ff0b4}
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
        <div class="cec-sub" data-role="sub" hidden></div>
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
    // Frigorifero e congelatore: la presa NON si deve poter spegnere per sbaglio
    // dalla dashboard (rischio di perdere il cibo) — il badge resta solo un
    // indicatore, non un comando, per questi due tipi.
    if (!CONTINUOUS[this._cfg.kind]) {
      badge.onclick = e => { e.stopPropagation(); this._togglePower(); };
    } else {
      badge.classList.add("cec-plugbadge-readonly");
    }
  }

  _togglePower() {
    if (CONTINUOUS[this._cfg.kind]) return; // sicurezza: mai spegnere frigo/congelatore da qui
    if (this._cfg.switch && this._hass.states[this._cfg.switch]) {
      this._hass.callService("switch", "toggle", { entity_id: this._cfg.switch });
    }
  }

  // Stanza: non ha fasi tipo "riscaldamento/preriscaldo/cottura" da rilevare dal
  // consumo — è on/off (dalla presa se configurata, altrimenti dalla potenza) più,
  // se configurati, temperatura/umidità della stanza. _update() normale non si
  // applica: qui evitiamo del tutto classifyPhase().
  _updateStanza() {
    const cfg = this._cfg;
    const sw = cfg.switch && this._hass.states[cfg.switch];
    const p = this._num(cfg.power);
    let on;
    if (sw) on = sw.state === "on";
    else if (cfg.power) on = p != null && p > (parseFloat(cfg.soglia) || 10);
    else on = false;
    this._el.classList.toggle("running", on);
    this._el.classList.toggle("plug-on", on);
    this._el.dataset.phase = on ? "on" : "off";
    this._el.querySelector('[data-role="state"]').textContent = on ? "Accesa" : "Spenta";
    this._el.querySelector('[data-role="power"]').textContent = p != null ? Math.round(p) : "–";
    const badge = this._el.querySelector('[data-role="plugbadge"]');
    if (sw) {
      badge.hidden = false;
      badge.dataset.plug = on ? "on" : "off";
      badge.querySelector(".lbl").textContent = on ? "Accesa" : "Spenta";
    } else badge.hidden = true;

    const t = this._num(cfg.temp), h = this._num(cfg.humidity);
    const sub = this._el.querySelector('[data-role="sub"]');
    if (t != null || h != null) {
      sub.hidden = false;
      sub.innerHTML = [t != null ? `🌡️ ${this._fmt(t)}°C` : "", h != null ? `💧 ${Math.round(h)}%` : ""]
        .filter(Boolean).join(" · ");
    } else sub.hidden = true;

    if (cfg.icon_type === "climate" && t != null) {
      const mercury = this._el.querySelector('[data-role="mercury"]');
      const bulb = this._el.querySelector('[data-role="bulb"]');
      if (mercury && bulb) {
        const lo = 5, hi = 35, bottom = 76, minH = 6, maxH = 46;
        const frac = Math.min(1, Math.max(0, (t - lo) / (hi - lo)));
        const hgt = minH + frac * (maxH - minH);
        mercury.setAttribute("height", hgt.toFixed(1));
        mercury.setAttribute("y", (bottom - hgt).toFixed(1));
        const freddo = parseFloat(cfg.soglia_freddo), caldo = parseFloat(cfg.soglia_caldo);
        let cls = "Comfy";
        if (!isNaN(freddo) && t < freddo) cls = "Cold";
        else if (!isNaN(caldo) && t > caldo) cls = "Hot";
        mercury.setAttribute("fill", `url(#stzMercury${cls})`);
        bulb.setAttribute("fill", `url(#stzBulb${cls})`);
      }
    }
    const lc = this._el.querySelector('[data-role="lastcycle"]');
    if (lc) lc.hidden = true;
  }

  _update() {
    if (!this._el) return;
    if (this._cfg.kind === "stanza") { this._updateStanza(); return; }
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
    const hist = this._hist, cfg = this._cfg, continuous = CHART_VIEW[cfg.kind];
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
          <option value="piano_induzione"${c.kind === "piano_induzione" ? " selected" : ""}>🍳 Piano induzione</option>
          <option value="frigorifero"${c.kind === "frigorifero" ? " selected" : ""}>❄️ Frigorifero</option>
          <option value="congelatore"${c.kind === "congelatore" ? " selected" : ""}>🧊 Congelatore</option>
          <option value="stanza"${c.kind === "stanza" ? " selected" : ""}>🛋️ Stanza / dispositivo</option>
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
      ${c.kind === "stanza" ? `
      <div class="fld"><label>Icona</label>
        <select id="f_icontype">
          <option value="generic"${c.icon_type === "generic" ? " selected" : ""}>🔌 Generica (presa/dispositivo)</option>
          <option value="climate"${c.icon_type === "climate" ? " selected" : ""}>🌡️ Temperatura/Clima</option>
          <option value="livingroom"${c.icon_type === "livingroom" ? " selected" : ""}>🛋️ Soggiorno</option>
          <option value="bedroom"${c.icon_type === "bedroom" ? " selected" : ""}>🛏️ Camera da letto</option>
        </select></div>
      <div class="fld"><label>Sensore temperatura — opzionale</label><select id="f_temp">${this._opts(["sensor."], c.temp)}</select></div>
      <div class="fld"><label>Sensore umidità — opzionale</label><select id="f_humidity">${this._opts(["sensor."], c.humidity)}</select></div>
      <div class="row">
        <div class="fld"><label>Soglia freddo (°C)</label><input type="number" id="f_sfreddo" value="${c.soglia_freddo ?? 18}"></div>
        <div class="fld"><label>Soglia caldo (°C)</label><input type="number" id="f_scaldo" value="${c.soglia_caldo ?? 26}"></div>
      </div>` : ""}
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
      <div class="note">💡 Le soglie sono una STIMA dal consumo istantaneo (non leggono il programma reale). Frigorifero, congelatore e Stanza mostrano solo il grafico consumi (non a cicli); per Stanza serve il sensore di potenza per avere lo storico.</div>
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
    on("#f_icontype", "change", e => this._set("icon_type", e.target.value));
    on("#f_temp", "change", e => this._set("temp", e.target.value));
    on("#f_humidity", "change", e => this._set("humidity", e.target.value));
    on("#f_sfreddo", "change", e => this._set("soglia_freddo", parseFloat(String(e.target.value).replace(",", ".")) || 18));
    on("#f_scaldo", "change", e => this._set("soglia_caldo", parseFloat(String(e.target.value).replace(",", ".")) || 26));
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
  description: "Card indipendente per lavastoviglie, forno, frigorifero, congelatore o stanza/dispositivo generico: fase dal consumo, storico e costo.",
  preview: true,
  documentationURL: "https://github.com/cristianwebonline/ha-centro-elettrodomestici-card",
});
