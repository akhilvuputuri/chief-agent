/** A Telegram location or venue message, turned into a line Chief can act on. */
export function locationMessage(
  location: {
    latitude: number;
    longitude: number;
    horizontal_accuracy?: number;
  },
  venue?: { title?: string; address?: string },
) {
  const lat = location.latitude.toFixed(5);
  const lon = location.longitude.toFixed(5);
  const accuracy = location.horizontal_accuracy
    ? `, accuracy about ${Math.round(location.horizontal_accuracy)} m`
    : "";
  // Venue names come from Telegram's place search: keep them short and bracket-free.
  const name = [venue?.title, venue?.address]
    .filter(Boolean)
    .join(", ")
    .replace(/[[\]]/g, "")
    .slice(0, 120);
  return `[Shared location: lat ${lat}, lon ${lon}${accuracy}${name ? ` (${name})` : ""}. The owner shared this pin from Telegram; use it as their location for location questions such as rain, weather or nearby carparks, and ask what they want if the request is unclear.]`;
}
