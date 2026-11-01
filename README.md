# Pluie en vue

Appli web (installable sur le téléphone) qui dit **s'il va pleuvoir là où tu es** :

- dans **1 h, 2 h, 4 h, 12 h et 24 h**, avec la **quantité prévue** (mm) et l'intensité (faible / modérée / forte) ;
- un **graphique** au quart d'heure sur 6 h, et heure par heure sur 24 h ;
- un **radar animé** : les 2 dernières heures observées, puis la prévision **quart d'heure par quart d'heure** sur 6 h ;
- des **alertes** : « attention, pluie modérée d'ici 30 min », et des **alertes programmées** (ex. tous les matins à 7 h, la pluie prévue sur 12 h).

## Sources de données (gratuites, sans clé)

| Donnée | Source | Conditions |
|---|---|---|
| Prévision de pluie (15 min et horaire) | Modèles **Météo-France AROME / ARPEGE** via [Open-Meteo](https://open-meteo.com/en/docs/meteofrance-api) | Gratuit pour un usage non commercial, attribution CC BY 4.0 |
| Radar observé (2 dernières heures) | [RainViewer](https://www.rainviewer.com/api.html) | Usage personnel/éducatif, zoom max 7, 100 requêtes/min |
| Recherche de ville | Open-Meteo Geocoding | Gratuit |
| Nom de la ville depuis le GPS | BigDataCloud (reverse geocode client) | Gratuit côté navigateur |
| Fond de carte | © OpenStreetMap, © CARTO | Attribution |

Intensités utilisées : faible < 2,5 mm/h, modérée 2,5 à 7,6 mm/h, forte > 7,6 mm/h (en dessous de 0,2 mm/h : sec).

Piste d'amélioration : le radar réel de Météo-France (« Paquet Radar », gratuit avec un compte sur le portail API de Météo-France) est plus précis que RainViewer, mais il demande une conversion des fichiers côté serveur.

## Mettre l'appli en ligne (GitHub Pages)

1. Le dépôt doit être **public** (GitHub Pages est gratuit uniquement pour les dépôts publics ; aucune donnée personnelle n'est dans le code).
2. *Settings → Pages → Build and deployment* : **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. L'appli est alors disponible sur `https://mrteliot38.github.io/rain_prevision/`.
4. Sur le téléphone, ouvre l'adresse dans Chrome, menu ⋮ → **Ajouter à l'écran d'accueil** (ou « Installer l'application »).

## Application Android (APK)

À chaque modification de l'appli, GitHub fabrique automatiquement un APK (workflow « APK Android ») et le publie dans **Releases**.

- Lien direct vers la dernière version : <https://github.com/MrTeliot38/rain_prevision/releases/latest/download/PluieEnVue.apk>
- Sur le téléphone : ouvre le lien, télécharge, puis ouvre le fichier. Android demande d'autoriser l'installation depuis Chrome (ou depuis l'appli Fichiers) : accepte pour cette fois.
- L'APK utilise le GPS et les notifications natives d'Android. Les alertes appli fermée passent toujours par ntfy.

**Mises à jour.** Par défaut, l'APK est signé avec une clé de test qui change à chaque fabrication : pour installer une nouvelle version, il faut d'abord désinstaller l'ancienne (le lieu et les alertes sont à refaire). Pour pouvoir installer les mises à jour par-dessus, ajoute une clé de signature à toi dans les secrets du dépôt :

1. Sur un ordinateur avec Java, crée la clé (garde le fichier et le mot de passe précieusement, hors du dépôt) :
   `keytool -genkeypair -keystore pluie.keystore -storetype PKCS12 -alias pluie -keyalg RSA -keysize 2048 -validity 10000`
2. Convertis-la en texte (Windows PowerShell) :
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("pluie.keystore")) | Set-Clipboard`
3. Secrets du dépôt : `ANDROID_KEYSTORE` (le texte copié) et `ANDROID_KEYSTORE_PASSWORD` (le mot de passe).
4. Désinstalle une dernière fois l'appli, puis installe la nouvelle version : les suivantes s'installeront par-dessus.

## Alertes téléphone verrouillé (ntfy + GitHub Actions)

Dans l'appli, les alertes ne fonctionnent que quand elle est ouverte. Pour les recevoir à tout moment :

1. Installe l'appli **ntfy** (Play Store ou F-Droid), touche **+** et abonne-toi à un sujet au nom difficile à deviner, par exemple `pluie-kevin-7f3k9q`.
2. Dans le dépôt : *Settings → Secrets and variables → Actions* :
   - onglet **Secrets** : `LATITUDE` (ex. `43.1748`), `LONGITUDE` (ex. `5.6046`), `NTFY_TOPIC` (le nom du sujet) ;
   - onglet **Variables** (facultatif) : `LIEU_NOM` (ex. `La Ciotat`).
3. Règle les alertes dans `alertes/config.json` (le bouton « Copier la configuration » de l'onglet Alertes de l'appli génère le contenu à coller).
4. Test : *Actions → Alertes pluie → Run workflow*, en indiquant `Matin` dans le champ pour recevoir tout de suite l'alerte programmée « Matin ».

Le service vérifie la prévision **toutes les 10 minutes**. GitHub peut retarder une exécution de quelques minutes : une alerte « d'ici 30 min » peut donc arriver 15 à 20 min avant la pluie. GitHub met en pause les tâches planifiées d'un dépôt public après 60 jours sans activité : un e-mail prévient, et un clic suffit pour relancer.

### Format de `alertes/config.json`

```json
{
  "alerte_imminente": { "active": true, "avance_minutes": 30, "seuil": "faible" },
  "alertes_programmees": [
    { "nom": "Matin", "heure": "07:00", "jours": ["lun","mar","mer","jeu","ven"],
      "horizon_heures": 12, "seuil": "faible", "si_sec": true }
  ]
}
```

- `seuil` : `faible`, `moderee` ou `forte` (intensité minimale qui déclenche l'alerte).
- `horizon_heures` : 1, 2, 4, 12 ou 24.
- `si_sec` : envoyer aussi l'alerte programmée quand aucune pluie n'est prévue.

### Tester le script sur un ordinateur

```bash
set LATITUDE=43.1748
set LONGITUDE=5.6046
python alertes/alertes.py --essai --forcer Matin
```

`--essai` affiche les messages au lieu de les envoyer.

## Structure

```
index.html, css/, js/          appli web (aucune compilation nécessaire)
sw.js, manifest.webmanifest    installation sur le téléphone, ouverture hors connexion
vendor/leaflet/                bibliothèque de carte Leaflet 1.9.4 (licence BSD-2)
alertes/                       script d'alertes ntfy, configuration et état
.github/workflows/alertes.yml  exécution planifiée toutes les 10 minutes
```
