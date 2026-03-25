export interface ProductCategory {
  slug: string;
  displayName: string;
  filenamePatterns: string[];
  keywords: string[];
}

export const DEFAULT_CATEGORIES: ProductCategory[] = [
  {
    slug: 'soap-dispenser',
    displayName: 'Soap Dispenser',
    filenamePatterns: ['soap-dispenser', 'soap_dispenser', 'foaming-dispenser', 'foam-soap', 'liquid-soap', 'hand-soap'],
    keywords: ['soap dispenser', 'commercial soap dispenser', 'wall mounted soap dispenser', 'automatic soap dispenser', 'touchless soap dispenser'],
  },
  {
    slug: 'paper-towel-dispenser',
    displayName: 'Paper Towel Dispenser',
    filenamePatterns: ['paper-towel', 'paper_towel', 'towel-dispenser', 'hand-towel', 'c-fold', 'multifold'],
    keywords: ['paper towel dispenser', 'commercial paper towel dispenser', 'wall mounted paper towel dispenser', 'automatic paper towel dispenser'],
  },
  {
    slug: 'hand-dryer',
    displayName: 'Hand Dryer',
    filenamePatterns: ['hand-dryer', 'hand_dryer', 'air-dryer', 'jet-dryer', 'hand-dry'],
    keywords: ['hand dryer', 'commercial hand dryer', 'automatic hand dryer', 'high speed hand dryer', 'jet hand dryer'],
  },
  {
    slug: 'air-freshener',
    displayName: 'Air Freshener Dispenser',
    filenamePatterns: ['air-freshener', 'air_freshener', 'fragrance-dispenser', 'scent-dispenser', 'odor'],
    keywords: ['air freshener dispenser', 'commercial air freshener', 'automatic air freshener dispenser', 'restroom air freshener'],
  },
  {
    slug: 'toilet-seat-cover',
    displayName: 'Toilet Seat Cover Dispenser',
    filenamePatterns: ['seat-cover', 'seat_cover', 'toilet-seat', 'toilet_seat'],
    keywords: ['toilet seat cover dispenser', 'commercial toilet seat cover', 'restroom seat cover dispenser'],
  },
  {
    slug: 'waste-receptacle',
    displayName: 'Waste Receptacle',
    filenamePatterns: ['waste', 'trash', 'garbage', 'bin', 'receptacle'],
    keywords: ['waste receptacle', 'commercial trash can', 'restroom waste bin', 'stainless steel waste receptacle'],
  },
  {
    slug: 'restroom-equipment',
    displayName: 'Commercial Restroom Equipment',
    filenamePatterns: ['restroom', 'washroom', 'bathroom', 'commercial-hygiene', 'hygiene'],
    keywords: ['commercial restroom equipment', 'washroom accessories', 'restroom hygiene products', 'commercial bathroom accessories'],
  },
];

export function detectCategory(
  filename: string,
  relativePath: string,
  categories: ProductCategory[],
): ProductCategory | null {
  const combined = `${relativePath}/${filename}`.toLowerCase();

  // Build flat list sorted by pattern length (longer = more specific = higher priority)
  const candidates = categories.flatMap(cat =>
    cat.filenamePatterns.map(p => ({ pattern: p.toLowerCase(), category: cat })),
  ).sort((a, b) => b.pattern.length - a.pattern.length);

  for (const { pattern, category } of candidates) {
    if (combined.includes(pattern)) {
      return category;
    }
  }
  return null;
}
