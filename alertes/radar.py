"""Prévision immédiate par radar (même méthode que js/nowcast.js).

Dernières images RainViewer → intensité (mm/h) → déplacement des pluies → extrapolation sur 2 h.
Nécessite numpy et Pillow (installés par le workflow).
"""
import io
import json
import math
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json"
ZOOM = 7
PAS_MIN = 10
HORIZON_MIN = 120
DBZ_MIN = 10
TAILLE = 256

PALETTE = (
    "10:cec08796 11:d2c48ba0 12:d6c88faa 13:dacc93b4 14:ded097be 15:88ddeeff 16:6cd1ebff 17:51c5e8ff "
    "18:36bae5ff 19:1baee2ff 20:00a3e0ff 21:009ad5ff 22:0091caff 23:0088bfff 24:007fb4ff 25:0077aaff "
    "26:0070a3ff 27:00699cff 28:006295ff 29:005b8eff 30:005588ff 31:005180ff 32:004e78ff 33:004a70ff "
    "34:004768ff 35:ffee00ff 36:ffe000ff 37:ffd200ff 38:ffc500ff 39:ffb700ff 40:ffaa00ff 41:ff9f00ff "
    "42:ff9500ff 43:ff8b00ff 44:ff8100ff 45:ff4400ff 46:f23600ff 47:e62800ff 48:d91b00ff 49:cd0d00ff "
    "50:c10000ff 51:a80000ff 52:8f0000ff 53:760000ff 54:5d0000ff 55:ffaaffff 60:ff77ffff 65:ffffffff "
    # neige
    "10:bfffffff 12:b2f2ffff 14:a5e5ffff 16:98d8ffff 18:8bcbffff 20:7fbfffff 22:72b2ffff 24:65a5ffff "
    "26:5b9bffff 28:5595ffff 30:4f8fffff 32:4888ffff 34:4282ffff 36:3b7bffff 38:3575ffff 40:2f6fffff "
    "45:1f5fffff 50:0f4fffff 55:003fffff 60:002fffff "
    # échos très faibles (comptés comme secs)
    "-10:63615914 -5:726e612e 0:827b6949 5:92887164 7:aa9e7978 9:c2b4828c"
)
_COUL = [(int(d), [int(h[i:i + 2], 16) for i in (0, 2, 4, 6)]) for d, h in (e.split(":") for e in PALETTE.split())]
_DBZ = np.array([d for d, _ in _COUL], dtype=float)
_RGBA = np.array([c for _, c in _COUL], dtype=float)


def _taux_depuis_dbz(dbz):
    t = np.power(np.power(10.0, dbz / 10) / 200, 1 / 1.6)
    return np.where(dbz >= DBZ_MIN, t, 0.0)


def _decoder(rgba):
    """Image RGBA (H×W×4) → intensité mm/h."""
    plat = rgba.reshape(-1, 4).astype(int)
    cles = (plat[:, 0] << 24) | (plat[:, 1] << 16) | (plat[:, 2] << 8) | plat[:, 3]
    uniques, inverse = np.unique(cles, return_inverse=True)
    couleurs = np.stack([(uniques >> s) & 255 for s in (24, 16, 8, 0)], axis=1).astype(float)
    ecart = ((couleurs[:, None, :3] - _RGBA[None, :, :3]) ** 2).sum(-1) + 2 * (couleurs[:, None, 3] - _RGBA[None, :, 3]) ** 2
    dbz = _DBZ[ecart.argmin(1)]
    dbz[couleurs[:, 3] < 10] = -99
    return _taux_depuis_dbz(dbz)[inverse].reshape(rgba.shape[:2])


def _lire(url):
    with urllib.request.urlopen(url, timeout=20) as rep:
        return rep.read()


def _tuile(lat, lon):
    n = 2 ** ZOOM
    r = math.radians(lat)
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n


