{{ fact_storage() }}
select v.source_revision_key as configuration_assertion_key, {{ source_metadata() }},
  r.identity_key as subject_identity_key, r.hardware_key, r.hardware_version_key, r.identity_resolution,
  {{ sk([jv('v.payload_json', '$.dimension')]) }} as configuration_attribute_key,
  {{ jv('v.payload_json', '$.scope') }} as configuration_scope,
  {{ jv('v.payload_json', '$.value') }} as asserted_value,
  {{ date_key('v.known_from') }} as recorded_date_key
from {{ ref('int_source_version_windows') }} v
join {{ ref('int_reference_resolution') }} r on v.source_revision_key = r.source_revision_key and r.reference_role = 'subject'
where v.record_kind = 'configuration' and not v.is_withdrawn and v.was_current
