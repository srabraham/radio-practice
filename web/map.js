// Draws the practice map: a rough Black Rock City layout, repeaters, dead
// zones, and radios. World units are meters, Man at the origin, +y toward 6:00.

export const CHANNEL_COLORS = ['#e4572e', '#2e86ab', '#a23b72', '#3bb273', '#f18f01', '#6c5ce7', '#17a398', '#c44536'];

const VIEW = { xmin: -3400, xmax: 3400, ymin: -3000, ymax: 3300 };

export class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    const sx = this.w / (VIEW.xmax - VIEW.xmin), sy = this.h / (VIEW.ymax - VIEW.ymin);
    this.scale = Math.min(sx, sy);
    this.ox = this.w / 2 - ((VIEW.xmin + VIEW.xmax) / 2) * this.scale;
    this.oy = this.h / 2 - ((VIEW.ymin + VIEW.ymax) / 2) * this.scale;
    this.onResize && this.onResize();
  }

  toScreen(p) { return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale }; }
  toWorld(x, y) { return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale }; }

  draw({ landmarks, channels, clients, zones, handheldRange, now }) {
    const c = this.ctx, s = this.scale;
    const o = this.toScreen({ x: 0, y: 0 });
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = '#e8dcc2';
    c.fillRect(0, 0, this.w, this.h);

    // City streets: arcs from 2:00 to 10:00 through 6:00.
    const a0 = -Math.PI / 6, a1 = (7 * Math.PI) / 6;
    c.strokeStyle = 'rgba(90,70,40,0.25)';
    c.lineWidth = 1;
    for (let r = 850; r < 1700; r += 95) arc(c, o, r * s, a0, a1);
    c.strokeStyle = 'rgba(90,70,40,0.6)';
    c.lineWidth = 2;
    arc(c, o, 760 * s, a0, a1);
    arc(c, o, 1700 * s, a0, a1);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(90,70,40,0.3)';
    for (let h = 2; h <= 10; h += 0.5) {
      const th = (h * Math.PI) / 6;
      const p1 = this.toScreen({ x: 760 * Math.sin(th), y: -760 * Math.cos(th) });
      const p2 = this.toScreen({ x: 1700 * Math.sin(th), y: -1700 * Math.cos(th) });
      line(c, p1, p2);
    }

    c.font = '11px system-ui, sans-serif';
    c.textAlign = 'center';
    for (const l of landmarks) {
      const p = this.toScreen(l.pos);
      c.fillStyle = 'rgba(60,45,25,0.8)';
      c.beginPath();
      c.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = 'rgba(60,45,25,0.65)';
      c.fillText(l.name, p.x, p.y - 6);
    }

    for (const z of zones) {
      const p = this.toScreen(z.center);
      c.fillStyle = `rgba(200,40,40,${0.12 + z.loss * 0.25})`;
      c.strokeStyle = 'rgba(160,20,20,0.7)';
      c.beginPath();
      c.arc(p.x, p.y, z.radius * s, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.fillStyle = 'rgba(120,10,10,0.9)';
      c.fillText(`dead zone −${Math.round(z.loss * 100)}%`, p.x, p.y + 4);
    }

    const rptrs = new Map();
    for (const ch of channels) {
      if (!ch.repeater) continue;
      const k = ch.repeater.x + ',' + ch.repeater.y;
      if (!rptrs.has(k)) rptrs.set(k, { pos: ch.repeater, names: [] });
      rptrs.get(k).names.push(ch.name);
    }
    for (const r of rptrs.values()) {
      const p = this.toScreen(r.pos);
      c.fillStyle = '#333';
      c.beginPath();
      c.moveTo(p.x, p.y - 9);
      c.lineTo(p.x - 7, p.y + 5);
      c.lineTo(p.x + 7, p.y + 5);
      c.closePath();
      c.fill();
      c.fillText('RPTR ' + r.names.join('/'), p.x, p.y + 18);
    }

    // FM transmitters: show roughly how far they reach.
    for (const cl of clients) {
      if (!cl.tx || channels[cl.tx.ch]?.mode !== 'fm-simplex') continue;
      const p = this.toScreen(cl.pos);
      c.strokeStyle = CHANNEL_COLORS[cl.tx.ch % CHANNEL_COLORS.length];
      c.setLineDash([6, 5]);
      c.beginPath();
      c.arc(p.x, p.y, handheldRange * s, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }

    for (const cl of clients) {
      if (cl.role !== 'participant') continue;
      const p = this.toScreen(cl.pos);
      const chId = cl.tx ? cl.tx.ch : cl.channel;
      const color = CHANNEL_COLORS[chId % CHANNEL_COLORS.length];
      if (cl.tx) {
        const pulse = 10 + 6 * Math.abs(Math.sin(now / 200));
        c.fillStyle = color + '55';
        c.beginPath();
        c.arc(p.x, p.y, pulse, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = color;
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(p.x, p.y, 7, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      if (cl.scanning) {
        c.setLineDash([2, 3]);
        c.strokeStyle = '#333';
        c.beginPath();
        c.arc(p.x, p.y, 11, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
      c.lineWidth = 1;
      c.fillStyle = '#111';
      c.font = 'bold 12px system-ui, sans-serif';
      c.fillText(cl.callsign, p.x, p.y - 12);
      c.font = '11px system-ui, sans-serif';
    }
  }

  hitClient(clients, x, y) {
    for (const cl of clients) {
      if (cl.role !== 'participant') continue;
      const p = this.toScreen(cl.pos);
      if (Math.hypot(p.x - x, p.y - y) < 12) return cl;
    }
    return null;
  }

  hitZone(zones, x, y) {
    const w = this.toWorld(x, y);
    return zones.find((z) => Math.hypot(z.center.x - w.x, z.center.y - w.y) <= z.radius) || null;
  }
}

function arc(c, o, r, a0, a1) {
  c.beginPath();
  c.arc(o.x, o.y, r, a0, a1);
  c.stroke();
}

function line(c, a, b) {
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.stroke();
}
