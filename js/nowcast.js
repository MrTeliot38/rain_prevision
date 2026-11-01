// Prévision immédiate par radar (« nowcasting ») :
// 1. on lit les dernières images radar observées (RainViewer, toutes les 10 min) autour du lieu ;
// 2. on décode la réflectivité (dBZ) de chaque pixel, convertie en intensité de pluie (mm/h) ;
// 3. on estime le déplacement des zones de pluie entre les images ;
// 4. on prolonge ce déplacement sur 2 h pour savoir quand la pluie arrive sur le lieu.
// Les modèles météo ratent souvent les pluies faibles ou localisées : le radar, lui, les voit.

const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';
const ZOOM = 7; // zoom maximal servi par RainViewer (~0,9 km par pixel en France)
const PAS_MIN = 10; // une image radar toutes les 10 minutes
const HORIZON_MIN = 120;
const DBZ_MIN = 10; // en dessous : bruit, échos parasites (≈ 0,15 mm/h)

// Palette « Universal Blue » de RainViewer (couleur RGBA → dBZ), pluie puis neige.
const PALETTE_PLUIE = '10:cec08796 11:d2c48ba0 12:d6c88faa 13:dacc93b4 14:ded097be 15:88ddeeff 16:6cd1ebff 17:51c5e8ff 18:36bae5ff 19:1baee2ff 20:00a3e0ff 21:009ad5ff 22:0091caff 23:0088bfff 24:007fb4ff 25:0077aaff 26:0070a3ff 27:00699cff 28:006295ff 29:005b8eff 30:005588ff 31:005180ff 32:004e78ff 33:004a70ff 34:004768ff 35:ffee00ff 36:ffe000ff 37:ffd200ff 38:ffc500ff 39:ffb700ff 40:ffaa00ff 41:ff9f00ff 42:ff9500ff 43:ff8b00ff 44:ff8100ff 45:ff4400ff 46:f23600ff 47:e62800ff 48:d91b00ff 49:cd0d00ff 50:c10000ff 51:a80000ff 52:8f0000ff 53:760000ff 54:5d0000ff 55:ffaaffff 60:ff77ffff 65:ffffffff';
const PALETTE_NEIGE = '10:bfffffff 12:b2f2ffff 14:a5e5ffff 16:98d8ffff 18:8bcbffff 20:7fbfffff 22:72b2ffff 24:65a5ffff 26:5b9bffff 28:5595ffff 30:4f8fffff 32:4888ffff 34:4282ffff 36:3b7bffff 38:3575ffff 40:2f6fffff 45:1f5fffff 50:0f4fffff 55:003fffff 60:002fffff';
// les couleurs sous 10 dBZ (beige très transparent) sont volontairement absentes : elles comptent comme « sec »
const PALETTE_FAIBLE = '-10:63615914 -5:726e612e 0:827b6949 5:92887164 7:aa9e7978 9:c2b4828c';

function lirePalette(texte) {
  return texte.split(' ').map((e) => {
    const [d, h] = e.split(':');
    return { dbz: +d, c: [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16)) };
  });
}
const COULEURS = [...lirePalette(PALETTE_PLUIE), ...lirePalette(PALETTE_NEIGE), ...lirePalette(PALETTE_FAIBLE)];

// Réflectivité → intensité (relation de Marshall-Palmer Z = 200 R^1,6)
export function tauxDepuisDbz(dbz) {
  if (dbz < DBZ_MIN) return 0;
  return Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6);
}

const cache = new Map();
function dbzDepuisCouleur(r, g, b, a) {
  if (a < 10) return -99;
  const cle = (r << 24) | (g << 16) | (b << 8) | a;
  if (cache.has(cle)) return cache.get(cle);
  let meilleur = -99;
  let ecart = Infinity;
  for (const { dbz, c } of COULEURS) {
    const e = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 + 2 * (c[3] - a) ** 2;
    if (e < ecart) {
      ecart = e;
      meilleur = dbz;
    }
  }
  cache.set(cle, meilleur);
  return meilleur;
}

function versTuile(lat, lon) {
  const n = 2 ** ZOOM;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

function versLatLon(x, y) {
  const n = 2 ** ZOOM;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lon };
}

function chargerImage(url) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error('image radar indisponible'));
    img.src = url;
  });
}

// Fenêtre de 2×2 tuiles (512×512 px, ~450 km) autour du lieu, réduite de moitié (256×256, ~1,8 km/px).
const TAILLE = 256;
async function chargerFenetre(hote, chemin, tx0, ty0) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await Promise.all(
    [[0, 0], [1, 0], [0, 1], [1, 1]].map(async ([dx, dy]) => {
      const img = await chargerImage(`${hote}${chemin}/256/${ZOOM}/${tx0 + dx}/${ty0 + dy}/2/0_1.png`);
      ctx.drawImage(img, dx * 256, dy * 256);
    })
  );
  const px = ctx.getImageData(0, 0, 512, 512).data;
  const taux = new Float32Array(TAILLE * TAILLE);
  for (let y = 0; y < TAILLE; y++) {
    for (let x = 0; x < TAILLE; x++) {
      // maximum des 4 pixels d'origine : on garde les petites cellules de pluie
      let m = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = ((2 * y + oy) * 512 + 2 * x + ox) * 4;
        m = Math.max(m, tauxDepuisDbz(dbzDepuisCouleur(px[k], px[k + 1], px[k + 2], px[k + 3])));
      }
      taux[y * TAILLE + x] = m;
    }
  }
  return taux;
}