def _fenetre(hote, chemin, tx0, ty0):
    img = np.zeros((512, 512, 4), dtype=np.uint8)
    for dx in (0, 1):
        for dy in (0, 1):
            url = f"{hote}{chemin}/256/{ZOOM}/{tx0 + dx}/{ty0 + dy}/2/0_1.png"
            tuile = Image.open(io.BytesIO(_lire(url))).convert("RGBA")
            img[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = np.asarray(tuile)
    taux = _decoder(img)
    return taux.reshape(TAILLE, 2, TAILLE, 2).max(axis=(1, 3))  # réduction ×2 en gardant le maximum


def _deplacement(avant, apres, cx, cy, r=70, maxi=7):
    x0, x1 = max(maxi, cx - r), min(TAILLE - maxi, cx + r)
    y0, y1 = max(maxi, cy - r), min(TAILLE - maxi, cy + r)
    a = apres[y0:y1:2, x0:x1:2]
    if (a > 0).sum() < 10:
        return None
    meilleur = None
    for dy in range(-maxi, maxi + 1):
        for dx in range(-maxi, maxi + 1):
            b = avant[y0 - dy:y1 - dy:2, x0 - dx:x1 - dx:2]
            s = np.abs(a - b).sum()
            if meilleur is None or s < meilleur[0]:
                meilleur = (s, dx, dy)
    return meilleur[1], meilleur[2]


def _echantillon(champ, x, y):
    xi, yi = int(round(x)), int(round(y))
    zone = champ[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2]
    return float((zone.mean() + zone.max()) / 2) if zone.size else 0.0


def prevoir(lat, lon):
    with urllib.request.urlopen(RAINVIEWER, timeout=20) as rep:
        meta = json.load(rep)
    images = meta["radar"]["past"][-3:]
    x, y = _tuile(lat, lon)
    tx0, ty0 = math.floor(x - 0.5), math.floor(y - 0.5)
    cx, cy = (x - tx0) * 128, (y - ty0) * 128
    champs = [_fenetre(meta["host"], im["path"], tx0, ty0) for im in images]
    mouvements = [m for m in (_deplacement(champs[i - 1], champs[i], round(cx), round(cy)) for i in range(1, len(champs))) if m]
    vx = sum(m[0] for m in mouvements) / len(mouvements) if mouvements else 0.0
    vy = sum(m[1] for m in mouvements) / len(mouvements) if mouvements else 0.0
    t0 = datetime.fromtimestamp(images[-1]["time"], timezone.utc)
    dernier = champs[-1]
    pas = [{"debut": t0 - timedelta(minutes=PAS_MIN), "fin": t0, "taux": _echantillon(dernier, cx, cy)}]
    for k in range(1, HORIZON_MIN // PAS_MIN + 1):
        kk = k - 0.5
        pas.append({
            "debut": t0 + timedelta(minutes=(k - 1) * PAS_MIN),
            "fin": t0 + timedelta(minutes=k * PAS_MIN),
            "taux": _echantillon(dernier, cx - vx * kk, cy - vy * kk),
        })
    return {"t0": t0, "pas": pas, "fiable": bool(mouvements)}


def fusionner(quarts, radar, maintenant):
    """Radar seul jusqu'à 1 h, mélange jusqu'à 2 h, modèle ensuite."""
    if not radar:
        return quarts
    resultat = []
    for p in quarts:
        if p["fin"] <= maintenant or p["mm"] is None:
            resultat.append(p)
            continue
        milieu = max(p["debut"] + (p["fin"] - p["debut"]) / 2, maintenant)
        r = next((x["taux"] for x in radar["pas"] if x["debut"] <= milieu < x["fin"]), None)
        delai = (milieu - maintenant).total_seconds() / 60
        w = 1.0 if delai <= 60 else 0.0 if delai >= 120 else 1 - (delai - 60) / 60
        if r is None or w == 0:
            resultat.append(p)
            continue
        taux = w * r + (1 - w) * (p["taux"] or 0)
        resultat.append({**p, "taux": taux, "mm": taux * p["duree"] / 60})
    return resultat
