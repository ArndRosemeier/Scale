/**
 * Procedural names for streets, stations, districts and shops.
 */
import { Rng, deriveSeed } from '../core/rng';

const ROOTS = [
  'Ash', 'Birch', 'Cedar', 'Elm', 'Hazel', 'Linden', 'Maple', 'Oak', 'Pine', 'Willow', 'Rowan', 'Alder',
  'Mill', 'Bridge', 'Church', 'Market', 'Castle', 'Harbor', 'King', 'Queen', 'Prince', 'Abbey', 'Chapel', 'Garden',
  'Hill', 'Brook', 'River', 'Lake', 'Spring', 'Stone', 'Iron', 'Copper', 'Silver', 'Gold', 'Union', 'Liberty',
  'Franklin', 'Lincoln', 'Grant', 'Hudson', 'Vernon', 'Morris', 'Clinton', 'Fulton', 'Greene', 'Warren', 'Carroll', 'Bedford',
  'Sterling', 'Clifton', 'Ashford', 'Belmont', 'Fairview', 'Highland', 'Lexington', 'Madison', 'Monroe', 'Jefferson', 'Prospect', 'Summit',
  'Albion', 'Bramble', 'Crane', 'Delancey', 'Essex', 'Hester', 'Orchard', 'Ludlow', 'Rivington', 'Stanton', 'Bowery', 'Mercer',
  'Linnaeus', 'Kepler', 'Newton', 'Volta', 'Faraday', 'Curie', 'Darwin', 'Euler', 'Gauss', 'Planck', 'Bohr', 'Tesla',
];
const STREET_SUFFIX = ['Street', 'Street', 'Street', 'Avenue', 'Road', 'Lane', 'Place', 'Way', 'Terrace', 'Row', 'Court', 'Drive'];
const STATION_SUFFIX = ['', '', ' Square', ' Park', ' Street', ' Junction', ' Market', ' Bridge', ' Gate', ' Hill', ' Central', ' Plaza'];

export function streetName(seed: number, id: number, cls: number): string {
  const r = new Rng(deriveSeed(seed, 'street', id));
  const root = r.pick(ROOTS);
  if (cls === 0) return `${root} Boulevard`;
  if (cls === 1) return r.chance(0.5) ? `${root} Avenue` : `${r.int(1, 120)}${ordSuffix(r.int(1, 120))} Avenue`.replace(/^(\d+)\w+/, (m) => m);
  return `${root} ${r.pick(STREET_SUFFIX)}`;
}

function ordSuffix(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

export function stationName(seed: number, id: number): string {
  const r = new Rng(deriveSeed(seed, 'station', id));
  return r.pick(ROOTS) + r.pick(STATION_SUFFIX);
}

const SHOP_KINDS = [
  'Cafe', 'Bakery', 'Deli', 'Bistro', 'Pharmacy', 'Books', 'Florist', 'Tailor', 'Barber', 'Grocery', 'Wine', 'Hardware',
  'Diner', 'Pizza', 'Noodles', 'Sushi', 'Tacos', 'Laundry', 'Optician', 'Jeweler', 'Shoes', 'Records', 'Toys', 'Bank',
];
export function shopName(seed: number, id: number): { name: string; kind: string } {
  const r = new Rng(deriveSeed(seed, 'shop', id));
  const kind = r.pick(SHOP_KINDS);
  const owner = r.pick(ROOTS);
  const fmt = r.int(0, 3);
  const name = fmt === 0 ? `${owner}'s ${kind}` : fmt === 1 ? `${kind} ${owner}` : fmt === 2 ? `The ${owner} ${kind}` : `${owner} & Sons`;
  return { name, kind };
}

export function districtName(seed: number, id: number): string {
  const r = new Rng(deriveSeed(seed, 'district', id));
  const root = r.pick(ROOTS);
  return root + r.pick(['ville', ' Heights', ' Park', 'ton', ' Hill', ' Village', ' Gardens', 'field', ' Quarter', 'side', ' Point', ' Bay']);
}

export function cityName(seed: number): string {
  const r = new Rng(deriveSeed(seed, 'cityname'));
  const a = ['New ', 'Port ', 'Saint ', 'East ', 'North ', '', '', '', '', ''];
  const b = ['Haven', 'Bridge', 'Ford', 'Burg', 'Mouth', 'Field', 'Ton', 'Stead', 'Wick', 'Holm', 'Minster', 'Gate'];
  return r.pick(a) + r.pick(ROOTS) + r.pick(b).toLowerCase();
}
