/** A compact greeting for the Home heading. */
export function greeting(now: Date, name?: string): string {
  const hour = now.getHours();
  const salutation =
    hour >= 5 && hour < 12
      ? 'GOOD MORNING'
      : hour >= 12 && hour < 17
        ? 'GOOD AFTERNOON'
        : 'GOOD EVENING';
  const first = name?.trim().split(/\s+/)[0]?.toUpperCase().slice(0, 14);
  const withName = first ? `${salutation}, ${first}` : salutation;
  return withName.length <= 24 ? withName : salutation;
}