// Déplacement (en pixels réduits par pas de 10 min) qui fait le mieux coïncider deux images.
function deplacement(avant, apres, cxf, cyf) {
  const cx = Math.round(cxf), cy = Math.round(cyf);
  const R = 70; // zone d'analyse : ~250 km autour du lieu
  const MAX = 7; // jusqu'à ~75 km/h
  const x0 = Math.max(MAX, cx - R), x1 = Math.min(TAILLE - MAX, cx + R);
  const y0 = Math.max(MAX, cy - R), y1 = Math.min(TAILLE - MAX, cy + R);
  let pluie = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (apres[y * TAILLE + x] > 0) pluie++;
  if (pluie < 40) return null; // trop peu de pluie pour mesurer un mouvement
  let meilleur = null;
  for (let dy = -MAX; dy <= MAX; dy++) {
    for (let dx = -MAX; dx <= MAX; dx++) {
      let s = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const a = apres[y * TAILLE + x];
          const b = avant[(y - dy) * TAILLE + (x - dx)];
          if (a || b) s += Math.abs(a - b);
        }
      }
      if (!meilleur || s < meilleur.s) meilleur = { s, dx, dy };
    }
  }
  return meilleur;
}

function echantillon(taux, x, y) {
  // moyenne et maximum sur ~5 km autour du point
  const xi = Math.round(x), yi = Math.round(y);
  let somme = 0, max = 0, n = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const xx = xi + i, yy = yi + j;
      if (xx < 0 || yy < 0 || xx >= TAILLE || yy >= TAILLE) continue;
      const v = taux[yy * TAILLE + xx];
      somme += v;
      max = Math.max(max, v);
      n++;
    }
  }
  return n ? (somme / n + max) / 2 : 0;
}

export async function prevoirParRadar(lat, lon) {
  const meta = await fetch(RAINVIEWER).then((r) => {
    if (!r.ok) throw new Error('radar indisponible');
    return r.json();
  });
  const images = (meta.radar?.past || []).slice(-3);
  if (!images.length) throw new Error('aucune image radar');
  const t = versTuile(lat, lon);
  const tx0 = Math.floor(t.x - 0.5), ty0 = Math.floor(t.y - 0.5);
  const cx = ((t.x - tx0) * 256) / 2, cy = ((t.y - ty0) * 256) / 2;
  const champs = await Promise.all(images.map((im) => chargerFenetre(meta.host, im.path, tx0, ty0)));
  const dernier = champs[champs.length - 1];
  const t0 = images[images.length - 1].time * 1000;

  // mouvement moyen entre les images successives
  const mouvements = [];
  for (let i = 1; i < champs.length; i++) {
    const m = deplacement(champs[i - 1], champs[i], cx, cy);
    if (m) mouvements.push(m);
  }
  const vx = mouvements.length ? mouvements.reduce((s, m) => s + m.dx, 0) / mouvements.length : 0;
  const vy = mouvements.length ? mouvements.reduce((s, m) => s + m.dy, 0) / mouvements.length : 0;

  // ce qui arrive sur le lieu : on remonte le courant (persistance lagrangienne)
  const pas = [];
  pas.push({ debut: t0 - PAS_MIN * 60000, fin: t0, taux: echantillon(dernier, cx, cy), observe: true });
  for (let k = 1; k <= HORIZON_MIN / PAS_MIN; k++) {
    const kk = k - 0.5;
    pas.push({
      debut: t0 + (k - 1) * PAS_MIN * 60000,
      fin: t0 + k * PAS_MIN * 60000,
      taux: echantillon(dernier, cx - vx * kk, cy - vy * kk),
      observe: false,
    });
  }

  const kmParPx = (2 * 40075 * Math.cos((lat * Math.PI) / 180)) / (2 ** ZOOM * 256);
  const coin = versLatLon(tx0, ty0);
  const coinOppose = versLatLon(tx0 + 2, ty0 + 2);
  return {
    t0,
    observeMaintenant: pas[0].taux,
    pas,
    vitesseKmH: Math.round((Math.hypot(vx, vy) * kmParPx * 60) / PAS_MIN),
    // pour l'animation : dernière image et déplacement en degrés par 10 min
    champ: dernier,
    taille: TAILLE,
    bornes: { nord: coin.lat, ouest: coin.lon, sud: coinOppose.lat, est: coinOppose.lon },
    vitesse: { vx, vy },
    fiable: mouvements.length > 0,
  };
}

// Intensité radar à l'instant t (interpolée entre les pas de 10 min).
function tauxRadarA(radar, t) {
  const p = radar.pas.find((x) => t >= x.debut && t < x.fin);
  return p ? p.taux : null;
}

// Fusion : radar seul jusqu'à 1 h, mélange radar/modèle entre 1 h et 2 h, modèle ensuite.
export function fusionner(quartsModele, radar, maintenant = Date.now()) {
  if (!radar) return quartsModele;
  return quartsModele.map((p) => {
    if (p.fin <= maintenant) return p;
    const milieu = (p.debut + p.fin) / 2;
    const r = tauxRadarA(radar, Math.max(milieu, maintenant));
    if (r == null) return p;
    const delai = (milieu - maintenant) / 60000;
    const w = delai <= 60 ? 1 : delai >= 120 ? 0 : 1 - (delai - 60) / 60;
    if (w === 0) return p;
    const tauxModele = p.taux ?? 0;
    const taux = w * r + (1 - w) * tauxModele;
    return { ...p, taux, mm: (taux * p.duree) / 60, source: w === 1 ? 'radar' : 'mixte' };
  });
}
