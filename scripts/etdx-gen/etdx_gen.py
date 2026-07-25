#!/usr/bin/env python3
"""
etdx_gen v2 — Epson Print Layout Editor (.etdx) üretici. Milimetrik.

KOORDİNAT MODELİ (paperSizeList'ten çözüldü, Letter/Legal'da tam tutuyor):
  1 birim = 1/360 inç  ->  14.173228 birim/mm
  tuval  = [kağıt_mm_w * u + 72, kağıt_mm_h * u + 112]   (taşma payı dahil)
  kağıt alanı: sol/sağ 36 birim, üst 42, alt 70 içeride
  => kağıdın merkezi tuval merkezi DEĞİL, (0, -14) birimdir.

photos[].center = fotoğrafın merkezi (tuval koordinatı)
photos[].scale  = piksel -> birim çarpanı   (baskı_mm = px * scale / u)
photos[].angle  = 90 -> portre görsel yatay basılır (en/boy yer değiştirir)
photos[].crop   = [x0,y0,x1,y1] dahil piksel; hücre oranına doldurarak kırpar
"""

from fractions import Fraction
import json
import os
import random
import string
import shutil
import struct
import sys
import zipfile

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template")
U = 360 / 25.4                      # birim/mm
BLEED = {"l": 36, "r": 36, "t": 42, "b": 70}

PAPER_MM = {
    "A4": (210, 297), "A3": (297, 420), "A5": (148, 210), "A2": (420, 594),
    "LB": (89, 127), "2L": (127, 178), "HG": (100, 148), "KG": (102, 152.4),
    "LT": (215.9, 279.4), "LG": (215.9, 355.6), "CA": (54, 86),
}


def rid(n=10):
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(n))


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"PNG değil: {path}")
    return struct.unpack(">II", head[16:24])


def paper_rect(size):
    """Tuval koordinatında kağıdın sol/üst/sağ/alt kenarı (birim)."""
    W, H = size
    return (-W / 2 + BLEED["l"], -H / 2 + BLEED["t"],
            W / 2 - BLEED["r"], H / 2 - BLEED["b"])


def make_photo(img, cell_w_mm, cell_h_mm, left_mm, top_mm, rect, z):
    """left_mm/top_mm = kağıdın sol-üst köşesine göre fotoğrafın sol-üst köşesi."""
    w, h = png_size(img)
    cw, ch = cell_w_mm * U, cell_h_mm * U          # baskı ölçüsü, birim
    rotate = (h >= w) != (cell_h_mm > cell_w_mm)   # portre görsel + yatay hücre

    # Hücreyi doldur, taşanı kırp (Epson'ın yaptığı: crop-to-fill).
    # Kırpma tam piksel olmak zorunda; oran kaba yuvarlanırsa tek scale iki
    # ekseni birden tam tutturamaz ve baskı ölçüsü ~0.03 mm kayar. Epson
    # arayüzü mm'i YUKARI yuvarladığı için 100.8034 -> "100.9" görünüyor.
    # Çözüm: hedef oranı, görsele sığan en iyi tamsayı kesire (p/q) oturt —
    # o zaman nw/nh oranı tam, iki eksen de tam mm çıkar.
    # Çözüm: hedefe en yakın tamsayı kırpmayı ARA — ama görselden en fazla
    # %5 feda ederek. (Kesir yaklaşımı (Fraction) tek başına tuzak: 182/239
    # gibi bir orana düşüp görselin %66'sını kullanıyor, kadraj kesiliyor.)
    want = (ch / cw) if rotate else (cw / ch)      # piksel-uzayında nw/nh hedefi
    best, best_err = None, None
    if w / h > want:                                # genişlikten kırpılacak
        cand = ((round(nh * want), nh) for nh in range(h, int(h * 0.95), -1))
    else:                                           # yükseklikten kırpılacak
        cand = ((nw, round(nw / want)) for nw in range(w, int(w * 0.95), -1))
    for nw, nh in cand:
        if not (1 <= nw <= w and 1 <= nh <= h):
            continue
        got = (cw * nw / nh) if rotate else (cw * nh / nw)   # oluşan yükseklik
        err = abs(got - ch) / U                              # mm cinsinden
        if best_err is None or err < best_err:
            best, best_err = (nw, nh), err
        if err <= 0.005:                            # ekranda görünmez: yeter
            break
    nw, nh = best
    x0, y0 = (w - nw) // 2, (h - nh) // 2
    scale = (cw / nh) if rotate else (cw / nw)      # genişlik her hâlükârda tam

    px0, py0 = rect[0], rect[1]
    return {
        "imagepath": None,                          # çağıran dolduruyor
        "originalsize": [w, h],
        "center": [round(px0 + (left_mm + cell_w_mm / 2) * U, 4),
                   round(py0 + (top_mm + cell_h_mm / 2) * U, 4)],
        "angle": 90.0 if rotate else 0.0,
        "scale": round(scale, 7),
        "crop": {"type": 1, "rect": [x0, y0, x0 + nw - 1, y0 + nh - 1]},
        "apfInfo": {"mode": "standard", "level": 5},
        "workSpaceNumber": 1,
        "zindex": z,
    }


# Olcay'ın kullandığı A4 düzeni — Epson'da elle kurulup onaylandı, varsayılan bu.
DUZEN = dict(paper="A4", photo_mm=(100.80, 76.76), cols=2, rows=3,
             gap_mm=(1.70, 17.2278), origin_mm=(3.50, 12.9878))


