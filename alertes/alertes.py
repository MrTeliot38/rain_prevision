#!/usr/bin/env python3
"""Alertes pluie envoyées sur le téléphone via ntfy (https://ntfy.sh).

Lancé toutes les 10 minutes par GitHub Actions (voir .github/workflows/alertes.yml).

Variables d'environnement (secrets du dépôt) :
  LATITUDE, LONGITUDE   position à surveiller
  NTFY_TOPIC            nom du « sujet » ntfy auquel le téléphone est abonné
  NTFY_SERVEUR          facultatif, https://ntfy.sh par défaut
  LIEU_NOM              facultatif, nom affiché dans les messages

Options :
  --essai                 affiche les messages au lieu de les envoyer
  --simulation F.json     utilise une réponse Open-Meteo enregistrée au lieu du réseau
  --maintenant ISO        fixe l'heure courante (tests)
  --forcer NOM            envoie tout de suite l'alerte programmée NOM (test)
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DOSSIER = Path(__file__).resolve().parent
CONFIG = DOSSIER / "config.json"
ETAT = DOSSIER / "etat.json"
FUSEAU = ZoneInfo("Europe/Paris")
API = "https://api.open-meteo.com/v1/meteofrance"

NIVEAUX = ["sec", "faible", "moderee", "forte"]
LIBELLES = {"sec": "sec", "faible": "faible", "moderee": "modérée", "forte": "forte"}
JOURS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]


def niveau(taux):
    if taux is None or taux < 0.2:
        return "sec"
    if taux < 2.5:
        return "faible"
    if taux < 7.6:
        return "moderee"
    return "forte"


def rang(n):
    return NIVEAUX.index(n)


# ---------------------------------------------------------------- données
def charger(lat, lon, simulation=None):
    if simulation:
        return json.loads(Path(simulation).read_text(encoding="utf-8"))
    params = urllib.parse.urlencode({
        "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}",
        "minutely_15": "precipitation", "hourly": "precipitation",
        "forecast_minutely_15": 32, "past_minutely_15": 1,
        "forecast_hours": 26, "past_hours": 1,
        "timeformat": "unixtime", "timezone": "GMT",
    })
    with urllib.request.urlopen(f"{API}?{params}", timeout=30) as rep:
        return json.load(rep)


def serie(bloc, duree_min):
    pas = []
    if not bloc:
        return pas
    for t, mm in zip(bloc["time"], bloc["precipitation"]):
        fin = datetime.fromtimestamp(t, timezone.utc)
        pas.append({
            "debut": fin - timedelta(minutes=duree_min), "fin": fin, "duree": duree_min,
            "mm": mm, "taux": None if mm is None else mm * 60 / duree_min,
        })
    return pas


def resumer(quarts, heures, maintenant, nb_heures):
    """Pluie entre maintenant et maintenant + nb_heures (quart d'heure puis horaire)."""
    limite = maintenant + timedelta(hours=nb_heures)
    q = [p for p in quarts if p["fin"] > maintenant and p["debut"] < limite and p["mm"] is not None]
    couverture = q[-1]["fin"] if q else maintenant
    h = [p for p in heures if p["fin"] > couverture and p["debut"] < limite and p["mm"] is not None]
    total, taux_max, premier, dernier = 0.0, 0.0, None, None
    for p in q + h:
        debut = max(p["debut"], maintenant, couverture if p["duree"] == 60 else p["debut"])
        fin = min(p["fin"], limite)
        part = max(0.0, (fin - debut) / (p["fin"] - p["debut"]))
        total += p["mm"] * part
        if niveau(p["taux"]) != "sec":
            premier = premier or p
            dernier = p
            taux_max = max(taux_max, p["taux"])
    return {
        "total": round(total, 1), "niveau": niveau(taux_max),
        "debut": max(premier["debut"], maintenant) if premier else None,
        "fin": min(dernier["fin"], limite) if dernier else None,
    }


def prochaine_pluie(quarts, seuil, maintenant, dans_heures=2):
    limite = maintenant + timedelta(hours=dans_heures)
    pas = [p for p in quarts if p["fin"] > maintenant and p["debut"] < limite and p["mm"] is not None]
    for i, p in enumerate(pas):
        if rang(niveau(p["taux"])) >= rang(seuil):
            j, taux_max, total = i, p["taux"], 0.0
            while j < len(pas) and niveau(pas[j]["taux"]) != "sec":
                taux_max = max(taux_max, pas[j]["taux"])
                total += pas[j]["mm"]
                j += 1
            debut = max(p["debut"], maintenant)
            return {
                "debut": debut, "fin": pas[j - 1]["fin"], "en_cours": p["debut"] <= maintenant,
                "dans_min": max(0, round((debut - maintenant).total_seconds() / 60)),
                "niveau": niveau(taux_max), "total": round(total, 1),
            }
    return None


# ---------------------------------------------------------------- textes
def hhmm(dt):
    return dt.astimezone(FUSEAU).strftime("%Hh%M")


def mm(v):
    return f"{v:.1f}".replace(".", ",") + " mm"


def duree(minutes):
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    return f"{h} h {m:02d}" if m else f"{h} h"


def message_imminent(p, lieu):
    quand = "en cours" if p["en_cours"] else f"d'ici {duree(p['dans_min'])}"
    titre = f"Attention : pluie {LIBELLES[p['niveau']]} {quand}"
    corps = f"{lieu} : vers {hhmm(p['debut'])}, environ {mm(p['total'])} jusqu'à {hhmm(p['fin'])}."
    return titre, corps


def message_programme(alerte, quarts, heures, maintenant, lieu):
    n = alerte["horizon_heures"]
    r = resumer(quarts, heures, maintenant, n)
    detail = " · ".join(
        f"{h} h : {'sec' if (x := resumer(quarts, heures, maintenant, h))['niveau'] == 'sec' else mm(x['total'])}"
        for h in (1, 2, 4, 12, 24) if h <= n
    )
    if rang(r["niveau"]) >= rang(alerte.get("seuil", "faible")):
        titre = f"{alerte['nom']} : pluie {LIBELLES[r['niveau']]} prévue"
        corps = (f"{lieu} : pluie dès {hhmm(r['debut'])}, environ {mm(r['total'])} "
                 f"sur les {n} prochaines heures (jusqu'à {hhmm(r['fin'])}).\n{detail}")
        return titre, corps
    if not alerte.get("si_sec", True):
        return None
    titre = f"{alerte['nom']} : pas de pluie prévue"
    corps = f"{lieu} : rien de notable sur les {n} prochaines heures."
    if r["niveau"] != "sec":
        corps += f" Tout au plus une pluie {LIBELLES[r['niveau']]} ({mm(r['total'])})."
    return titre, corps


# ---------------------------------------------------------------- envoi
def envoyer(titre, corps, priorite, essai):
    if essai:
        print(f"[essai] {titre}\n        {corps}\n")
        return
    serveur = os.environ.get("NTFY_SERVEUR", "https://ntfy.sh").rstrip("/")
    donnees = json.dumps({
        "topic": os.environ["NTFY_TOPIC"], "title": titre, "message": corps,
        "priority": priorite, "tags": ["umbrella"],
    }).encode("utf-8")
    req = urllib.request.Request(serveur, data=donnees, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as rep:
        rep.read()
    print(f"Envoyé : {titre}")


def lire_json(chemin, defaut):
    try:
        return json.loads(chemin.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return defaut


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--essai", action="store_true")
    ap.add_argument("--simulation")
    ap.add_argument("--maintenant")
    ap.add_argument("--forcer")
    args = ap.parse_args()

    try:
        lat = float(os.environ["LATITUDE"].replace(",", "."))
        lon = float(os.environ["LONGITUDE"].replace(",", "."))
    except (KeyError, ValueError):
        print("Secrets LATITUDE / LONGITUDE absents : rien à faire (voir le README).")
        return 0
    if not args.essai and not os.environ.get("NTFY_TOPIC"):
        print("Secret NTFY_TOPIC absent : rien à faire (voir le README).")
        return 0

    config = lire_json(CONFIG, {})
    etat = lire_json(ETAT, {})
    lieu = os.environ.get("LIEU_NOM") or "Ton lieu"
    maintenant = (datetime.fromisoformat(args.maintenant).astimezone(timezone.utc)
                  if args.maintenant else datetime.now(timezone.utc))
    local = maintenant.astimezone(FUSEAU)

    donnees = charger(lat, lon, args.simulation)
    quarts = serie(donnees.get("minutely_15"), 15)
    heures = serie(donnees.get("hourly"), 60)
    modifie = False

    # 1. pluie imminente
    imm = config.get("alerte_imminente", {})
    if imm.get("active"):
        p = prochaine_pluie(quarts, imm.get("seuil", "faible"), maintenant)
        avance = timedelta(minutes=int(imm.get("avance_minutes", 30)))
        derniere = etat.get("derniere_imminente")
        deja = derniere and maintenant - datetime.fromisoformat(derniere) < timedelta(minutes=90)
        if p and p["debut"] - maintenant <= avance and not deja:
            titre, corps = message_imminent(p, lieu)
            envoyer(titre, corps, 5 if p["niveau"] == "forte" else 4, args.essai)
            etat["derniere_imminente"] = maintenant.isoformat()
            modifie = True

    # 2. alertes programmées
    deja_envoyees = etat.setdefault("programmees", {})
    for alerte in config.get("alertes_programmees", []):
        nom = alerte.get("nom", "Alerte")
        h, m = (int(x) for x in alerte.get("heure", "07:00").split(":"))
        prevue = local.replace(hour=h, minute=m, second=0, microsecond=0)
        aujourdhui = local.date().isoformat()
        a_faire = (
            JOURS[local.weekday()] in alerte.get("jours", JOURS)
            and timedelta(0) <= local - prevue < timedelta(minutes=90)
            and deja_envoyees.get(nom) != aujourdhui
        )
        if a_faire or args.forcer == nom:
            msg = message_programme(alerte, quarts, heures, maintenant, lieu)
            if msg:
                envoyer(*msg, 3, args.essai)
            deja_envoyees[nom] = aujourdhui
            modifie = True

    if modifie and not args.essai:
        ETAT.write_text(json.dumps(etat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if not modifie:
        print(f"{local:%d/%m %H:%M} : aucune alerte à envoyer.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
