select f.*, c.known_sequence as investigation_known_sequence,
  coalesce(i.hardware_key, '__unknown__') as investigation_hardware_key,
  coalesce(i.hardware_version_key, '__unknown__') as investigation_hardware_version_key,
  coalesce(i.identity_resolution, 'missing') as investigation_identity_resolution,
  h.hardware_label, h.hardware_kind
from {{ ref('fact_finding_revision') }} f
join {{ ref('consumer_investigation_context') }} c on f.dataset_id = c.dataset_id and {{ active_at('f','c.known_sequence') }}
left join {{ ref('consumer_identity_as_of') }} i on f.subject_identity_key = i.identity_key
left join {{ ref('sc_dim_hardware') }} h on coalesce(i.hardware_version_key, '__unknown__') = h.hardware_version_key
