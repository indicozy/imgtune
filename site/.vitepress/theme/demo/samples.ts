// Three sample images made in the page with canvas: no third-party photos, nothing fetched.

export interface Sample {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const SAMPLES: Sample[] = [
  { id: "gradient", label: "gradient, 2400 x 1600", width: 2400, height: 1600 },
  { id: "shapes", label: "shapes, 2000 x 1334", width: 2000, height: 1334 },
  { id: "portrait", label: "portrait, 1200 x 1600", width: 1200, height: 1600 },
];

function paint(id: string, w: number, h: number, ctx: CanvasRenderingContext2D): void {
  if (id === "gradient") {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#0b3d44");
    g.addColorStop(0.5, "#5ed0d6");
    g.addColorStop(1, "#f1f3ef");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const r = ctx.createRadialGradient(w * 0.7, h * 0.35, 10, w * 0.7, h * 0.35, w * 0.45);
    r.addColorStop(0, "rgba(255,190,90,0.9)");
    r.addColorStop(1, "rgba(255,190,90,0)");
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, w, h);
  } else if (id === "shapes") {
    ctx.fillStyle = "#e8ece9";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `hsl(${(i * 47) % 360} 55% ${35 + ((i * 13) % 40)}%)`;
      const x = (i * 709) % w;
      const y = (i * 353) % h;
      ctx.beginPath();
      if (i % 2) ctx.arc(x, y, 30 + (i % 9) * 22, 0, Math.PI * 2);
      else ctx.rect(x, y, 60 + (i % 7) * 40, 40 + (i % 5) * 50);
      ctx.fill();
    }
  } else {
    // Portrait: a soft field with fine grain, so the encoders have texture to work on.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#26353a");
    g.addColorStop(1, "#c9b59a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed % 23) - 11;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = "#1b2a2e";
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.42, w * 0.2, h * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A JPEG file for a sample, made in the page. */
export async function makeSample(sample: Sample): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = sample.width;
  canvas.height = sample.height;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  paint(sample.id, sample.width, sample.height, ctx);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas could not make the sample"))), "image/jpeg", 0.92),
  );
  return new File([blob], `sample-${sample.id}.jpg`, { type: "image/jpeg" });
}
