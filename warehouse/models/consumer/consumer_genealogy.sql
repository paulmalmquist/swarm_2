select g.*, c.known_sequence as investigation_known_sequence,
  coalesce(f.hardware_key, '__unknown__') as investigation_from_hardware_key,
  coalesce(f.identity_resolution, 'missing') as investigation_from_resolution,
  coalesce(t.hardware_key, '__unknown__') as investigation_to_hardware_key,
  coalesce(t.identity_resolution, 'missing') as investigation_to_resolution
from {{ ref('bridge_hardware_genealogy') }} g
join {{ ref('consumer_investigation_context') }} c on g.dataset_id = c.dataset_id and {{ active_at('g','c.known_sequence') }}
left join {{ ref('consumer_identity_as_of') }} f on g.from_identity_key = f.identity_key
left join {{ ref('consumer_identity_as_of') }} t on g.to_identity_key = t.identity_key
-- Preserve valid-time intervals for historical exposure-window traversal; do not reduce to today's BOM.
