# Centro Elettrodomestici Card

Card **indipendente** per lavastoviglie, forno, frigorifero o congelatore (metti una
card per ciascuno), con grafica realistica animata, rilevamento fase dal consumo,
storico e costo. Gira nel browser e legge/comanda le entità via `hass`, quindi non
dipende da server esterni.

- Una card = un elettrodomestico (`kind: lavastoviglie | forno | frigorifero | congelatore`)
- Grafica **diversa per tipo**: lavastoviglie con porta flat e spie di ciclo, forno con
  vetro che si illumina di caldo, frigorifero/congelatore a colonna verticale (il
  congelatore con brina e ❄️)
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
