/**
 * Protest placards (game/fame): the texts on the signs, by index — held item ids 'placard_<i>'
 * (streetwear.ts builds them). The first ones are for a hated hero; the last for an adored one
 * (fans at the statue's unveiling). '|' breaks a line.
 */
export const PLACARDS: readonly string[] = [
  'GO HOME|HERO',
  'NOT OUR|HERO',
  'STOP THE|DESTRUCTION',
  'WHO PAYS|FOR THIS?',
  'CAPES|OUT!',
  'OUR CITY|NOT YOUR|PLAYGROUND',
  'MENACE!',
  'BAN|SUPER|HEROES',
  'ARREST|THE MENACE',
  'MY CAR|WAS PARKED|THERE!',
];

/** Fan signs: placard ids from here on. */
export const FAN_SIGNS_FROM = PLACARDS.length;
export const FAN_SIGNS: readonly string[] = ['WE ♥|OUR HERO', 'THANK|YOU!', 'HERO OF|THE CITY'];
