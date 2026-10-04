// PRD-6: sample catalog used by the product seed script.
//
// Kept data-only so `seed-products.ts` reads as plain idempotent logic and
// tests can import an alternative catalog for assertions.
//
// Prices are integer minor units (cents) per the plan's money rule. Each entry
// carries the natural uniqueness key `(name, category)` the seeder uses to
// decide between insert and update. Stock is initial-only: once a product
// exists in the DB, re-running the seed leaves its live counters alone.

export interface SampleProduct {
  name: string;
  description: string;
  category: string;
  priceMinor: number;
  currency: string;
  initialStock: number;
  attributes: Record<string, string>;
  images: string[];
  isActive: boolean;
}

export const SAMPLE_CATALOG: readonly SampleProduct[] = [
  {
    name: 'Mechanical Keyboard — TKL',
    description: 'Tenkeyless mechanical keyboard with hot-swap sockets, PBT keycaps and USB-C.',
    category: 'electronics',
    priceMinor: 12900,
    currency: 'USD',
    initialStock: 40,
    attributes: { switch: 'brown', layout: 'ansi', backlight: 'rgb' },
    images: ['https://cdn.example.com/catalog/keyboard-tkl.jpg'],
    isActive: true,
  },
  {
    name: 'Wireless Mouse — Ergonomic',
    description: '6-button Bluetooth mouse, rechargeable, 2.4 GHz dongle included.',
    category: 'electronics',
    priceMinor: 4500,
    currency: 'USD',
    initialStock: 120,
    attributes: { color: 'graphite', connectivity: 'bluetooth' },
    images: ['https://cdn.example.com/catalog/mouse-ergo.jpg'],
    isActive: true,
  },
  {
    name: 'USB-C Hub — 7-in-1',
    description: 'Aluminium hub: HDMI 4K, 2 × USB-A 3.0, SD/microSD, USB-C PD passthrough.',
    category: 'electronics',
    priceMinor: 3900,
    currency: 'USD',
    initialStock: 75,
    attributes: { ports: '7', pd: '100W' },
    images: ['https://cdn.example.com/catalog/usbc-hub.jpg'],
    isActive: true,
  },
  {
    name: '27-inch 4K Monitor',
    description: 'IPS panel, 60 Hz, HDR10, 95% DCI-P3, DisplayPort + HDMI 2.1.',
    category: 'electronics',
    priceMinor: 39900,
    currency: 'USD',
    initialStock: 15,
    attributes: { size: '27"', resolution: '3840x2160', panel: 'ips' },
    images: ['https://cdn.example.com/catalog/monitor-4k.jpg'],
    isActive: true,
  },
  {
    name: 'The Pragmatic Programmer',
    description: '20th-anniversary edition. Essential reading on software craft.',
    category: 'books',
    priceMinor: 3200,
    currency: 'USD',
    initialStock: 200,
    attributes: { author: 'Hunt & Thomas', format: 'paperback', language: 'en' },
    images: ['https://cdn.example.com/catalog/book-pragmatic.jpg'],
    isActive: true,
  },
  {
    name: 'Designing Data-Intensive Applications',
    description: 'Deep dive into data systems — Kleppmann. Required reading.',
    category: 'books',
    priceMinor: 4800,
    currency: 'USD',
    initialStock: 150,
    attributes: { author: 'Kleppmann', format: 'paperback', language: 'en' },
    images: ['https://cdn.example.com/catalog/book-ddia.jpg'],
    isActive: true,
  },
  {
    name: 'Clean Architecture',
    description: 'Robert C. Martin on software structure and boundaries.',
    category: 'books',
    priceMinor: 2900,
    currency: 'USD',
    initialStock: 180,
    attributes: { author: 'Martin', format: 'paperback', language: 'en' },
    images: ['https://cdn.example.com/catalog/book-clean-arch.jpg'],
    isActive: true,
  },
  {
    name: 'French Press — 1L',
    description: 'Borosilicate glass carafe with stainless steel frame.',
    category: 'home',
    priceMinor: 2500,
    currency: 'USD',
    initialStock: 60,
    attributes: { material: 'glass', capacity: '1L' },
    images: ['https://cdn.example.com/catalog/french-press.jpg'],
    isActive: true,
  },
  {
    name: 'Linen Throw Blanket',
    description: 'Pre-washed European linen, 130 × 180 cm, stone grey.',
    category: 'home',
    priceMinor: 7900,
    currency: 'USD',
    initialStock: 25,
    attributes: { material: 'linen', color: 'stone' },
    images: ['https://cdn.example.com/catalog/linen-throw.jpg'],
    isActive: true,
  },
  {
    name: 'Soy Candle — Cedar & Vetiver',
    description: '220 g soy wax candle, cotton wick, ~45 h burn time.',
    category: 'home',
    priceMinor: 1800,
    currency: 'USD',
    initialStock: 90,
    attributes: { scent: 'cedar-vetiver', weight: '220g' },
    images: ['https://cdn.example.com/catalog/soy-candle.jpg'],
    isActive: true,
  },
  {
    name: 'Merino Crew Sock — 3 Pack',
    description: '80% merino wool, mid-weight, cushioned footbed.',
    category: 'apparel',
    priceMinor: 3600,
    currency: 'USD',
    initialStock: 300,
    attributes: { material: 'merino', pack: '3' },
    images: ['https://cdn.example.com/catalog/merino-socks.jpg'],
    isActive: true,
  },
  {
    name: 'Organic Cotton T-Shirt',
    description: 'GOTS-certified cotton, boxy fit, pre-shrunk.',
    category: 'apparel',
    priceMinor: 2800,
    currency: 'USD',
    initialStock: 220,
    attributes: { material: 'cotton', fit: 'boxy' },
    images: ['https://cdn.example.com/catalog/cotton-tshirt.jpg'],
    isActive: true,
  },
];
