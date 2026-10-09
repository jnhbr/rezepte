# Einrichtung Rezepte-App

Reihenfolge: 1 → 2 → 3 → 4. Jeder Schritt funktioniert einzeln; ohne Schritt 2 und 3 läuft die App lokal auf einem Handy.

## 1. Veröffentlichen (GitHub Pages)
Repo `jnhbr/rezepte` anlegen (öffentlich ist okay: im Code steht kein Geheimnis), den Ordner hochladen, unter *Settings → Pages* «Deploy from branch → main /(root)» wählen.
Adresse danach: `https://jnhbr.github.io/rezepte/`
Auf dem iPhone in Safari öffnen → Teilen → «Zum Home-Bildschirm».

## 2. Sync (Firebase, gratis)
1. console.firebase.google.com → Projekt erstellen (Analytics aus).
2. *Build → Firestore Database* → Datenbank erstellen (Standort `europe-west6` Zürich), Produktionsmodus.
3. Reiter *Regeln* → ersetzen durch:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
       match /haushalte/{code}/{document=**} { allow read, write: if true; }
     }
   }
   ```
   (Schutz = langer, geheimer Zugangscode als Pfad; es gibt keine Auflistung.)
4. *Projekteinstellungen → Allgemein → Web-App hinzufügen* → `firebaseConfig` kopieren und in `config.js` bei `window.FIREBASE_CONFIG = {...}` einsetzen.
5. In der App unter *Mehr* auf beiden Handys denselben Zugangscode eintragen.

## 3. KI-Import (Cloudflare Worker + Anthropic-Key)
1. console.anthropic.com → Guthaben aufladen (5 $, Auto-Reload aus), *API Keys* → Key erstellen.
2. dash.cloudflare.com → kostenloses Konto → *Workers & Pages → Create → Worker*, Code aus `worker/worker.js` einfügen, deployen.
3. Worker → *Settings → Variables and Secrets*: `ANTHROPIC_API_KEY` (Key) und `ACCESS_CODE` (derselbe Code wie in der App) als **Secret** anlegen.
4. Worker-Adresse (`https://rezepte-ki.<name>.workers.dev`) in `config.js` bei `window.RECIPE_WORKER` eintragen.

## 4. iOS-Kurzbefehl fürs Teilen-Menü
App *Kurzbefehle* → «+» → Name «Zu Rezepte»:
1. Oben auf das (i): «Im Share Sheet anzeigen» an, Eingabetypen nur **URLs**.
2. Aktion «Text» → `https://jnhbr.github.io/rezepte/?link=` + Variable «Kurzbefehl-Eingabe».
3. Aktion «URL-Codierung» auf die Eingabe anwenden (vor Schritt 2 einbauen), dann die codierte Variable verwenden.
4. Aktion «URLs öffnen» mit dem Text aus Schritt 2.

Nutzung: In Instagram beim Reel *Teilen → Mehr → Zu Rezepte*. Die App öffnet sich mit dem Entwurf; mit «Ausfüllen» (ohne Text) wird versucht, den Text vom Link zu holen, sonst Text oder Screenshot einfügen.
