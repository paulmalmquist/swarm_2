select b.dataset_id, b.identity_key, c.known_sequence,
  case when count(*) = 1 then max(b.hardware_key) else '__unknown__' end as hardware_key,
  case when count(*) = 1 then max(b.hardware_version_key) else '__unknown__' end as hardware_version_key,
  case when count(*) = 1 then 'resolved' else 'ambiguous' end as identity_resolution
from {{ ref('bridge_hardware_identity') }} b
join {{ ref('consumer_investigation_context') }} c on b.dataset_id = c.dataset_id and {{ active_at('b','c.known_sequence') }}
group by b.dataset_id, b.identity_key, c.known_sequence
