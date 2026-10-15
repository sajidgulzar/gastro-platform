# Gastro-Plattform

Eigene Plattform für mehrere Restaurant-Shops mit Login, Datenbank und Live-Bestellungen.
Ohne externe Pakete: nur Node.js 22.5 oder neuer.

## Was drin ist
- **Login** mit E-Mail und Passwort (Passwörter werden mit scrypt gespeichert, Sitzung per sicherem Cookie)
- **Rollen:** Inhaber sieht alle Shops, Bestellungen und Benutzer. Gastronom sieht nur seine eigenen Shops.
- **Mehrere Shops**, jeder mit eigener Adresse: `https://deine-domain.de/s/pizzeria-roma`
- **Kunden bestellen ohne Konto.** Der Server rechnet Preise, Extras, Liefergebühr und Mindestbestellwert selbst nach. Manipulierte Preise werden ignoriert.
- **Dashboard:** Live-Bestellungen mit Ton und Meldung, Status (Neu, In Zubereitung, Bereit, Erledigt, Storniert), Bon drucken, Umsatz pro Shop
- **Shop-Editor:** Design, Texte, Kategorien, Gerichte, Extras, Allergene, Lieferzonen, Bilder
- Bilder und Daten liegen im Ordner `data/` (Datenbank `gastro.db`, Bilder in `uploads/`)

## Lokal starten
```
node server.js
```
Dann `http://localhost:3000/admin` öffnen. Beim ersten Mal legst du das Inhaber-Konto an.

## Online stellen
Du brauchst einen Server oder Dienst, der Node.js 22 oder Docker ausführt und einen **dauerhaften Speicher** (Volume) bietet, zum Beispiel Hetzner, Railway, Render, Fly.io oder ein eigener VPS.

Wichtige Einstellungen (Umgebungsvariablen):

| Variable | Bedeutung |
|---|---|
| `PORT` | Port des Servers (Standard 3000) |
| `DATA_DIR` | Ordner für Datenbank und Bilder, muss dauerhaft gespeichert sein |
| `SESSION_SECRET` | Langer zufälliger Text für Sitzungen (sonst wird eine Datei erzeugt) |
| `COOKIE_SECURE=1` | Nur mit HTTPS setzen |
| `TRUST_PROXY=1` | Wenn ein Proxy davorsteht (Render, Railway, nginx) |
| `ALLOW_SIGNUP=1` | Erlaubt Selbstregistrierung neuer Gastronomen (Standard aus) |

Mit Docker: `docker build -t gastro . && docker run -p 3000:3000 -v gastro-data:/data gastro`

**Unbedingt HTTPS nutzen**, sonst werden Passwörter unverschlüsselt übertragen.

## Sicherung
Kopiere regelmäßig den Ordner `data/` (oder `DATA_DIR`). Darin steckt alles.

## Grenzen
- Keine Online-Zahlung (Karte, PayPal): im Moment nur die Auswahl, bezahlt wird bei Lieferung oder Abholung. Dafür müsste Stripe oder PayPal angebunden werden.
- Kein E-Mail- oder SMS-Versand an Kunden.
- Eine einzelne Server-Instanz mit SQLite, geeignet für viele kleine bis mittlere Betriebe.
- Bestellmeldungen kommen live, solange das Dashboard im Browser geöffnet ist.
- Allergen-Angaben sind Angaben der Betreiber, die Verantwortung liegt bei ihnen.

---

## Master-Panel (`/master`)

Zentrale Verwaltung aller Shops für den Plattform-Inhaber. Gastronomen haben darauf keinen Zugriff (der Server prüft die Rolle bei jeder Anfrage).

**Bereiche**
- **Übersicht:** Kennzahlen (aktive Shops, Umsatz heute und 7 Tage, Bestellungen, monatlicher Abo-Umsatz, offene Bestellungen), Diagramm der letzten 14 Tage, Top-Shops, Lieferung gegen Abholung, Liste „Braucht Aufmerksamkeit“, letzte Bestellungen
- **Shops:** Suche, Filter nach Status, Sortierung, Sammelaktionen (aktivieren, pausieren, sperren), Detailfenster mit Paket, Abo-Ende, Besitzer und Notiz, neuen Shop anlegen, Shop löschen (mit Namensbestätigung)
- **Bestellungen:** alle Shops zusammen, Filter, Statuswechsel, Detailansicht, CSV-Export
- **Pakete & Abos:** Pakete und Preise bearbeiten, MRR und Jahresumsatz, bald endende Abos
- **Benutzer:** anlegen, Passwort setzen, löschen
- **Aktivität:** Protokoll aller wichtigen Änderungen (Audit-Log)
- **System:** Laufzeit, Datenbankgröße, Sicherungen (erstellen, herunterladen), Wartungsmodus

**Automatisch**
- Live-Updates neuer Bestellungen (ohne Neuladen), zusätzlich alle 30 Sekunden
- Läuft das Abo eines Shops ab, geht er selbst offline („Abgelaufen“)
- Tägliche Sicherung der Datenbank, die letzten 14 bleiben (Ordner `data/backups`)
- Markierung von Shops, die Aufmerksamkeit brauchen (Abo endet bald, leer, lange keine Bestellung)

**Shop-Status:** *Aktiv*, *Pausiert*, *Gesperrt* oder (automatisch) *Abgelaufen*. Nicht aktive Shops sind öffentlich nicht erreichbar und nehmen keine Bestellungen an. Im **Wartungsmodus** gilt das für alle Shops gleichzeitig.

**Editor:** Im Master-Panel führt „Bearbeiten“ direkt in den Shop-Editor (`/admin?edit=<id>`). Im Editor gibt es oben einen Link „Master“.
