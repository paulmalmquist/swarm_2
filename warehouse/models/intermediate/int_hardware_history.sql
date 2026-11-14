with hardware as (
  select *, {{ jv('payload_json', '$.id') }} as hardware_id
  from {{ ref('int_source_version_windows') }}
  where record_kind = 'hardware' and not is_withdrawn and was_current
)
select {{ sk(['v.source_revision_key', "'hardware'"]) }} as hardware_version_key,
  {{ sk(['v.dataset_id','v.hardware_id']) }} as hardware_key,
  {{ source_metadata() }}, v.hardware_id,
  {{ jv('v.payload_json', '$.label') }} as hardware_label,
  {{ jv('v.payload_json', '$.hardware_kind') }} as hardware_kind,
  {{ jv('v.payload_json', '$.genealogy_status') }} as genealogy_status, v.is_current
from hardware v