def build(images, out_path, paper="A4", photo_mm=(100.80, 76.76), cols=2, rows=3,
          gap_mm=(1.70, 17.2278), origin_mm=(3.50, 12.9878),
          template_dir=TEMPLATE_DIR):
    """
    Varsayılanlar Olcay'ın onayladığı düzen: A4'e 2x3, foto 100.8 x 76.76 mm.
    photo_mm  : basılacak fotoğrafın (genişlik, yükseklik) mm — yatay yerleşim
    gap_mm    : (yatay, dikey) aralık mm
    origin_mm : gridin sol-üst köşesi, kağıt köşesine göre mm. None -> ortala.
    """
    page = json.load(open(os.path.join(template_dir, "page", "_info.json")))
    sizes = {p["paperSizeId"]: p for p in page["paperSizeList"]}
    base = json.loads(json.dumps(sizes[paper]))
    rect = paper_rect(base["size"])
    paper_w, paper_h = PAPER_MM[paper]

    pw, ph = photo_mm
    gx, gy = gap_mm
    grid_w = cols * pw + (cols - 1) * gx
    grid_h = rows * ph + (rows - 1) * gy
    if grid_w > paper_w + 0.01 or grid_h > paper_h + 0.01:
        raise ValueError(f"grid {grid_w:.1f}x{grid_h:.1f} mm > kağıt {paper_w}x{paper_h}")
    ox, oy = origin_mm if origin_mm else ((paper_w - grid_w) / 2, (paper_h - grid_h) / 2)

    page_id = rid()
    photos, files = [], []
    for i, img in enumerate(images[: cols * rows]):
        col, row = i % cols, i // cols
        p = make_photo(img, pw, ph, ox + col * (pw + gx), oy + row * (ph + gy),
                       rect, 1000 + i)
        folder, name = rid(), os.path.basename(img)
        p["imagepath"] = f"{folder}\\{name}"
        files.append((img, f"{page_id}/{folder}/{name}"))
        photos.append(p)

    base.update({"imageFrames": [], "photos": photos, "cliparts": [], "messages": [],
                 "sender": {"show": True, "zindex": 1000},
                 "workData": {"maxWorkSpaceCount": 1}})
    page["editedPaperSize"] = base

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("page.json", json.dumps([page_id]))
        z.writestr("projectInfo.json", json.dumps({
            "appVersion": "4.0.4.0",
            "editInfo": {"pageEditInfo": {"canAddPage": True, "canCopyPage": True,
                                          "canRemovePage": True}},
            "formatInfo": {"saveFormat": 0}}, indent=2))
        z.write(os.path.join(template_dir, "MasterTemplate", "_info.json"),
                "MasterTemplate/_info.json")
        z.writestr(f"{page_id}/_info.json", json.dumps(page, indent=2))
        for src, dst in files:
            z.write(src, dst)
    return out_path


def measure(path):
    """Üretilen/verilen .etdx'i mm cinsinden ölç — doğrulama için."""
    z = zipfile.ZipFile(path)
    pid = json.loads(z.read("page.json"))[0]
    d = json.loads(z.read(f"{pid}/_info.json"))["editedPaperSize"]
    rect = paper_rect(d["size"])
    out = []
    for p in d["photos"]:
        c = p["crop"]["rect"]
        cw, ch = c[2] - c[0] + 1, c[3] - c[1] + 1
        s = p["scale"]
        bw, bh = (ch * s, cw * s) if p["angle"] == 90 else (cw * s, ch * s)
        cx, cy = p["center"]
        out.append({"img": p["imagepath"], "w": bw / U, "h": bh / U,
                    "left": (cx - bw / 2 - rect[0]) / U, "top": (cy - bh / 2 - rect[1]) / U})
    return out


def preview(path, out_png, px_per_mm=3):
    """Üretilen .etdx'i sayfa olarak render et — ölçü doğru ama kadraj bozuksa
    sayı yakalamıyor, göz yakalıyor."""
    from PIL import Image
    z = zipfile.ZipFile(path)
    pid = json.loads(z.read("page.json"))[0]
    d = json.loads(z.read(f"{pid}/_info.json"))["editedPaperSize"]
    rect = paper_rect(d["size"])
    pw = int((rect[2] - rect[0]) / U * px_per_mm)
    ph = int((rect[3] - rect[1]) / U * px_per_mm)
    page = Image.new("RGB", (pw, ph), "white")
    tmp = os.path.join(os.path.dirname(os.path.abspath(out_png)), ".etdx_prev")
    os.makedirs(tmp, exist_ok=True)
    for p in d["photos"]:
        src = p["imagepath"].replace("\\", "/")
        f = z.extract(f"{pid}/{src}", tmp)
        im = Image.open(f).crop((p["crop"]["rect"][0], p["crop"]["rect"][1],
                                 p["crop"]["rect"][2] + 1, p["crop"]["rect"][3] + 1))
        if p["angle"]:
            im = im.rotate(-p["angle"], expand=True)
        bw = im.width * p["scale"] / U * px_per_mm
        bh = im.height * p["scale"] / U * px_per_mm
        im = im.resize((max(1, round(bw)), max(1, round(bh))))
        cx, cy = p["center"]
        page.paste(im, (round((cx - rect[0]) / U * px_per_mm - im.width / 2),
                        round((cy - rect[1]) / U * px_per_mm - im.height / 2)))
    shutil.rmtree(tmp, ignore_errors=True)
    page.save(out_png)
    return out_png


if __name__ == "__main__":
    if sys.argv[1] == "preview":
        print(preview(sys.argv[2], sys.argv[3] if len(sys.argv) > 3
                      else sys.argv[2] + ".png"))
    elif sys.argv[1] == "measure":
        for r in measure(sys.argv[2]):
            print(f"{r['img'][-7:]}  {r['w']:7.2f} x {r['h']:6.2f} mm   "
                  f"sol={r['left']:6.2f} ust={r['top']:6.2f}")
    else:
        print(build(sys.argv[2:], sys.argv[1]))
