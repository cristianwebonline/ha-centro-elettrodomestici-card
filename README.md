# Centro Elettrodomestici Card

Card **indipendente** per lavastoviglie, forno, piano a induzione, frigorifero o
congelatore (metti una card per ciascuno), con grafica realistica animata,
rilevamento fase dal consumo, storico e costo. Gira nel browser e legge/comanda le
entità via `hass`, quindi non dipende da server esterni.

- Una card = un elettrodomestico (`kind: lavastoviglie | forno | piano_induzione | frigorifero | congelatore`)
- Grafica **diversa per tipo**, in stile inox/smart: lavastoviglie con barra di
  avanzamento, forno da incasso con ventola e vetro che si illumina, piano a
  induzione con zone di cottura animate, frigorifero Haier a 4 ante (2 sportelli +
  dispenser acqua + 2 cassetti freezer), congelatore a pozzetto col coperchio che
  "respira" quando il compressore lavora
- **Sicurezza**: su frigorifero e congelatore il badge presa è solo un indicatore,
  MAI un comando — non si spengono per sbaglio dalla dashboard
- **Dati robusti**: frigo/congelatore non dipendono dai contatori "energia totale"
  (spesso inaffidabili) — i kWh sono calcolati integrando nel tempo il sensore di
  potenza, sempre disponibile
- **Rilevamento fase dal consumo** (soglie regolabili nell'editor):
  - Lavastoviglie: Ferma → Lavaggio/risciacquo → Riscaldamento acqua
  - Forno: Spento → Preriscaldo (primi minuti) → In cottura
  - Frigorifero/Congelatore: Compressore a riposo → Compressore attivo
- **Badge "Presa accesa/spenta"**: tocchi per accendere/spegnere, lampeggia piano
  quando è accesa e tinge lo sfondo della card
- **Storico e costo**: lavastoviglie/forno (uso a sessioni) mostrano l'elenco cicli
  recenti con data/durata/kWh/costo; frigorifero/congelatore (funzionamento continuo)
  mostrano il grafico consumi + media giornaliera, senza lista cicli
- Tutto ricostruito dallo storico energia già presente in Home Assistant (nessun
  helper nuovo da creare)
- **Ridimensionabile in altezza/larghezza** dall'editor dashboard di HA (scheda "Layout")
- **Foto vera opzionale** (`photo_url`): se la imposti, sostituisce il disegno con la tua foto
- **Editor visuale** completo, senza toccare YAML

## Uso

```yaml
type: custom:centro-elettrodomestici-card
kind: lavastoviglie          # lavastoviglie | forno | frigorifero | congelatore
name: Lavastoviglie
power: sensor.shelly_lavastoviglie_power
energy: sensor.shelly_lavastoviglie_energy
switch: switch.shelly_lavastoviglie
soglia: 10
soglia_riscaldamento: 1200    # solo lavastoviglie, 0 = disattiva
prezzo_kwh: 0.30
storico_giorni: 14
```

```yaml
type: custom:centro-elettrodomestici-card
kind: forno
name: Forno
power: sensor.presa_forno_power
energy: sensor.presa_forno_energy
switch: switch.presa_forno
soglia: 15
preriscaldo_min: 10           # minuti stimati di preriscaldo
```

```yaml
type: custom:centro-elettrodomestici-card
kind: frigorifero
name: Frigorifero
power: sensor.frigo_power
energy: sensor.frigo_energy
switch: switch.frigo_outlet
soglia: 15
```
