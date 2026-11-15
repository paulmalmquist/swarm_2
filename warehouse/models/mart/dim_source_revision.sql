{{ fact_storage() }}
select {{ source_metadata() }}, v.source_system, v.source_type, v.source_native_id,
  v.record_kind, v.is_withdrawn, v.was_current, v.is_current
from {{ ref('int_source_version_windows') }} v
