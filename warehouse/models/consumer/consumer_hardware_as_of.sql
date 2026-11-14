select h.*, c.known_sequence as investigation_known_sequence
from {{ ref('sc_dim_hardware') }} h
join {{ ref('consumer_investigation_context') }} c on h.dataset_id = c.dataset_id and {{ active_at('h','c.known_sequence') }}
where h.hardware_version_key <> '__unknown__'
