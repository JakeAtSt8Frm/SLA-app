import { healthStatus, rosterStatus, ROSTER_LABELS } from '../lib/availability';
import type { Player } from '../lib/types';

export function AvailabilityBadge({ player, includeActive = false }: { player: Player; includeActive?: boolean }) {
  const roster = rosterStatus(player);
  const health = healthStatus(player);
  return <>
    {(includeActive || roster !== 'active') && (
      <span className={`availability-badge availability-badge--${roster}`} title="Current NFL roster status; separate from fantasy ownership">
        {ROSTER_LABELS[roster]}
      </span>
    )}
    {health !== 'unreported' && (
      <span className={`availability-badge availability-badge--${health}`} title="Current injury designation">
        {health.charAt(0).toUpperCase() + health.slice(1)}
      </span>
    )}
  </>;
}
