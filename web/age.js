// A card's age as a person reads it: a rough figure that says whether a card is minutes, hours or days old.
const MIN = 60_000;

/** The age of something `ms` milliseconds old, such as "15 min ago" or "4 h 30 min ago". */
export function cardAge(ms) {
  if (ms < MIN) return 'just now';
  const m = Math.round(ms / MIN);
  if (m < 10) return `${m} min ago`;
  // Under an hour, to the nearest 5 minutes. Up to a day, to the nearest 10. After that, to the nearest hour.
  const five = Math.round(m / 5) * 5;
  if (five < 60) return `${five} min ago`;
  const ten = Math.round(m / 10) * 10;
  if (ten < 24 * 60) return ten % 60 ? `${Math.floor(ten / 60)} h ${ten % 60} min ago` : `${ten / 60} h ago`;
  const hours = Math.round(m / 60);
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h ago` : `${hours / 24} d ago`;
}
