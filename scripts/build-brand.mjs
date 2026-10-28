import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Mechanical exports of the approved imagegen artwork. This does not redraw the logo.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "docs/brand");
const publicDir = path.join(root, "public");
const master = `data:image/png;base64,${fs.readFileSync(path.join(brand, "ravnir-companion-master.png")).toString("base64")}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const exports = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    return [
      ["logo.png", 640, false],
      ["icon-192.png", 192, true],
      ["icon-512.png", 512, true],
      ["favicon.png", 64, true],
    ].map(([file, size, tile]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      if (tile) {
        ctx.fillStyle = "#181d2b";
        ctx.fillRect(0, 0, size, size);
      }
      ctx.drawImage(image, 0, 0, size, size);
      return { file, data: canvas.toDataURL("image/png").split(",")[1] };
    });
  }, master);
  for (const { file, data } of exports) fs.writeFileSync(path.join(publicDir, file), Buffer.from(data, "base64"));

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#121722;color:#f5f4f0;font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;padding:64px;gap:56px}
    img{width:390px;height:390px;object-fit:contain;flex:none}main{padding-bottom:8px}.name{font-size:80px;font-weight:700;letter-spacing:-5px;margin:0 0 28px}.rule{width:44px;height:4px;background:#ffb547;border-radius:4px;margin-bottom:27px}h1{font-size:42px;line-height:1.16;letter-spacing:-1.5px;font-weight:500;margin:0 0 25px}p{font-size:20px;line-height:1.5;color:#afb7c8;letter-spacing:.1px;margin:0}
    </style></head><body><img src="${master}" alt=""><main><div class="name">ravnir</div><div class="rule"></div><h1>Persistent agents.<br>One shared memory.</h1><p>Your server. Your models.</p></main></body></html>`);
  await page.locator("img").evaluate((image) => image.decode());
  await page.screenshot({ path: path.join(publicDir, "og.jpg"), type: "jpeg", quality: 93 });

  const favicon = `data:image/png;base64,${fs.readFileSync(path.join(publicDir, "favicon.png")).toString("base64")}`;
  await page.setViewportSize({ width: 1200, height: 750 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#f7f6f2;font-family:Arial,Helvetica,sans-serif;color:#202737;padding:46px 56px}h1{font-size:30px;letter-spacing:-1px;margin:0 0 8px}p{color:#687184;font-size:16px;margin:0 0 24px}.row{display:flex;gap:28px}.panel{flex:1;border-radius:24px;height:390px;background:white;display:flex;align-items:center;justify-content:center}.dark{background:#181d2b}.hero{width:350px;height:350px;object-fit:contain}.sizes{height:105px;display:flex;align-items:center;gap:30px}.sizes img{object-fit:contain}.tile{background:#181d2b;border-radius:22%}.label{font-size:14px;color:#687184;margin-left:auto}
    </style></head><body><h1>Ravnir companion</h1><p>Production mark on light and dark, with app-icon and small-size checks.</p><div class="row"><div class="panel"><img class="hero" src="${master}" alt=""></div><div class="panel dark"><img class="hero" src="${master}" alt=""></div></div><div class="sizes"><img class="tile" src="${master}" width="80" height="80"><img src="${master}" width="64" height="64"><img src="${favicon}" width="32" height="32"><img src="${favicon}" width="16" height="16"><span class="label">80 · 64 · 32 · 16 px</span></div></body></html>`);
  await page.locator("img").evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await page.screenshot({ path: path.join(brand, "companion-preview.png") });
  console.log("Exported logo, 192px and 512px app icons, 64px favicon, social preview and visual checks.");
} finally {
  await browser.close();
}
