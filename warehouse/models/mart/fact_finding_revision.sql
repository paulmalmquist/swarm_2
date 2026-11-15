{{ fact_storage() }}
select v.source_revision_key as finding_revision_key, {{ source_metadata() }},
  r.identity_key as subject_identity_key, r.hardware_key, r.hardware_version_key, r.identity_resolution,
  {{ cast_safe(jv('v.payload_json', '$.observed_at'), 'timestamp') }} as observed_at,
  {{ date_key(cast_safe(jv('v.payload_json', '$.observed_at'), 'timestamp')) }} as observed_date_key,
  {{ date_key('v.known_from') }} as recorded_date_key,
  {{ jv('v.payload_json', '$.description') }} as finding_description
from {{ ref('int_source_version_windows') }} v
join {{ ref('int_reference_resolution') }} r on v.source_revision_key = r.source_revision_key and r.reference_role = 'subject'
where v.record_kind = 'finding' and not v.is_withdrawn and v.was_current
