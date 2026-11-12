#!/usr/bin/env python3
"""Regenerate the small synthetic U-Net fixture. Needs torch, so CI reads the committed result."""
from pathlib import Path
import base64
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
sys.path.insert(0, str(ROOT/'scripts/experiments/layer_unet_2026-11-06'))
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from export_unet_bundle import build_bundle


class Blk(nn.Sequential):
    def __init__(s, a, b):
        super().__init__(nn.Conv2d(a, b, 3, padding=1), nn.GroupNorm(4, b), nn.ReLU(True), nn.Conv2d(b, b, 3, padding=1), nn.GroupNorm(4, b), nn.ReLU(True))


class UNet(nn.Module):
    def __init__(s, b=4, out=4):
        super().__init__()
        c = [b, b*2, b*4, b*8, b*16]
        s.d = nn.ModuleList([Blk(3, c[0])]+[Blk(c[i], c[i+1]) for i in range(4)])
        s.u = nn.ModuleList([Blk(c[i+1]+c[i], c[i]) for i in range(4)])
        s.o = nn.Conv2d(b, out, 1)

    def forward(s, x):
        H = []
        for i, d in enumerate(s.d):
            x = d(x if i == 0 else F.max_pool2d(x, 2))
            H.append(x)
        for i in range(3, -1, -1):
            x = s.u[i](torch.cat([F.interpolate(x, size=H[i].shape[2:], mode='bilinear', align_corners=False), H[i]], 1))
        return s.o(x)


torch.manual_seed(29)
net = UNet().double().eval()
rng = np.random.default_rng(29)
def b64(a): return base64.b64encode(np.asarray(a, dtype='<f4').tobytes()).decode()
cases = []
for h, w in ((48, 64), (37, 53), (16, 16)):
    x = rng.random((3, h, w), dtype=np.float32)
    with torch.no_grad():
        logits = net.float()(torch.from_numpy(x[None]))[0]
        p = logits.softmax(0)
    cases.append({'height': h, 'width': w, 'input': b64(x), 'logits': b64(logits.numpy()), 'probabilities': b64(p.numpy())})
# Tiled native reference on a two-coloured synthetic image, using the same tile rule as the site.
factor, tile, keep, H, W = 4, 96, 64, 360, 424
image = np.zeros((H, W, 3), np.uint8); image[:, :W//2] = [30, 90, 160]; image[:, W//2:] = [200, 170, 60]
image[..., 1] += ((np.indices((H, W)).sum(0) % 7).astype(np.uint8))
hh, ww = H//factor, W//factor
reduced = np.floor(image[:hh*factor, :ww*factor].reshape(hh, factor, ww, factor, 3).mean(axis=(1, 3)) + .5)/255
probs = np.zeros((4, hh, ww), np.float32); mar = (tile-keep)//2
with torch.no_grad():
    for y in range(0, hh, keep):
        for x in range(0, ww, keep):
            y0, x0, y1, x1 = max(0, y-mar), max(0, x-mar), min(hh, y+keep+mar), min(ww, x+keep+mar)
            t = torch.from_numpy(reduced[y0:y1, x0:x1].transpose(2, 0, 1)[None]).float()
            q = net(t).softmax(1)[0].numpy()
            ch, cw = min(keep, hh-y), min(keep, ww-x)
            probs[:, y:y+ch, x:x+cw] = q[:, y-y0:y-y0+ch, x-x0:x-x0+cw]
    up = F.interpolate(torch.from_numpy(probs[None]), size=(hh*factor, ww*factor), mode='bilinear', align_corners=False)[0].argmax(0).numpy().astype(np.uint8)
labels = np.zeros((H, W), np.uint8); labels[:hh*factor, :ww*factor] = up
source = {'animal_id': 'SYN', 'section_id': 'SYN-1', 'source_sha256': 'a'*64, 'roi_sha256': 'b'*64}
bundle = build_bundle({k: v.numpy() for k, v in net.state_dict().items()}, model_id='synthetic-unet-fixture', base_channels=4, factor=factor, sources=[source], animals=['SYN'], created_at='2026-11-06T00:00:00+00:00', scope='Synthetic regression fixture with random weights; never tissue.')
bundle['inference'].update(tile=tile, keep=keep)
out = {'model': bundle, 'forward_cases': cases, 'native': {'height': H, 'width': W, 'image': base64.b64encode(image.tobytes()).decode(), 'labels': base64.b64encode(labels.tobytes()).decode()}}
(ROOT/'qa/fixtures').mkdir(exist_ok=True)
(ROOT/'qa/fixtures/unet-synthetic.json').write_text(json.dumps(out))
print('fixture bytes', (ROOT/'qa/fixtures/unet-synthetic.json').stat().st_size)
